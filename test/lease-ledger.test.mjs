/**
 * lease-ledger.test.mjs — the store the scope lease sits on.
 *
 * The lease used to live in a Paseo chat room. Paseo removed chat rooms in
 * 0.4.0 (PR #3053, "retired instead of migrated"), so the ledger needs a home
 * that this pack owns. Everything the lease actually decides stays where it
 * was — `resolveLeases()` in policy-core, pure and tested in
 * scope-lease.test.mts. This file tests only the store underneath it.
 *
 * One rule shapes every case below: an answer this store is unsure about must
 * never come back looking empty. "Nobody holds this scope" and "I could not
 * read the board" lead to opposite decisions in the guard, and collapsing them
 * is exactly the silent two-writer bug the lease exists to prevent.
 */
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLedger, defaultLedgerPath } from "../scripts/lease-ledger.mjs";

const AUTHOR = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";
const NOW = 10_000_000;

function tempPath(name = "lease-ledger.jsonl") {
	return join(mkdtempSync(join(tmpdir(), "pteam-ledger-")), name);
}

const body = (action, scope) => `LEASE_V1\nACTION: ${action}\nSCOPE: ${scope}\nTTL_MS: 3600000`;

// --- a ledger that does not exist yet is empty, not broken -------------------
// First claim on a fresh machine. The chat-room version had to create the room
// and retry; a file store has no such step, but it must still tell the two
// cases apart rather than treating "no file" as a fault.
{
	const ledger = createLedger({ path: tempPath() });
	const read = await ledger.read({ since: new Date(0).toISOString(), limit: 100 });
	assert.deepEqual(read.messages, []);
	assert.equal(read.count, 0);
}

// --- append then read gives the three fields arbitration consumes ------------
// resolveLeases() reads exactly `author`, `createdAt` and `body` off each row.
// Anything else this store keeps is for humans; these three are the contract.
{
	const ledger = createLedger({ path: tempPath() });
	const written = await ledger.append({ author: AUTHOR, body: body("claim", "src/auth"), now: NOW });
	assert.equal(written.author, AUTHOR);
	assert.equal(written.createdAt, new Date(NOW).toISOString());
	assert.ok(written.id, "every record is addressable, so a caller can cite the one it wrote");

	const read = await ledger.read({ since: new Date(0).toISOString(), limit: 100 });
	assert.equal(read.count, 1);
	assert.equal(read.messages[0].author, AUTHOR);
	assert.equal(read.messages[0].createdAt, new Date(NOW).toISOString());
	assert.ok(read.messages[0].body.includes("SCOPE: src/auth"));
}

// --- `since` drops what the window cannot cover ------------------------------
// The caller reads back far enough that nothing still live can hide. Records
// older than that are dead weight and must not be returned, or the cap below
// starts firing on history nobody can act on.
{
	const ledger = createLedger({ path: tempPath() });
	await ledger.append({ author: AUTHOR, body: body("claim", "old"), now: NOW - 100_000 });
	await ledger.append({ author: AUTHOR, body: body("claim", "new"), now: NOW - 10 });

	const read = await ledger.read({ since: new Date(NOW - 1_000).toISOString(), limit: 100 });
	assert.equal(read.count, 1);
	assert.ok(read.messages[0].body.includes("SCOPE: new"));
}

// --- the limit keeps the NEWEST records, and says how many it returned -------
// team-lease treats `count >= limit` as "the board may be incomplete" and
// refuses to call it authoritative. That check is only sound if the records it
// did get are the most recent ones: dropping the newest would hide exactly the
// live claim the caller is about to collide with.
{
	const ledger = createLedger({ path: tempPath() });
	for (let i = 0; i < 5; i += 1) {
		await ledger.append({ author: AUTHOR, body: body("claim", `scope-${i}`), now: NOW - (5 - i) * 1_000 });
	}
	const read = await ledger.read({ since: new Date(0).toISOString(), limit: 2 });
	assert.equal(read.count, 2);
	assert.ok(read.messages[0].body.includes("scope-3"));
	assert.ok(read.messages[1].body.includes("scope-4"));
}

// --- chronological order survives the round trip -----------------------------
// resolveLeases sorts by timestamp, but two records written inside the same
// millisecond sort equal — and then the tie is broken by the order the store
// hands them over. Append order is the only total order available, so it has to
// be the one that comes back.
{
	const ledger = createLedger({ path: tempPath() });
	await ledger.append({ author: AUTHOR, body: body("claim", "src/a"), now: NOW });
	await ledger.append({ author: OTHER, body: body("claim", "src/a"), now: NOW });
	const read = await ledger.read({ since: new Date(0).toISOString(), limit: 100 });
	assert.deepEqual(
		read.messages.map((m) => m.author),
		[AUTHOR, OTHER],
		"the first writer stays first, which is what makes the second one the loser",
	);
}

// --- concurrent appends all land ---------------------------------------------
// Several Leads claim at once. The chat room was measured to lose nothing under
// four simultaneous posts; a file store that drops one would turn a losing
// claim into a lease nobody can see.
{
	const ledger = createLedger({ path: tempPath() });
	await Promise.all(
		Array.from({ length: 12 }, (_, i) =>
			ledger.append({ author: AUTHOR, body: body("claim", `scope-${i}`), now: NOW + i }),
		),
	);
	const read = await ledger.read({ since: new Date(0).toISOString(), limit: 1000 });
	assert.equal(read.count, 12, "no record may be lost to a concurrent writer");
	assert.equal(new Set(read.messages.map((m) => m.id)).size, 12, "and none may be duplicated");
}

// --- a damaged line fails loud ------------------------------------------------
// The tempting behaviour is to skip the bad line and carry on. That is the one
// thing this store must not do: a half-written record could be the live claim,
// and skipping it reports the scope as free. Refusing to answer is safe; a
// confident wrong answer is not.
{
	const path = tempPath();
	const ledger = createLedger({ path });
	await ledger.append({ author: AUTHOR, body: body("claim", "src/auth"), now: NOW });
	writeFileSync(path, `${readFileSync(path, "utf8")}{"author":"broken"\n`);

	await assert.rejects(
		() => ledger.read({ since: new Date(0).toISOString(), limit: 100 }),
		(error) => {
			assert.match(String(error.code), /LEDGER/);
			return true;
		},
		"a ledger that cannot be parsed is unreadable, never empty",
	);
}

// --- an unreadable path fails loud too ---------------------------------------
// Same argument, different cause: a permission problem or a path that is a
// directory must not read as "nobody holds anything".
{
	const dir = join(mkdtempSync(join(tmpdir(), "pteam-ledger-")), "as-a-directory.jsonl");
	mkdirSync(dir);
	const ledger = createLedger({ path: dir });
	await assert.rejects(() => ledger.read({ since: new Date(0).toISOString(), limit: 100 }));
}

// --- the default location is overridable, so nothing writes to a real home ---
// Tests and a second checkout on the same host both need their own board; an
// env override is the seam that keeps them from sharing one.
{
	const previous = process.env.PASEO_TEAM_LEASE_LEDGER;
	try {
		process.env.PASEO_TEAM_LEASE_LEDGER = "D:\\somewhere\\else.jsonl";
		assert.equal(defaultLedgerPath(), "D:\\somewhere\\else.jsonl");
		delete process.env.PASEO_TEAM_LEASE_LEDGER;
		assert.match(defaultLedgerPath(), /lease-ledger\.jsonl$/);
	} finally {
		if (previous === undefined) delete process.env.PASEO_TEAM_LEASE_LEDGER;
		else process.env.PASEO_TEAM_LEASE_LEDGER = previous;
	}
}

// --- transaction: read and append under one lock ------------------------------
// Arbitration on read is honest but it is not exclusion: two Leads that both
// read "free" both write a winning claim. A file can do better than the chat
// room could, and this is the primitive that lets it — the decision and the
// write happen with nobody else able to slip between them.
{
	const ledger = createLedger({ path: tempPath() });
	const order = [];
	const slow = async (tag) =>
		ledger.transaction(async (tx) => {
			order.push(`${tag}:in`);
			const before = await tx.read({ since: new Date(0).toISOString(), limit: 100 });
			// Yield: without a lock the other transaction would interleave here,
			// read the same empty board, and both would append.
			await new Promise((resolve) => setTimeout(resolve, 20));
			await tx.append({ author: AUTHOR, body: body("claim", `n-${before.count}`), now: NOW + before.count });
			order.push(`${tag}:out`);
		});

	await Promise.all([slow("a"), slow("b")]);
	assert.deepEqual(
		order.filter((_, i) => i % 2 === 0).length,
		2,
		"both transactions ran",
	);
	// Whoever went first must have finished before the other started.
	assert.ok(
		order.join(",") === "a:in,a:out,b:in,b:out" || order.join(",") === "b:in,b:out,a:in,a:out",
		`transactions must not interleave, got ${order.join(",")}`,
	);
	const read = await ledger.read({ since: new Date(0).toISOString(), limit: 100 });
	assert.equal(read.count, 2);
	assert.notEqual(read.messages[0].body, read.messages[1].body, "the second transaction saw the first one's write");
}

// --- a crashed holder must not wedge the board forever ------------------------
// A lock file outlives the process that made it. Waiting on one for the rest of
// the day turns one crash into a repository nobody can claim in; breaking it
// after it is provably stale keeps the failure to the run that caused it.
{
	const path = tempPath();
	const ledger = createLedger({ path, staleLockMs: 50 });
	writeFileSync(`${path}.lock`, "pid 999999 that no longer exists");
	await new Promise((resolve) => setTimeout(resolve, 60));

	const written = await ledger.transaction(async (tx) =>
		tx.append({ author: AUTHOR, body: body("claim", "src/auth"), now: NOW }),
	);
	assert.ok(written.id, "a stale lock is broken, not waited on forever");
}

// --- a live lock is waited for, then times out --------------------------------
// The other side of the same coin: a lock young enough to be real must be
// respected, and a caller that cannot get in must be told so rather than
// writing anyway.
{
	const path = tempPath();
	const ledger = createLedger({ path, staleLockMs: 60_000, lockTimeoutMs: 100 });
	writeFileSync(`${path}.lock`, "held by a live writer");

	await assert.rejects(
		() => ledger.transaction(async () => "never runs"),
		(error) => {
			assert.match(String(error.code), /LOCK/);
			return true;
		},
		"a board we cannot lock is not a board we may write to",
	);
}

console.log("lease-ledger tests passed");

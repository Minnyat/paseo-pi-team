/**
 * team-lease.test.mjs — the I/O half of the scope lease.
 *
 * The arbitration itself is pure and lives in scope-lease.test.mts; the store
 * underneath is tested in lease-ledger.test.mjs. What is tested here is the
 * seam between them: that a lease event is written as a RECORD (nobody is woken
 * for bookkeeping), that the caller is told whether it actually won rather than
 * merely that the write succeeded, and — the one that matters most — that an
 * unreadable ledger is reported as "unknown" and never as "empty".
 *
 * The ledger stopped being a Paseo chat room when Paseo retired chat rooms in
 * 0.4.0. Two guarantees used to come from that room for free and are now this
 * file's business to prove: only a Lead or Supervisor may write to the board,
 * and every record carries the id of the seat that wrote it.
 */
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	DEFAULT_TTL_MS,
	MAX_TTL_MS,
	claimScope,
	fetchLeases,
	leaseStatus,
	releaseScope,
	renewScope,
} from "../scripts/team-lease.mjs";
import { createLedger } from "../scripts/lease-ledger.mjs";
import { LEASE_MAX_TTL_MS } from "../extensions/paseo-team-core/policy-core.ts";

const SELF = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";
const NOW = 10_000_000;

function record(author, action, scope, at, ttlMs = DEFAULT_TTL_MS) {
	const lines = ["LEASE_V1", `ACTION: ${action}`, `SCOPE: ${scope}`];
	if (action !== "release") lines.push(`TTL_MS: ${ttlMs}`);
	return { id: `m-${at}`, author, createdAt: new Date(at).toISOString(), body: lines.join("\n") };
}

/** An in-memory board that records what it was asked to do. */
function fakeLedger(initial = []) {
	const messages = [...initial];
	const appended = [];
	const reads = [];
	return {
		messages,
		appended,
		reads,
		path: "<memory>",
		async append({ author, body, now }) {
			const written = { id: `m-${messages.length}`, author, createdAt: new Date(now).toISOString(), body };
			appended.push(written);
			messages.push(written);
			return written;
		},
		async transaction(fn) {
			// In-memory: nothing else can reach this board, so the lock is a no-op.
			// The real one is exercised in lease-ledger.test.mjs.
			return fn(this);
		},
		async read({ since, limit }) {
			reads.push({ since, limit });
			const floor = Date.parse(since);
			const windowed = messages.filter((m) => Date.parse(m.createdAt) >= floor);
			const kept = windowed.length > limit ? windowed.slice(windowed.length - limit) : windowed;
			return { path: "<memory>", messages: kept, count: kept.length };
		},
	};
}

/** A board that cannot be read at all — the "we do not know" case. */
const brokenLedger = (code = "LEASE_LEDGER_UNREADABLE") => ({
	path: "<broken>",
	async transaction(fn) {
		return fn(this);
	},
	append: async () => {
		throw Object.assign(new Error("board unwritable"), { code: "LEASE_LEDGER_UNWRITABLE" });
	},
	read: async () => {
		throw Object.assign(new Error("board unreadable"), { code });
	},
});

const opts = (ledger, extra = {}) => ({
	ledger,
	selfAgentId: SELF,
	role: "lead",
	now: NOW,
	...extra,
});

// --- an unreadable ledger is not an empty one --------------------------------
// This is the whole safety argument: "nobody holds it" and "we could not find
// out" must never collapse into the same answer, because the guard treats them
// as opposite.
{
	const result = await fetchLeases(opts(brokenLedger()));
	assert.equal(result.ok, false);
	assert.equal(result.leases, null, "null, never an empty map");
	assert.match(String(result.message), /unreadable/i);
}

// --- claiming a free scope ---------------------------------------------------
{
	const ledger = fakeLedger();
	const result = await claimScope({ scope: "./src/auth/" }, opts(ledger));
	assert.equal(result.ok, true);
	assert.equal(result.scope, "src/auth", "the scope is normalized before it reaches the ledger");
	assert.equal(result.granted, true);
	assert.equal(result.holder.agentId, SELF);
	assert.equal(result.ttlMs, DEFAULT_TTL_MS);
	assert.ok(result.recordId, "the caller can cite the record it wrote");

	assert.equal(ledger.appended.length, 1);
	const [written] = ledger.appended;
	assert.equal(written.author, SELF, "the record carries the seat that claimed — nothing stamps it for us now");
	assert.ok(written.body.includes("LEASE_V1"));
	assert.ok(written.body.includes("ACTION: claim"));
	assert.ok(written.body.includes("SCOPE: src/auth"));
	// A record wakes nobody: no mention head, and no recipient lookup was needed.
	assert.ok(!written.body.startsWith("@"), "a bookkeeping entry must not pull a Lead out of its work");
}

// --- losing the race: refused, not contested ---------------------------------
// Under the chat room every CLAIM was written, including the losing one, because
// a post could not be made conditional on what the board said. The claim now
// decides and writes under one lock, so a scope that is already held is refused
// and NOTHING is appended for it — asking is not the same as taking.
{
	const ledger = fakeLedger([record(OTHER, "claim", "src/auth", NOW - 1000)]);
	const result = await claimScope({ scope: "src/auth/login" }, opts(ledger));
	assert.equal(result.ok, true, "asking about a held scope is not an error");
	assert.equal(result.granted, false, "but it did not win");
	assert.equal(result.holder.agentId, OTHER);
	assert.equal(result.holder.scope, "src/auth", "and the report names the covering scope, not the requested one");
	assert.equal(ledger.appended.length, 0, "a refused claim leaves no record behind");
	assert.equal(result.recordId, null, "and has none to cite");
}

// --- a claim cannot be taken on a board we could not read --------------------
// Fail closed. "We do not know who holds this" and "nobody holds this" lead to
// opposite decisions, and writing a claim on the first one is how two writers
// end up on one tree.
{
	const ledger = brokenLedger();
	const result = await claimScope({ scope: "src/auth" }, opts(ledger));
	assert.equal(result.ok, false, "an unreadable board refuses the claim");
	assert.equal(result.granted, false);
	assert.equal(result.holder, null);
	assert.equal(result.ledgerReadable, false);
	assert.match(String(result.code), /LEDGER/);
}

// --- two Leads claiming at once: exactly one wins ----------------------------
// The measurement that started this: four concurrent claims against the chat
// room ALL succeeded, so the lease was advisory in the one situation it existed
// for. Against a real file board, run for real, the loser must lose.
{
	const path = join(mkdtempSync(join(tmpdir(), "pteam-lease-race-")), "board.jsonl");
	const contenders = [SELF, OTHER, "33333333-3333-4333-8333-333333333333"];
	const results = await Promise.all(
		contenders.map((agent) =>
			claimScope(
				{ scope: "src/auth" },
				{ ledger: createLedger({ path }), selfAgentId: agent, role: "lead", now: NOW },
			),
		),
	);
	const winners = results.filter((r) => r.granted);
	assert.equal(winners.length, 1, `exactly one claim may be granted, got ${winners.length}`);

	// And every loser is told the same story: who actually holds it.
	const holder = winners[0].holder.agentId;
	for (const loser of results.filter((r) => !r.granted)) {
		assert.equal(loser.ok, true);
		assert.equal(loser.holder.agentId, holder, "the losers all name the real holder");
		assert.equal(loser.recordId, null, "and none of them wrote a record");
	}

	const board = await createLedger({ path }).read({ since: new Date(0).toISOString(), limit: 100 });
	assert.equal(board.count, 1, "the board holds one claim, not three");
}

// --- release and renew -------------------------------------------------------
{
	const ledger = fakeLedger([record(SELF, "claim", "src/auth", NOW - 1000)]);
	const released = await releaseScope({ scope: "src/auth" }, opts(ledger));
	assert.equal(released.granted, false, "after releasing, we no longer hold it");
	assert.equal(released.holder, null);
	assert.equal(released.ttlMs, null, "a release carries no TTL");
	assert.ok(ledger.appended[0].body.includes("ACTION: release"));
}
{
	const ledger = fakeLedger([record(SELF, "claim", "src/auth", NOW - 1000, 2000)]);
	const renewed = await renewScope({ scope: "src/auth", ttlMs: 60_000 }, opts(ledger));
	assert.equal(renewed.granted, true);
	assert.ok(renewed.holder.expiresAt > NOW, "the renew pushed the expiry past now");
}

// --- status ------------------------------------------------------------------
{
	const ledger = fakeLedger([
		record(OTHER, "claim", "src/billing", NOW - 3000),
		record(SELF, "claim", "src/auth", NOW - 1000),
	]);
	const status = await leaseStatus({}, opts(ledger));
	assert.equal(status.ok, true);
	assert.equal(status.count, 2);
	assert.deepEqual(status.leases.map((l) => l.scope), ["src/billing", "src/auth"], "oldest claim first");
	assert.match(status.leases[0].expiresAtIso, /^\d{4}-/, "expiry is readable, not a bare epoch");

	const scoped = await leaseStatus({ scope: "src/auth/login" }, opts(ledger));
	assert.equal(scoped.holder.agentId, SELF, "asking about a child scope answers with its covering lease");
}
{
	// An unreadable ledger must be visible in status too, not rendered as "no
	// leases held" — that reading is what would invite a second writer.
	const status = await leaseStatus({}, opts(brokenLedger()));
	assert.equal(status.ok, false);
	assert.equal(status.leases, null);
}

// --- input validation --------------------------------------------------------
{
	const ledger = fakeLedger();
	await assert.rejects(claimScope({ scope: "../outside" }, opts(ledger)), /scope must be/i);
	await assert.rejects(claimScope({ scope: "" }, opts(ledger)), /scope must be/i);
	await assert.rejects(claimScope({}, opts(ledger)), /scope must be/i);
	await assert.rejects(claimScope({ scope: "src", ttlMs: 0 }, opts(ledger)), /ttlMs/);
	await assert.rejects(claimScope({ scope: "src", ttlMs: MAX_TTL_MS + 1 }, opts(ledger)), /ttlMs/);
	await assert.rejects(claimScope({ scope: "src", ttlMs: 1.5 }, opts(ledger)), /ttlMs/);
	assert.equal(ledger.appended.length, 0, "nothing invalid ever reached the board");
}

// --- only a coordinator may write to the board -------------------------------
// This used to be inherited: the board was a chat room and chat was Lead and
// Supervisor only. With the room gone the gate has to be stated here, or a
// Peer would quietly gain the ability to lock scopes.
{
	const ledger = fakeLedger();
	await assert.rejects(claimScope({ scope: "src" }, opts(ledger, { role: "peer" })), /ROLE_NOT_ALLOWED/);
	assert.equal(ledger.appended.length, 0, "a refused role writes nothing");
}

// --- a record with no author is refused, not written anonymously -------------
// resolveLeases drops a row whose author is not a string, and it drops it
// silently — the claim would look like it succeeded and hold nothing.
{
	const ledger = fakeLedger();
	await assert.rejects(
		claimScope({ scope: "src" }, { ledger, role: "lead", now: NOW, selfAgentId: "" }),
		/SELF_UNKNOWN/,
	);
	assert.equal(ledger.appended.length, 0);
}

// --- a board that does not exist yet is not a failure ------------------------
// First claim on a fresh machine. The chat room needed a create-then-retry
// dance for this; a file needs none, but the outcome has to be the same: the
// claim succeeds rather than reporting the board as broken.
{
	const path = join(mkdtempSync(join(tmpdir(), "pteam-lease-")), "lease-ledger.jsonl");
	const result = await claimScope({ scope: "src/auth" }, opts(createLedger({ path })));
	assert.equal(result.granted, true, "the first claim on a fresh machine succeeds");
	assert.equal(result.ledger, path, "and it says which board it wrote to");
}

// --- the read window must not be able to hide a live lease ------------------
// Reading "the last N records" made a live claim invisible once the board moved
// past it: the scope then read as FREE, which is the silent two-writer outcome
// this whole mechanism exists to prevent — and any Lead could force it by
// writing cheap records until a victim's claim fell off the end.
//
// The window is therefore time-based, and the bound is the one fact that makes
// it safe: no lease can outlive LEASE_MAX_TTL_MS, so nothing live can sit
// outside a window that covers it.
{
	const ledger = fakeLedger();
	const result = await fetchLeases(opts(ledger));
	assert.equal(result.ok, true);
	const { since } = ledger.reads[0];
	assert.ok(since, "the ledger is read by time, not by record count");
	const windowMs = NOW - Date.parse(since);
	assert.ok(
		windowMs >= LEASE_MAX_TTL_MS,
		`the window (${windowMs}ms) must cover the longest possible lease (${LEASE_MAX_TTL_MS}ms)`,
	);
}

{
	// If the board comes back at the cap, the read may have been cut short and
	// the board is not known to be complete. Report it as UNREADABLE — a
	// truncated board that reads as "free" is exactly the failure being fixed.
	const full = Array.from({ length: 2000 }, (_, i) => record(OTHER, "claim", `src/s${i}`, NOW - 1000));
	const result = await fetchLeases(opts(fakeLedger(full)));
	assert.equal(result.ok, false, "a possibly-truncated read is not a board");
	assert.equal(result.leases, null);
	assert.match(String(result.code), /TRUNCATED/);
}

console.log("team-lease tests passed");

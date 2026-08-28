/**
 * team-lease.test.mjs — the I/O half of the scope lease.
 *
 * The arbitration itself is pure and lives in scope-lease.test.mts. What is
 * tested here is the part that talks to the room: that a lease event is posted
 * as a RECORD (no mention, so no Lead is woken for bookkeeping), that the caller
 * is told whether it actually won rather than merely that the post succeeded,
 * and — the one that matters most — that an unreadable ledger is reported as
 * "unknown" and never as "empty".
 */
import assert from "node:assert/strict";
import {
	DEFAULT_TTL_MS,
	LEASE_ROOM,
	MAX_TTL_MS,
	claimScope,
	fetchLeases,
	leaseStatus,
	releaseScope,
	renewScope,
} from "../scripts/team-lease.mjs";
import { LEASE_MAX_TTL_MS } from "../extensions/paseo-team-core/policy-core.ts";

const SELF = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";
const NOW = 10_000_000;

function record(author, action, scope, at, ttlMs = DEFAULT_TTL_MS) {
	const lines = ["LEASE_V1", `ACTION: ${action}`, `SCOPE: ${scope}`];
	if (action !== "release") lines.push(`TTL_MS: ${ttlMs}`);
	return { id: `m-${at}`, author, createdAt: new Date(at).toISOString(), body: lines.join("\n") };
}

/** A fake daemon: `chat read` returns the given ledger, `chat post` appends. */
function fakeRoom(initial = []) {
	const messages = [...initial];
	const calls = [];
	return {
		messages,
		calls,
		run: async (args) => {
			calls.push(args);
			if (args[0] === "chat" && args[1] === "read") return messages;
			if (args[0] === "chat" && args[1] === "post") {
				const posted = { id: `m-${messages.length}`, author: SELF, createdAt: new Date(NOW - 1).toISOString(), body: args[3] };
				messages.push(posted);
				return posted;
			}
			throw new Error(`unexpected argv: ${args.join(" ")}`);
		},
	};
}

const opts = (room, extra = {}) => ({
	runPaseo: room.run,
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
	const result = await fetchLeases({
		runPaseo: async () => { throw Object.assign(new Error("daemon down"), { code: "CLI_ERROR" }); },
		selfAgentId: SELF,
		role: "lead",
		now: NOW,
	});
	assert.equal(result.ok, false);
	assert.equal(result.leases, null, "null, never an empty map");
	assert.match(String(result.message), /daemon down/);
}

// --- claiming a free scope ---------------------------------------------------
{
	const room = fakeRoom();
	const result = await claimScope({ scope: "./src/auth/" }, opts(room));
	assert.equal(result.ok, true);
	assert.equal(result.scope, "src/auth", "the scope is normalized before it reaches the ledger");
	assert.equal(result.granted, true);
	assert.equal(result.holder.agentId, SELF);
	assert.equal(result.ttlMs, DEFAULT_TTL_MS);

	const posted = room.calls.find((c) => c[1] === "post");
	assert.ok(posted[3].includes("LEASE_V1"));
	assert.ok(posted[3].includes("ACTION: claim"));
	assert.ok(posted[3].includes("SCOPE: src/auth"));
	assert.equal(posted[2], LEASE_ROOM);
	// A record wakes nobody: no mention head, and no recipient lookup was needed.
	assert.ok(!posted[3].startsWith("@"), "a bookkeeping entry must not pull a Lead out of its work");
	assert.ok(!room.calls.some((c) => c[0] === "ls"));
}

// --- losing the race ---------------------------------------------------------
// The post still succeeds — the room has no compare-and-swap — so the caller
// must be told who actually holds the scope rather than that the write worked.
{
	const room = fakeRoom([record(OTHER, "claim", "src/auth", NOW - 1000)]);
	const result = await claimScope({ scope: "src/auth/login" }, opts(room));
	assert.equal(result.ok, true, "posting an intent is not an error");
	assert.equal(result.granted, false, "but it did not win");
	assert.equal(result.holder.agentId, OTHER);
	assert.equal(result.holder.scope, "src/auth", "and the report names the covering scope, not the requested one");
}

// --- release and renew -------------------------------------------------------
{
	const room = fakeRoom([record(SELF, "claim", "src/auth", NOW - 1000)]);
	const released = await releaseScope({ scope: "src/auth" }, opts(room));
	assert.equal(released.granted, false, "after releasing, we no longer hold it");
	assert.equal(released.holder, null);
	assert.equal(released.ttlMs, null, "a release carries no TTL");
	assert.ok(room.calls.find((c) => c[1] === "post")[3].includes("ACTION: release"));
}
{
	const room = fakeRoom([record(SELF, "claim", "src/auth", NOW - 1000, 2000)]);
	const renewed = await renewScope({ scope: "src/auth", ttlMs: 60_000 }, opts(room));
	assert.equal(renewed.granted, true);
	assert.ok(renewed.holder.expiresAt > NOW, "the renew pushed the expiry past now");
}

// --- status ------------------------------------------------------------------
{
	const room = fakeRoom([
		record(OTHER, "claim", "src/billing", NOW - 3000),
		record(SELF, "claim", "src/auth", NOW - 1000),
	]);
	const status = await leaseStatus({}, opts(room));
	assert.equal(status.ok, true);
	assert.equal(status.count, 2);
	assert.deepEqual(status.leases.map((l) => l.scope), ["src/billing", "src/auth"], "oldest claim first");
	assert.match(status.leases[0].expiresAtIso, /^\d{4}-/, "expiry is readable, not a bare epoch");

	const scoped = await leaseStatus({ scope: "src/auth/login" }, opts(room));
	assert.equal(scoped.holder.agentId, SELF, "asking about a child scope answers with its covering lease");
}
{
	// An unreadable ledger must be visible in status too, not rendered as "no
	// leases held" — that reading is what would invite a second writer.
	const status = await leaseStatus({}, {
		runPaseo: async () => { throw Object.assign(new Error("nope"), { code: "CLI_ERROR" }); },
		selfAgentId: SELF,
		role: "lead",
		now: NOW,
	});
	assert.equal(status.ok, false);
	assert.equal(status.leases, null);
}

// --- input validation --------------------------------------------------------
{
	const room = fakeRoom();
	await assert.rejects(claimScope({ scope: "../outside" }, opts(room)), /scope must be/i);
	await assert.rejects(claimScope({ scope: "" }, opts(room)), /scope must be/i);
	await assert.rejects(claimScope({}, opts(room)), /scope must be/i);
	await assert.rejects(claimScope({ scope: "src", ttlMs: 0 }, opts(room)), /ttlMs/);
	await assert.rejects(claimScope({ scope: "src", ttlMs: MAX_TTL_MS + 1 }, opts(room)), /ttlMs/);
	await assert.rejects(claimScope({ scope: "src", ttlMs: 1.5 }, opts(room)), /ttlMs/);
	assert.equal(room.calls.length, 0, "nothing invalid ever reached the room");
}

// Only Lead and Supervisor hold the chat channel at all, so a Peer cannot post
// a lease either — the check lives in team-chat and is inherited here.
{
	const room = fakeRoom();
	await assert.rejects(claimScope({ scope: "src" }, opts(room, { role: "peer" })), /ROLE_NOT_ALLOWED/);
}

// --- the ledger room does not exist yet -------------------------------------
// First run on a fresh machine: nobody has created the room. Making that the
// operator's problem would mean the very first claim fails with a CLI error and
// the Lead has no idea it was supposed to run a setup step.
{
	let created = 0;
	let postAttempts = 0;
	const messages = [];
	const run = async (args) => {
		if (args[0] === "chat" && args[1] === "create") {
			created += 1;
			return { id: "room-1", name: args[2] };
		}
		if (args[0] === "chat" && args[1] === "post") {
			postAttempts += 1;
			if (created === 0) throw Object.assign(new Error("chat room not found"), { code: "CLI_ERROR" });
			const posted = { id: "m1", author: SELF, createdAt: new Date(NOW - 1).toISOString(), body: args[3] };
			messages.push(posted);
			return posted;
		}
		if (args[0] === "chat" && args[1] === "read") return messages;
		throw new Error(`unexpected argv: ${args.join(" ")}`);
	};

	const result = await claimScope({ scope: "src/auth" }, { runPaseo: run, selfAgentId: SELF, role: "lead", now: NOW });
	assert.equal(result.granted, true, "the first claim on a fresh machine succeeds");
	assert.equal(created, 1, "the ledger room is created on demand");
	assert.equal(postAttempts, 2, "created only after the post showed it was missing — the happy path stays one call");
}

{
	// A create that fails for any other reason must not be retried forever, and
	// the original post error is what the caller needs to see.
	const run = async (args) => {
		if (args[0] === "chat" && args[1] === "create") throw Object.assign(new Error("permission denied"), { code: "CLI_ERROR" });
		if (args[0] === "chat" && args[1] === "post") throw Object.assign(new Error("chat room not found"), { code: "CLI_ERROR" });
		return [];
	};
	await assert.rejects(
		claimScope({ scope: "src/auth" }, { runPaseo: run, selfAgentId: SELF, role: "lead", now: NOW }),
		/room not found/,
		"the caller is told what actually failed, not what the recovery attempt failed at",
	);
}

// --- the read window must not be able to hide a live lease ------------------
// Reading "the last N messages" made a live claim invisible once the room moved
// past it: the scope then read as FREE, which is the silent two-writer outcome
// this whole mechanism exists to prevent — and any Lead could force it by
// posting cheap records until a victim's claim fell off the end.
//
// The window is therefore time-based, and the bound is the one fact that makes
// it safe: no lease can outlive LEASE_MAX_TTL_MS, so nothing live can sit
// outside a window that covers it.
{
	let since = null;
	const run = async (args) => {
		if (args[0] === "chat" && args[1] === "read") {
			const index = args.indexOf("--since");
			since = index >= 0 ? args[index + 1] : null;
			return [];
		}
		throw new Error(`unexpected argv: ${args.join(" ")}`);
	};
	const result = await fetchLeases({ runPaseo: run, selfAgentId: SELF, role: "lead", now: NOW });
	assert.equal(result.ok, true);
	assert.ok(since, "the ledger is read by time, not by message count");
	const windowMs = NOW - Date.parse(since);
	assert.ok(
		windowMs >= LEASE_MAX_TTL_MS,
		`the window (${windowMs}ms) must cover the longest possible lease (${LEASE_MAX_TTL_MS}ms)`,
	);
}

{
	// If the daemon still returns a full page, the read may have been cut short
	// and the board is not known to be complete. Report it as UNREADABLE — a
	// truncated board that reads as "free" is exactly the failure being fixed.
	const full = Array.from({ length: 2000 }, (_, i) => record(OTHER, "claim", `src/s${i}`, NOW - 1000));
	const result = await fetchLeases({
		runPaseo: async () => full,
		selfAgentId: SELF,
		role: "lead",
		now: NOW,
	});
	assert.equal(result.ok, false, "a possibly-truncated read is not a board");
	assert.equal(result.leases, null);
	assert.match(String(result.code), /TRUNCATED/);
}

console.log("team-lease tests passed");

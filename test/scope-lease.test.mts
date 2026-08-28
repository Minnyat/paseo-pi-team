// scope-lease.test.mts — the rule that keeps two Leads off one moving scope.
//
// Until now "one writer per moving scope" held by accident: there was exactly
// one Lead. With several, nothing structural stops two of them from putting a
// writer on the same files, and the failure is a corrupted working tree rather
// than an error message.
//
// The ledger lives in a chat room, which gives a total order by server
// timestamp but NO compare-and-swap (measured: four concurrent posts all
// succeeded). So arbitration happens on read, and this file is where that
// arbitration is pinned — it must be pure, so a lease decision never depends on
// a daemon being reachable at test time.

import assert from "node:assert/strict";
import {
	leaseBlockReason,
	leaseHolderFor,
	normalizeScope,
	parseLeaseRecord,
	resolveLeases,
	scopeConflicts,
	writerScopeFromCreateAgent,
} from "../extensions/paseo-team-core/policy-core.ts";

const LEAD_A = "aaaaaaaa-1111-4111-8111-111111111111";
const LEAD_B = "bbbbbbbb-2222-4222-8222-222222222222";
const HOUR = 3_600_000;

// --- scope normalization -----------------------------------------------------
// Scopes are compared, so their spelling must not decide who wins.
assert.equal(normalizeScope("src/auth"), "src/auth");
assert.equal(normalizeScope("./src/auth"), "src/auth");
assert.equal(normalizeScope("src\\auth"), "src/auth", "a Windows Lead and a POSIX Lead claim the same thing");
assert.equal(normalizeScope("src/auth/"), "src/auth");
assert.equal(normalizeScope("  src//auth  "), "src/auth");
assert.equal(normalizeScope("SRC/Auth"), "SRC/Auth", "case is preserved: paths are case-sensitive where it matters");
assert.equal(normalizeScope(""), null);
assert.equal(normalizeScope("   "), null);
assert.equal(normalizeScope(null), null);
assert.equal(normalizeScope("../escape"), null, "a scope is a repo-relative path, never an escape");
assert.equal(normalizeScope("a".repeat(600)), null, "and it is bounded");

// --- conflict is containment, not equality -----------------------------------
// This is the whole point: claiming `src/auth` must exclude a writer on
// `src/auth/login`, or the invariant means nothing.
assert.equal(scopeConflicts("src/auth", "src/auth"), true);
assert.equal(scopeConflicts("src/auth", "src/auth/login"), true, "a parent scope covers its children");
assert.equal(scopeConflicts("src/auth/login", "src/auth"), true, "and the check is symmetric");
assert.equal(scopeConflicts("src/auth", "src/authz"), false, "a shared prefix is not containment");
assert.equal(scopeConflicts("src/auth", "src/billing"), false);
assert.equal(scopeConflicts(".", "anything/at/all"), true, "the repo root covers everything");
assert.equal(scopeConflicts("src/auth", null), false);

// --- record parsing ----------------------------------------------------------
{
	const body = ["LEASE_V1", "ACTION: claim", "SCOPE: src/auth", "TTL_MS: 3600000"].join("\n");
	const record = parseLeaseRecord(body);
	assert.equal(record.action, "claim");
	assert.equal(record.scope, "src/auth");
	assert.equal(record.ttlMs, HOUR);
}
// Fail closed: a half-record is not a lease. Treating one as a claim would let
// a malformed message hold a scope hostage; treating one as a release would
// hand the scope to a second writer.
assert.equal(parseLeaseRecord("LEASE_V1\nACTION: claim"), null, "no scope");
assert.equal(parseLeaseRecord("LEASE_V1\nACTION: seize\nSCOPE: x\nTTL_MS: 1"), null, "unknown action");
assert.equal(parseLeaseRecord("LEASE_V1\nACTION: claim\nSCOPE: ../x\nTTL_MS: 1"), null, "invalid scope");
assert.equal(parseLeaseRecord("LEASE_V1\nACTION: claim\nSCOPE: x\nTTL_MS: nope"), null);
assert.equal(parseLeaseRecord("LEASE_V1\nACTION: claim\nSCOPE: x\nTTL_MS: 0"), null, "a zero TTL is not a lease");
assert.equal(parseLeaseRecord("no marker"), null);
assert.equal(parseLeaseRecord(null), null);
// A release needs no TTL.
assert.equal(parseLeaseRecord("LEASE_V1\nACTION: release\nSCOPE: src/auth")?.action, "release");

// --- ledger resolution -------------------------------------------------------
function entry(author, action, scope, ts, ttlMs = HOUR) {
	const lines = ["LEASE_V1", `ACTION: ${action}`, `SCOPE: ${scope}`];
	if (action !== "release") lines.push(`TTL_MS: ${ttlMs}`);
	return { author, createdAt: new Date(ts).toISOString(), body: lines.join("\n") };
}

{
	// Two Leads race for the same scope. The room gave them a total order; the
	// earlier claim wins, and the later one is simply not the holder.
	const leases = resolveLeases(
		[entry(LEAD_A, "claim", "src/auth", 1000), entry(LEAD_B, "claim", "src/auth", 1050)],
		{ now: 2000 },
	);
	assert.equal(leaseHolderFor(leases, "src/auth")?.agentId, LEAD_A);
	assert.equal(leaseHolderFor(leases, "src/auth/login")?.agentId, LEAD_A, "the holder covers children too");
	assert.equal(leaseHolderFor(leases, "src/billing"), null);
}

{
	// The holder is the message AUTHOR, stamped by the daemon — never a field
	// inside the body, which the sender controls.
	const forged = entry(LEAD_B, "claim", "src/auth", 1000);
	forged.body += "\nAGENT_ID: " + LEAD_A;
	const leases = resolveLeases([forged], { now: 2000 });
	assert.equal(leaseHolderFor(leases, "src/auth")?.agentId, LEAD_B, "a self-asserted id in the body is ignored");
}

{
	// Expiry frees the scope without anyone acting — a Lead that dies holding a
	// lease must not block the repo forever.
	const leases = resolveLeases([entry(LEAD_A, "claim", "src/auth", 1000, 500)], { now: 1600 });
	assert.equal(leaseHolderFor(leases, "src/auth"), null);
}

{
	// Renew extends from the renew, not from the original claim.
	const leases = resolveLeases(
		[entry(LEAD_A, "claim", "src/auth", 1000, 500), entry(LEAD_A, "renew", "src/auth", 1400, 500)],
		{ now: 1700 },
	);
	assert.equal(leaseHolderFor(leases, "src/auth")?.agentId, LEAD_A);
}

{
	// Only the holder can release. Otherwise any Lead could evict another and
	// the lease would be advice, not a rule.
	const stolen = resolveLeases(
		[entry(LEAD_A, "claim", "src/auth", 1000), entry(LEAD_B, "release", "src/auth", 1100)],
		{ now: 1200 },
	);
	assert.equal(leaseHolderFor(stolen, "src/auth")?.agentId, LEAD_A, "a non-holder release is ignored");

	const released = resolveLeases(
		[entry(LEAD_A, "claim", "src/auth", 1000), entry(LEAD_A, "release", "src/auth", 1100)],
		{ now: 1200 },
	);
	assert.equal(leaseHolderFor(released, "src/auth"), null);
}

{
	// After a release the next claim wins — including one that lost the first race.
	const leases = resolveLeases(
		[
			entry(LEAD_A, "claim", "src/auth", 1000),
			entry(LEAD_B, "claim", "src/auth", 1050),
			entry(LEAD_A, "release", "src/auth", 1100),
			entry(LEAD_B, "claim", "src/auth", 1150),
		],
		{ now: 1200 },
	);
	assert.equal(leaseHolderFor(leases, "src/auth")?.agentId, LEAD_B);
}

{
	// A claim that LOSES must not be recorded as a lease under its own key.
	// Caught live: LEAD-2 claimed `src/auth/login` while LEAD-1 held `src/auth`,
	// lost as expected — and then inherited the scope the moment LEAD-1 released,
	// because the losing claim had been stored under a different map key and was
	// merely being masked on read. A conflict at claim time is a rejection, not a
	// second lease waiting for its turn.
	const entries = [
		entry(LEAD_A, "claim", "src/auth", 1000),
		entry(LEAD_B, "claim", "src/auth/login", 1050),
		entry(LEAD_A, "release", "src/auth", 1100),
	];
	const leases = resolveLeases(entries, { now: 1200 });
	assert.equal(leaseHolderFor(leases, "src/auth/login"), null, "a rejected claim does not become a lease later");
	assert.equal(leaseHolderFor(leases, "src/auth"), null, "and the released parent is genuinely free");
	assert.equal(leases.size, 0);

	// LEAD-B has to ask again, and then it wins.
	const after = resolveLeases([...entries, entry(LEAD_B, "claim", "src/auth/login", 1150)], { now: 1200 });
	assert.equal(leaseHolderFor(after, "src/auth/login")?.agentId, LEAD_B);
}

{
	// The mirror case: a child is held, and a parent claim must lose rather than
	// quietly cover it.
	const leases = resolveLeases(
		[entry(LEAD_A, "claim", "src/auth/login", 1000), entry(LEAD_B, "claim", "src/auth", 1050)],
		{ now: 1200 },
	);
	assert.equal(leases.size, 1);
	assert.equal(leaseHolderFor(leases, "src/auth")?.agentId, LEAD_A, "the narrower, earlier lease keeps the ground");
}

// Junk in the room is not a lease and must not disturb the ones that are.
{
	const leases = resolveLeases(
		[{ author: LEAD_B, createdAt: "nonsense", body: "hello" }, entry(LEAD_A, "claim", "src/auth", 1000)],
		{ now: 1100 },
	);
	assert.equal(leaseHolderFor(leases, "src/auth")?.agentId, LEAD_A);
}
assert.deepEqual([...resolveLeases(null, { now: 0 }).keys()], []);

// --- which create_agent calls even need a lease ------------------------------
// Only a writer takes a scope. Read-only researchers, scouts and reviewers run
// in parallel on the same tree by design, and gating them would make the lease
// a bottleneck instead of a safety rule.
const writeBrief = (scope: string) =>
	[
		"PASEO_TEAM_TASK_V3_BEGIN",
		"TASK_ID: T-1",
		"DISPOSITION: engineer",
		"MODE: write",
		`OWNED_SCOPE: ${scope}`,
		"EDIT_AUTHORITY: allowed",
		"PASEO_TEAM_TASK_V3_END",
	].join("\n");

assert.equal(writerScopeFromCreateAgent({ initialPrompt: writeBrief("src/auth") }), "src/auth");
assert.equal(
	writerScopeFromCreateAgent({ initialPrompt: writeBrief("src/auth").replace("MODE: write", "MODE: read-only") }),
	null,
	"a read-only peer needs no lease",
);
assert.equal(
	writerScopeFromCreateAgent({
		initialPrompt: writeBrief("src/auth").replace("EDIT_AUTHORITY: allowed", "EDIT_AUTHORITY: denied"),
	}),
	null,
	"write mode without edit authority is not a writer",
);
assert.equal(writerScopeFromCreateAgent({ initialPrompt: "just a prompt" }), null);
assert.equal(writerScopeFromCreateAgent({}), null);
assert.equal(writerScopeFromCreateAgent(null), null);
// A write brief with no scope is the dangerous case: it writes *somewhere* and
// says nothing about where. Treat it as claiming the whole repo.
assert.equal(
	writerScopeFromCreateAgent({
		initialPrompt: writeBrief("src/auth").replace("OWNED_SCOPE: src/auth\n", ""),
	}),
	".",
	"an unscoped writer is a repo-wide writer, not an exempt one",
);

// --- the guard ---------------------------------------------------------------
const ledgerWith = (...entries: any[]) => resolveLeases(entries, { now: 2000 });

{
	// The happy path: the Lead holds the scope it is about to staff.
	const reason = leaseBlockReason({
		role: "lead",
		args: { initialPrompt: writeBrief("src/auth") },
		leases: ledgerWith(entry(LEAD_A, "claim", "src/auth", 1000)),
		selfAgentId: LEAD_A,
	});
	assert.equal(reason, null);
}

{
	// Someone else holds it. This is the case the whole PR exists for.
	const reason = leaseBlockReason({
		role: "lead",
		args: { initialPrompt: writeBrief("src/auth/login") },
		leases: ledgerWith(entry(LEAD_A, "claim", "src/auth", 1000)),
		selfAgentId: LEAD_B,
	});
	assert.match(String(reason), /SCOPE_LEASE_HELD/);
	assert.match(String(reason), /aaaaaaaa/, "the report names the holder so the Lead can go ask it");
}

{
	// Nobody holds it: a Lead must claim before it staffs, or the ledger is
	// decoration that only the polite Leads use.
	const reason = leaseBlockReason({
		role: "lead",
		args: { initialPrompt: writeBrief("src/auth") },
		leases: ledgerWith(),
		selfAgentId: LEAD_A,
	});
	assert.match(String(reason), /SCOPE_LEASE_MISSING/);
}

{
	// Read-only creation is never gated.
	assert.equal(
		leaseBlockReason({
			role: "lead",
			args: { initialPrompt: writeBrief("src/auth").replace("MODE: write", "MODE: read-only") },
			leases: ledgerWith(entry(LEAD_B, "claim", "src/auth", 1000)),
			selfAgentId: LEAD_A,
		}),
		null,
	);
}

{
	// The Supervisor's one create_agent is lead recovery, which staffs no scope
	// and is already gated by its own argument guard.
	assert.equal(
		leaseBlockReason({
			role: "supervisor",
			args: { initialPrompt: writeBrief("src/auth") },
			leases: ledgerWith(),
			selfAgentId: LEAD_A,
		}),
		null,
	);
}

{
	// Fail-closed when the ledger could not be read at all. A Lead that cannot
	// create a writer is a visible incident; two writers are not.
	const reason = leaseBlockReason({
		role: "lead",
		args: { initialPrompt: writeBrief("src/auth") },
		leases: null,
		selfAgentId: LEAD_A,
	});
	assert.match(String(reason), /LEASE_UNVERIFIABLE/);
}

{
	// And fail-closed when we do not know who we are: an unknown self can never
	// match a holder, so silently allowing would defeat the check.
	const reason = leaseBlockReason({
		role: "lead",
		args: { initialPrompt: writeBrief("src/auth") },
		leases: ledgerWith(entry(LEAD_A, "claim", "src/auth", 1000)),
		selfAgentId: null,
	});
	assert.match(String(reason), /LEASE_UNVERIFIABLE/);
}

console.log("scope-lease tests passed");

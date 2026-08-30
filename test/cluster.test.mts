/**
 * cluster.test.mts — the workspace axis.
 *
 * `team.domain` said what a seat governs; nothing said WHERE it lives. Every
 * governance read in policy-core is host-global (`buildStateIndex` walks every
 * cwd-slug, team-chat's fan-out runs `paseo ls -g`), so two projects sharing a
 * machine reached into each other. These tests pin the three properties that
 * fix has to hold:
 *
 *   1. separation must be PROVEN — an underivable cluster narrows nothing, so
 *      an unlabelled host behaves exactly as it did before;
 *   2. the gate sits on AUTHORITY, not on observation;
 *   3. a pre-cluster ledger keeps working while it drains.
 *
 * Fixture-driven, like governance.test.mts: no daemon, no clock of its own.
 */

import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
	agentCluster,
	agentClustersById,
	agentOwnership,
	clustersSeparate,
	leaseConflicts,
	leaseHolderFor,
	normalizeCluster,
	parseLeaseRecord,
	resolveLeases,
	selfCluster,
	sendAgentPromptBlockReason,
	supervisorAttribution,
	supervisorSeats,
	supervisorTurnVerdict,
	parseSupervisorBlock,
} from "../extensions/paseo-team-core/policy-core.ts";

const SUP_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const SUP_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const LEAD_A = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const LEAD_B = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const PEER_A = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";

const SHOP = "d:/code/shop";
const BLOG = "d:/code/blog";

/** A throwaway $PASEO_HOME holding the given agent state files. */
function withHome(
	agents: Record<string, Record<string, unknown>>,
	run: (env: { PASEO_HOME: string }) => void,
): void {
	const home = mkdtempSync(join(tmpdir(), "pteam-cluster-"));
	try {
		for (const [id, state] of Object.entries(agents)) {
			// The slug is deliberately arbitrary: the reader indexes by id, so the
			// cluster must come from the state CONTENT, never from the directory.
			const dir = join(home, "agents", `slug-${id.slice(0, 4)}`);
			mkdirSync(dir, { recursive: true });
			writeFileSync(join(dir, `${id}.json`), JSON.stringify({ id, ...state }));
		}
		run({ PASEO_HOME: home });
	} finally {
		rmSync(home, { recursive: true, force: true });
	}
}

// ---------------------------------------------------------------------------
// Grammar
// ---------------------------------------------------------------------------

test("cluster ids normalize to one spelling", () => {
	// A cluster id is frequently a PATH, not a curated label, so the folding has
	// to survive however the platform spelled it. `D:\Code\shop` and
	// `d:/code/shop/` are one directory on Windows, and two clusters there would
	// make a Lead and its own Peer strangers.
	assert.equal(normalizeCluster("D:\\Code\\shop"), SHOP);
	assert.equal(normalizeCluster("d:/code/shop/"), SHOP);
	assert.equal(normalizeCluster("D:/Code//shop"), SHOP);
	assert.equal(normalizeCluster("  wks_abc  "), "wks_abc");
	assert.equal(normalizeCluster(""), null);
	assert.equal(normalizeCluster("   "), null);
	assert.equal(normalizeCluster("/"), null);
	assert.equal(normalizeCluster(42), null);
	assert.equal(normalizeCluster("x".repeat(600)), null);
	// A path legitimately contains spaces and non-ASCII; neither is a reason to
	// give up on scoping a Windows seat under Program Files.
	assert.equal(normalizeCluster("C:/Program Files/app"), "c:/program files/app");
});

test("a control character in a cluster id is refused, not carried onto the wire", () => {
	// The cluster is interpolated into the LEASE_V1 record, which is
	// line-oriented, and it is the NUL-joined half of the live-lease map key.
	// Before this check, a newline split the record so parseLeaseRecord found no
	// TTL_MS and returned null — meaning a Lead's claim registered as "not a
	// lease event at all" while the Lead believed it held the scope.
	for (const evil of ["shop\nACTION: release", "shop\r\nX", "shop\u0000blog", "shop\tX", "shop\u007f"]) {
		assert.equal(normalizeCluster(evil), null, JSON.stringify(evil));
	}
	// Proof of the failure it prevents: the same body with the newline still in
	// place does not parse at all.
	const split = ["LEASE_V1", "ACTION: claim", "SCOPE: src", "CLUSTER: shop\nX", "TTL_MS: 3600000"].join("\n");
	assert.equal(parseLeaseRecord(split), null);
	const clean = ["LEASE_V1", "ACTION: claim", "SCOPE: src", "CLUSTER: shop", "TTL_MS: 3600000"].join("\n");
	assert.equal(parseLeaseRecord(clean)?.cluster, "shop");
});

test("separation must be PROVEN — an unknown cluster never narrows anything", () => {
	assert.equal(clustersSeparate(SHOP, BLOG), true);
	assert.equal(clustersSeparate(SHOP, "D:\\Code\\shop"), false);
	// The load-bearing half. This predicate only ever REMOVES a restriction
	// (drops a contender, permits a prompt, frees a scope), so an unproven
	// answer must not remove one — otherwise a missing state file would quietly
	// switch governance off, which is the failure mode teamTopology() already
	// refuses to allow.
	assert.equal(clustersSeparate(null, BLOG), false);
	assert.equal(clustersSeparate(SHOP, null), false);
	assert.equal(clustersSeparate(null, null), false);
	assert.equal(clustersSeparate(undefined, BLOG), false);
	assert.equal(clustersSeparate("", BLOG), false);
});

test("cluster derivation is label, then workspaceId, then cwd", () => {
	// The label has to win: a reviewer workspace is a LINKED WORKTREE, so it has
	// a different workspaceId AND a different cwd from the Lead that owns it.
	// Only a declared label can keep those two seats in one cluster.
	assert.equal(
		agentCluster({
			labels: { "team.cluster": "Shop" },
			workspaceId: "wks_other",
			cwd: "D:/Code/elsewhere",
		}),
		"shop",
	);
	assert.equal(agentCluster({ workspaceId: "WKS_abc", cwd: "D:/Code/shop" }), "wks_abc");
	assert.equal(agentCluster({ cwd: "D:\\Code\\shop" }), SHOP);
	assert.equal(agentCluster({}), null);
	assert.equal(agentCluster(null), null);
	// An unusable value falls THROUGH to the next source rather than poisoning
	// the answer with null.
	assert.equal(agentCluster({ labels: { "team.cluster": "  " }, cwd: "D:/Code/shop" }), SHOP);
});

test("selfCluster prefers the env override, then own state, then cwd", () => {
	withHome({ [LEAD_A]: { cwd: "D:/Code/shop", provider: "pi-lead/x/y" } }, (env) => {
		assert.equal(
			selfCluster({ ...env, PASEO_TEAM_CLUSTER: "Team-One", PASEO_AGENT_ID: LEAD_A }, "D:/nope"),
			"team-one",
		);
		assert.equal(selfCluster({ ...env, PASEO_AGENT_ID: LEAD_A }, "D:/nope"), SHOP);
		// No id, no state: the process cwd is what an agent started outside a
		// workspace actually has, and it beats returning null (which disables
		// every narrowing below).
		assert.equal(selfCluster(env, "D:\\Code\\blog"), BLOG);
	});
});

test("agentClustersById answers for a batch and maps the unknown to null", () => {
	withHome(
		{
			[LEAD_A]: { cwd: "D:/Code/shop" },
			[LEAD_B]: { labels: { "team.cluster": "blog" }, cwd: "D:/Code/shop" },
		},
		(env) => {
			const found = agentClustersById([LEAD_A, LEAD_B, SUP_A, "not-a-uuid"], env);
			assert.equal(found[LEAD_A], SHOP);
			assert.equal(found[LEAD_B], "blog");
			assert.equal(found[SUP_A], null, "no state file means 'could not tell'");
			assert.equal("not-a-uuid" in found, false);
		},
	);
});

test("agentOwnership carries the cluster alongside the parent and role", () => {
	withHome(
		{
			[PEER_A]: {
				provider: "pi-peer/anthropic/claude-sonnet-5",
				labels: { "paseo.parent-agent-id": LEAD_A },
				workspaceId: "wks_shop",
			},
		},
		(env) => {
			const found = agentOwnership(PEER_A, env);
			assert.ok(found);
			assert.equal(found.cluster, "wks_shop");
			assert.equal(found.parentAgentId, LEAD_A);
		},
	);
});

// ---------------------------------------------------------------------------
// JURISDICTION_OVERLAP was firing across projects
// ---------------------------------------------------------------------------

test("supervisorSeats drops seats from other clusters, keeps the underivable", () => {
	withHome(
		{
			[SUP_A]: { provider: "pi-supervisor/x/y", labels: { "team.domain": "backend" }, cwd: "D:/Code/shop" },
			[SUP_B]: { provider: "pi-supervisor/x/y", labels: { "team.domain": "backend" }, cwd: "D:/Code/blog" },
			[LEAD_A]: { provider: "pi-lead/x/y", cwd: "D:/Code/shop" },
		},
		(env) => {
			assert.equal(supervisorSeats(env).length, 2, "unscoped still sees the whole host");

			// The reported false positive: two unrelated repos both label a seat
			// `backend`, so each became a contender for the other's Lead and
			// JURISDICTION_OVERLAP fired on a cluster with exactly ONE Supervisor.
			const scoped = supervisorSeats(env, { cluster: SHOP });
			assert.deepEqual(
				scoped.map((seat) => seat.agentId),
				[SUP_A],
			);
			assert.equal(scoped[0]?.cluster, SHOP);

			// An unresolvable own cluster must not narrow: same answer as before.
			assert.equal(supervisorSeats(env, { cluster: null }).length, 2);
		},
	);
});

// ---------------------------------------------------------------------------
// A Supervisor from another workspace carries no authority here
// ---------------------------------------------------------------------------

const decision = (domain = "backend", from = SUP_B) =>
	[
		"SUPERVISOR_OBSERVATION",
		"",
		`DOMAIN: ${domain}`,
		`FROM_AGENT_ID: ${from}`,
		"OBSERVATION: the writer and the reviewer share a worktree",
		"SUPERVISOR_DECISION:",
		"DECISION: move the reviewer to its own worktree",
		"REVERSIBILITY: reversible",
	].join("\n");

const observation = (domain = "backend", from = SUP_B) =>
	[
		"SUPERVISOR_OBSERVATION",
		"",
		`DOMAIN: ${domain}`,
		`FROM_AGENT_ID: ${from}`,
		"OBSERVATION: the writer and the reviewer share a worktree",
	].join("\n");

function verdictFor(prompt: string, opts: { topology: "single" | "multi"; leadCluster: string | null }) {
	return withHomeReturning(
		{
			[SUP_B]: { provider: "pi-supervisor/x/y", labels: { "team.domain": "backend" }, cwd: "D:/Code/blog" },
		},
		(env) =>
			supervisorTurnVerdict({
				block: parseSupervisorBlock(prompt),
				leadDomain: "backend",
				supervisors: [],
				attribution: supervisorAttribution(SUP_B, env),
				topology: opts.topology,
				leadCluster: opts.leadCluster,
			}),
	);
}

function withHomeReturning<T>(
	agents: Record<string, Record<string, unknown>>,
	run: (env: { PASEO_HOME: string }) => T,
): T {
	let out!: T;
	withHome(agents, (env) => {
		out = run(env);
	});
	return out;
}

test("a decision from another cluster is refused on BOTH topologies", () => {
	// `single` is the topology that needs this most: it runs no jurisdiction
	// rules at all, so before the cluster gate a Supervisor in another workspace
	// on the same host reached this Lead with SUPERVISOR_DECISION_BINDING —
	// whose directive is "ACT ON IT … needs NO Human round-trip".
	for (const topology of ["single", "multi"] as const) {
		const verdict = verdictFor(decision(), { topology, leadCluster: SHOP });
		assert.ok(verdict);
		assert.equal(verdict.ok, false, topology);
		assert.equal(verdict.code, "CLUSTER_MISMATCH", topology);
		assert.equal(verdict.severity, "refuse", topology);
		assert.match(verdict.reason, /different workspace/);
	}
});

test("an observation from another cluster only warns — observing across projects is allowed", () => {
	// The whole asymmetry of this change: a Supervisor may WATCH several
	// workspaces (that is its job), but its authority stops at its own cluster.
	const verdict = verdictFor(observation(), { topology: "single", leadCluster: SHOP });
	assert.ok(verdict);
	assert.equal(verdict.code, "CLUSTER_MISMATCH");
	assert.equal(verdict.severity, "warn");
});

test("under multi, a cross-cluster decision says CLUSTER_MISMATCH, not OVERLAP", () => {
	// Regression guard for an ordering bug that only appears once the seat list
	// is REAL. Deciding cluster after the jurisdiction branch made it
	// unreachable under `multi`: supervisorSeats() filters the foreign sender
	// out, so `covering` holds only the legitimate in-cluster Supervisor while
	// `contenders` keeps it (the sender's id matches nothing) — and the Lead was
	// told to escalate a jurisdiction conflict that does not exist instead of
	// being told the message came from another workspace. Passing `supervisors:
	// []` here, as the first version of this suite did, hides it completely.
	const verdict = withHomeReturning(
		{
			[SUP_B]: { provider: "pi-supervisor/x/y", labels: { "team.domain": "backend" }, cwd: "D:/Code/blog" },
		},
		(env) =>
			supervisorTurnVerdict({
				block: parseSupervisorBlock(decision()),
				leadDomain: "backend",
				// The Lead's OWN cluster has a Supervisor, as any real one does.
				supervisors: [{ agentId: SUP_A, domain: "backend", cluster: SHOP }],
				attribution: supervisorAttribution(SUP_B, env),
				topology: "multi",
				leadCluster: SHOP,
			}),
	);
	assert.ok(verdict);
	assert.equal(verdict.code, "CLUSTER_MISMATCH");
	assert.notEqual(verdict.code, "JURISDICTION_OVERLAP");
	assert.equal(verdict.severity, "refuse");
});

test("same cluster, and unknown cluster, leave the verdict exactly as it was", () => {
	const same = verdictFor(decision(), { topology: "single", leadCluster: BLOG });
	assert.ok(same);
	assert.equal(same.ok, true, "the sender's own cluster is BLOG, so nothing is crossed");
	assert.equal(same.code, "SUPERVISOR_DECISION_BINDING");

	// A Lead whose own cluster cannot be derived must keep today's behaviour
	// rather than start refusing every supervisor message.
	const unknown = verdictFor(decision(), { topology: "single", leadCluster: null });
	assert.ok(unknown);
	assert.equal(unknown.ok, true);
	assert.equal(unknown.code, "SUPERVISOR_DECISION_BINDING");
});

// ---------------------------------------------------------------------------
// send_agent_prompt: the coordinator-to-coordinator hole
// ---------------------------------------------------------------------------

const coordinator = (id: string, cluster: string | null, role: "lead" | "supervisor" = "lead") => ({
	agentId: id,
	parentAgentId: null,
	provider: `pi-${role}/x/y`,
	role,
	domain: "backend",
	cluster,
});

test("a Lead cannot prompt another cluster's coordinator, on either topology", () => {
	for (const topology of ["single", "multi"] as const) {
		const reason = sendAgentPromptBlockReason({
			role: "lead",
			selfAgentId: LEAD_A,
			targetId: LEAD_B,
			target: coordinator(LEAD_B, BLOG),
			topology,
			cluster: SHOP,
		});
		assert.match(String(reason), /PROMPT_TARGET_OUT_OF_CLUSTER/, topology);
	}
});

test("coordinator traffic inside one cluster is still allowed — that is the point of multi", () => {
	for (const topology of ["single", "multi"] as const) {
		assert.equal(
			sendAgentPromptBlockReason({
				role: "lead",
				selfAgentId: LEAD_A,
				targetId: LEAD_B,
				target: coordinator(LEAD_B, SHOP),
				topology,
				cluster: SHOP,
			}),
			null,
			topology,
		);
	}
});

test("a seat's OWN subagent is reachable even from another cluster", () => {
	// Regression guard for the reviewer flow. leadCreateWorkspaceBlockReason
	// MANDATES that a reviewer workspace is a linked worktree, which gives that
	// Peer a different cwd and workspaceId from its Lead by construction. If the
	// cluster test ran before the parentage test, the pack would block the very
	// flow it requires.
	const ownPeerElsewhere = {
		agentId: PEER_A,
		parentAgentId: LEAD_A,
		provider: "pi-peer/x/y",
		role: "peer" as const,
		domain: null,
		cluster: BLOG,
	};
	for (const topology of ["single", "multi"] as const) {
		assert.equal(
			sendAgentPromptBlockReason({
				role: "lead",
				selfAgentId: LEAD_A,
				targetId: PEER_A,
				target: ownPeerElsewhere,
				topology,
				cluster: SHOP,
			}),
			null,
			topology,
		);
	}
});

test("an undecidable cluster leaves the prompt guard exactly as it was", () => {
	// Under `single` nothing else blocks a Lead→Lead prompt, so an underivable
	// cluster must not invent a refusal.
	assert.equal(
		sendAgentPromptBlockReason({
			role: "lead",
			selfAgentId: LEAD_A,
			targetId: LEAD_B,
			target: coordinator(LEAD_B, null),
			topology: "single",
			cluster: SHOP,
		}),
		null,
	);
	// And a caller that never passes a cluster at all keeps the old answer.
	assert.equal(
		sendAgentPromptBlockReason({
			role: "lead",
			selfAgentId: LEAD_A,
			targetId: LEAD_B,
			target: coordinator(LEAD_B, BLOG),
			topology: "multi",
		}),
		null,
	);
});

test("the more specific refusals still win where they applied before", () => {
	// A Supervisor must hear PROMPT_TARGET_IS_PEER, not a cluster message: the
	// peer rule is about the role boundary and is the more actionable answer.
	const peerElsewhere = {
		agentId: PEER_A,
		parentAgentId: LEAD_B,
		provider: "pi-peer/x/y",
		role: "peer" as const,
		domain: null,
		cluster: BLOG,
	};
	assert.match(
		String(
			sendAgentPromptBlockReason({
				role: "supervisor",
				selfAgentId: SUP_A,
				targetId: PEER_A,
				target: peerElsewhere,
				topology: "single",
				cluster: SHOP,
			}),
		),
		/PROMPT_TARGET_IS_PEER/,
	);
	// Under multi a foreign Peer is still NOT_OWNED, unchanged by the cluster axis.
	assert.match(
		String(
			sendAgentPromptBlockReason({
				role: "lead",
				selfAgentId: LEAD_A,
				targetId: PEER_A,
				target: peerElsewhere,
				topology: "multi",
				cluster: SHOP,
			}),
		),
		/PROMPT_TARGET_NOT_OWNED/,
	);
	// Under `single` there is no ownership rule, so the same call lands on the
	// cluster refusal instead — and it must describe a PEER rather than claim
	// this was coordinator-to-coordinator traffic.
	const single = String(
		sendAgentPromptBlockReason({
			role: "lead",
			selfAgentId: LEAD_A,
			targetId: PEER_A,
			target: peerElsewhere,
			topology: "single",
			cluster: SHOP,
		}),
	);
	assert.match(single, /PROMPT_TARGET_OUT_OF_CLUSTER/);
	assert.match(single, /is a peer in cluster/);
	assert.doesNotMatch(single, /Coordinator-to-coordinator/);
});

// ---------------------------------------------------------------------------
// The lease ledger is ONE room, and a scope is a repo-relative path
// ---------------------------------------------------------------------------

const NOW = Date.parse("2026-08-30T12:00:00.000Z");
const TTL = 3_600_000;

function leaseRow(
	author: string,
	action: "claim" | "renew" | "release",
	scope: string,
	at: number,
	cluster: string | null,
) {
	const lines = ["LEASE_V1", `ACTION: ${action}`, `SCOPE: ${scope}`];
	if (cluster) lines.push(`CLUSTER: ${cluster}`);
	if (action !== "release") lines.push(`TTL_MS: ${TTL}`);
	return { author, createdAt: new Date(at).toISOString(), body: lines.join("\n") };
}

test("a LEASE_V1 record without CLUSTER parses, with a null cluster", () => {
	const old = parseLeaseRecord(leaseRow(LEAD_A, "claim", "src", NOW, null).body);
	assert.ok(old);
	assert.equal(old.cluster, null);
	const fresh = parseLeaseRecord(leaseRow(LEAD_A, "claim", "src", NOW, SHOP).body);
	assert.equal(fresh?.cluster, SHOP);
});

test("an unqualified lease still collides with everything", () => {
	// Backward compatibility IS the safety property here: a record written
	// before the field existed must keep its old, coarser meaning while the room
	// drains, or upgrading the pack would silently free live leases.
	assert.equal(leaseConflicts({ scope: "src", cluster: null }, { scope: "src", cluster: SHOP }), true);
	assert.equal(leaseConflicts({ scope: "src", cluster: SHOP }, { scope: "src", cluster: BLOG }), false);
	assert.equal(leaseConflicts({ scope: "src", cluster: SHOP }, { scope: "src/api", cluster: SHOP }), true);
	assert.equal(leaseConflicts({ scope: "src", cluster: SHOP }, { scope: "lib", cluster: SHOP }), false);
	// `.` is the whole repo — inside its own cluster only. Before the axis it
	// locked every checkout on the machine.
	assert.equal(leaseConflicts({ scope: ".", cluster: SHOP }, { scope: "anything", cluster: SHOP }), true);
	assert.equal(leaseConflicts({ scope: ".", cluster: SHOP }, { scope: "anything", cluster: BLOG }), false);
});

test("two projects hold the same repo-relative scope at the same time", () => {
	const leases = resolveLeases(
		[
			leaseRow(LEAD_A, "claim", "src/index.ts", NOW - 1000, SHOP),
			leaseRow(LEAD_B, "claim", "src/index.ts", NOW - 500, BLOG),
		],
		{ now: NOW },
	);
	assert.equal(leases.size, 2, "one ledger, two projects, no collision");
	assert.equal(leaseHolderFor(leases, "src/index.ts", SHOP)?.agentId, LEAD_A);
	assert.equal(leaseHolderFor(leases, "src/index.ts", BLOG)?.agentId, LEAD_B);
});

test("a claim still loses to a covering claim inside its own cluster", () => {
	const leases = resolveLeases(
		[
			leaseRow(LEAD_A, "claim", "src/auth", NOW - 1000, SHOP),
			leaseRow(LEAD_B, "claim", "src/auth/login", NOW - 500, SHOP),
		],
		{ now: NOW },
	);
	assert.equal(leases.size, 1, "the losing claim is not recorded");
	assert.equal(leaseHolderFor(leases, "src/auth/login", SHOP)?.agentId, LEAD_A);
});

test("a lease claimed before the CLUSTER field can still be released after it", () => {
	// The rolling-upgrade case, and the bug this test was written to catch: with
	// release matched on an exact cluster+scope key, a claim written by the old
	// pack (cluster null) could never be released by the new one (cluster set),
	// and the scope stayed locked until its TTL expired.
	const released = resolveLeases(
		[
			leaseRow(LEAD_A, "claim", "src/auth", NOW - 2000, null),
			leaseRow(LEAD_A, "release", "src/auth", NOW - 1000, SHOP),
		],
		{ now: NOW },
	);
	assert.equal(released.size, 0);

	// ...and the reverse direction, for a host mid-upgrade the other way round.
	const releasedBack = resolveLeases(
		[
			leaseRow(LEAD_A, "claim", "src/auth", NOW - 2000, SHOP),
			leaseRow(LEAD_A, "release", "src/auth", NOW - 1000, null),
		],
		{ now: NOW },
	);
	assert.equal(releasedBack.size, 0);
});

test("nobody releases or renews another cluster's lease", () => {
	const stillHeld = resolveLeases(
		[
			leaseRow(LEAD_A, "claim", "src/auth", NOW - 2000, SHOP),
			// Same agent id, different project. Releasing here would evict a lease
			// in a repo this record says nothing about.
			leaseRow(LEAD_A, "release", "src/auth", NOW - 1000, BLOG),
		],
		{ now: NOW },
	);
	assert.equal(stillHeld.size, 1);
	assert.equal(leaseHolderFor(stillHeld, "src/auth", SHOP)?.agentId, LEAD_A);

	// A renew from another cluster must not extend it either.
	const renewed = resolveLeases(
		[
			leaseRow(LEAD_A, "claim", "src/auth", NOW - 2000, SHOP),
			leaseRow(LEAD_A, "renew", "src/auth", NOW - 1000, BLOG),
		],
		{ now: NOW },
	);
	assert.equal(
		leaseHolderFor(renewed, "src/auth", SHOP)?.expiresAt,
		NOW - 2000 + TTL,
		"the expiry is still the one the original claim set",
	);
});

test("leaseHolderFor with no cluster keeps the old, stricter answer", () => {
	const leases = resolveLeases([leaseRow(LEAD_A, "claim", "src", NOW - 1000, SHOP)], { now: NOW });
	// A caller that has not been taught about clusters must not accidentally get
	// a LAXER answer than it had before.
	assert.equal(leaseHolderFor(leases, "src/api")?.agentId, LEAD_A);
	assert.equal(leaseHolderFor(leases, "src/api", BLOG), null);
});

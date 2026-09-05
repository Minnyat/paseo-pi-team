import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildGraph, collectGraph, describeClusterMismatches, inferFamily, inferRole, inferRoleProvider, inferSeat, normalizePermits, parsePeerMessage } from "../cli/lib/graph.mjs";
import * as cache from "../cli/lib/graph-cache.mjs";

// --- role inference --------------------------------------------------------
// `ls` reports "pi-lead/Owner/model" and `inspect` reports "pi-lead"; both
// must land on the same role or the graph would colour the same agent twice.
assert.equal(inferRole("pi-supervisor/Minnyat/deepseek-v4-flash"), "supervisor");
assert.equal(inferRole("pi-lead"), "lead");
assert.equal(inferRole("PI-PEER/x"), "peer");
assert.equal(inferRole("claude"), null, "an unknown provider is unknown, not bucketed into a role");
// Mixed fleet: the same three roles also run on Claude providers, and the
// family travels with the node so the graph can show which runtime executed it.
assert.equal(inferRole("claude-peer"), "peer");
assert.equal(inferRole("claude-supervisor/claude-opus-5"), "supervisor");
assert.equal(inferFamily("claude-lead/claude-opus-5"), "claude");
assert.equal(inferFamily("pi-lead/Minnyat/deepseek-v4-flash"), "pi");
assert.equal(inferFamily("claude"), null);
assert.deepEqual(inferRoleProvider("claude-peer/claude-fable-5"), { family: "claude", role: "peer", seat: null });
assert.equal(inferRoleProvider("codex-peer"), null);
assert.equal(inferRole(undefined), null);

// --- seat variants resolve to their BASE role ------------------------------
// A custom seat ("claude-peer-researcher") is a peer with extra capabilities,
// not an unknown provider: the graph must colour it as the peer it is, and the
// same split has to hold in policy-core's parseRoleProvider, where it decides
// whether a provider-name gate applies at all.
assert.deepEqual(inferRoleProvider("claude-peer-researcher"), { family: "claude", role: "peer", seat: "researcher" });
assert.deepEqual(inferRoleProvider("pi-lead-audit/Minnyat/deepseek-v4-flash"), { family: "pi", role: "lead", seat: "audit" });
assert.equal(inferRole("CLAUDE-SUPERVISOR-AUDIT"), "supervisor", "case-folded seat names still resolve");
assert.equal(inferSeat("claude-peer-researcher"), "researcher");
assert.equal(inferSeat("claude-peer"), null, "a base provider has no seat");
// A tail the seat vocabulary would refuse must not be read as a seat: an
// unparseable provider stays unknown rather than silently becoming a peer.
assert.equal(inferRoleProvider("claude-peer-"), null);
assert.equal(inferRoleProvider("claude-peer-9lives"), null, "a seat id may not start with a digit");
assert.equal(inferRoleProvider("claude-peerresearcher"), null);

// The two implementations of this split must agree, or a seat could be shown
// as one role by the UI and treated as another by the rule core.
{
	const { parseRoleProvider } = await import("../extensions/paseo-team-core/policy-core.js");
	for (const name of [
		"claude-peer",
		"claude-peer-researcher",
		"pi-lead-audit",
		"claude-supervisor-audit",
		"claude-peer-",
		"claude-peer-9lives",
		"codex-peer",
	]) {
		assert.deepEqual(
			parseRoleProvider(name),
			inferRoleProvider(name),
			`policy-core and graph disagree on "${name}"`,
		);
	}
}

// --- PEER_MESSAGE_V1 parsing ----------------------------------------------
{
	const body = [
		"Some preamble the Lead also received.",
		"PEER_MESSAGE_V1",
		"KIND: blocked",
		"CORRELATION_ID: peer-123-abc",
		"TASK_ID: T-42",
		"FROM_AGENT_ID: 11111111-2222-3333-4444-555555555555",
		"",
		"the actual question",
	].join("\n");
	const parsed = parsePeerMessage(body);
	assert.equal(parsed.kind, "blocked");
	assert.equal(parsed.taskId, "T-42");
	assert.equal(parsed.correlationId, "peer-123-abc");
	assert.equal(parsed.fromAgentId, "11111111-2222-3333-4444-555555555555");
}
// Fail closed: a kind outside MESSAGE_KINDS, or a missing field, must not
// become a half-populated edge on the graph.
assert.equal(parsePeerMessage("PEER_MESSAGE_V1\nKIND: gossip\nCORRELATION_ID: c\nTASK_ID: t\nFROM_AGENT_ID: a"), null);
assert.equal(parsePeerMessage("PEER_MESSAGE_V1\nKIND: progress\nTASK_ID: t\nFROM_AGENT_ID: a"), null);
assert.equal(parsePeerMessage("no marker here"), null);
assert.equal(parsePeerMessage(null), null);

// --- permit normalization --------------------------------------------------
{
	const { permits, unclassified } = normalizePermits([
		{ agentId: "aaaa1111-0000-0000-0000-000000000000", requestId: "req-1", tool: "bash" },
		{ AgentId: "bbbb2222-0000-0000-0000-000000000000", RequestId: "req-2" },
		{ somethingElse: true },
		"not-an-object",
	]);
	assert.equal(permits.length, 2, "both casings are recognized");
	assert.equal(permits[0].tool, "bash");
	assert.equal(permits[1].tool, null);
	// A row we cannot name is kept, not dropped: someone is blocked on it.
	assert.equal(unclassified.length, 2);
}

// --- buildGraph ------------------------------------------------------------
const AGENTS = [
	{ id: "sup", shortId: "sup", name: "supervisor", provider: "pi-supervisor/o/m", status: "idle", cwd: "/w" },
	{ id: "lead", shortId: "lead", name: "lead", provider: "pi-lead/o/m", status: "running", cwd: "/w" },
	{ id: "peer", shortId: "peer", name: "peer", provider: "pi-peer/o/m", status: "running", cwd: "/w" },
	{ id: "lost", shortId: "lost", name: "orphan", provider: "pi-peer/o/m", status: "idle", cwd: "/w" },
];

{
	const graph = buildGraph({
		agents: AGENTS,
		parents: { sup: null, lead: "sup", peer: "lead", lost: "archived-parent" },
		permits: [{ agentId: "peer", requestId: "r1", tool: "write" }],
		messages: [
			{ from: "peer", to: "lead", kind: "blocked", correlationId: "c1", confidence: "confirmed" },
			{ from: "peer", to: "lead", kind: "blocked", correlationId: "c1", confidence: "confirmed" },
			{ from: "lead", to: "peer", kind: null, correlationId: "c2" },
		],
		now: Date.parse("2026-08-21T00:00:00.000Z"),
	});

	assert.equal(graph.counts.agents, 4);
	assert.deepEqual(graph.counts.byRole, { supervisor: 1, lead: 1, peer: 2 });

	const spawn = graph.edges.filter((edge) => edge.type === "spawn");
	assert.deepEqual(
		spawn.map((edge) => `${edge.from}->${edge.to}`),
		["sup->lead", "lead->peer"],
		"a parent that is not in the listing produces no edge",
	);
	assert.ok(spawn.every((edge) => edge.confidence === "confirmed"));

	const messages = graph.edges.filter((edge) => edge.type === "message");
	assert.equal(messages.length, 2, "a repeated correlationId draws once");
	assert.equal(messages[1].confidence, "suspected", "an unlabelled message edge is a guess by default");

	// The orphan must be flagged, not silently promoted to a root: flattening
	// the tree would misrepresent who is answering to whom.
	const lost = graph.nodes.find((node) => node.id === "lost");
	assert.equal(lost.orphan, true);
	assert.ok(graph.degraded.some((fault) => fault.reason === "PARENT_NOT_LISTED" && fault.agentId === "lost"));

	assert.equal(graph.nodes.find((node) => node.id === "peer").pendingPermissions, 1);
	assert.equal(graph.nodes.find((node) => node.id === "lead").pendingPermissions, 0);
	assert.equal(graph.counts.pendingPermissions, 1);
	assert.equal(graph.collectedAt, "2026-08-21T00:00:00.000Z");
}

{
	// An agent nobody has inspected yet is "parent unknown", which is not the
	// same claim as "has no parent".
	const graph = buildGraph({ agents: AGENTS, parents: {}, now: 0 });
	assert.equal(graph.edges.length, 0);
	assert.ok(graph.nodes.every((node) => node.parentKnown === false));
}

{
	const graph = buildGraph({ agents: AGENTS, parents: {}, permits: [{ nothing: true }], now: 0 });
	assert.ok(graph.degraded.some((fault) => fault.reason === "PERMIT_SHAPE_UNRECOGNIZED"));
	assert.equal(graph.counts.pendingPermissions, 1, "an unclassified permit still counts as pending");
}

// --- parent cache ----------------------------------------------------------
{
	const dir = mkdtempSync(join(tmpdir(), "pst-graph-"));
	const path = join(dir, "graph-cache.json");
	try {
		assert.deepEqual(cache.readParentCache(path).parents, {}, "a missing cache reads as empty");

		const store = { version: cache.CACHE_VERSION, parents: {} };
		cache.rememberParent(store, "a", "root", 1000);
		cache.rememberParent(store, "b", null, 500);
		cache.writeParentCache(store, path);
		assert.deepEqual(cache.readParentCache(path).parents, {
			a: { parentId: "root", checkedAt: 1000 },
			b: { parentId: null, checkedAt: 500 },
		});

		assert.equal(cache.isFresh(store.parents.a, { now: 1000 + 60_000, ttlMs: 15 * 60_000 }), true);
		assert.equal(cache.isFresh(store.parents.a, { now: 1000 + 16 * 60_000, ttlMs: 15 * 60_000 }), false);
		// Oldest first, so a cold cache fills deterministically over polls, and
		// a never-seen id ("c") outranks any entry that was checked once.
		assert.deepEqual(cache.staleIds(["a", "b", "c"], store, { now: 10 ** 9, ttlMs: 1 }), ["c", "b", "a"]);

		cache.pruneCache(store, ["a"]);
		assert.deepEqual(Object.keys(store.parents), ["a"], "ids the daemon stopped listing are dropped");

		// Derived data: a corrupt cache is discarded rather than half-read.
		cache.writeParentCache({ parents: { x: { parentId: 5, checkedAt: "soon" } } }, path);
		assert.deepEqual(cache.readParentCache(path).parents, {});
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

// --- collectGraph ----------------------------------------------------------
function fakeRunner(overrides = {}) {
	const calls = [];
	return {
		calls,
		run: async (args) => {
			calls.push(args.join(" "));
			if (args[0] === "ls") return overrides.ls ?? AGENTS;
			if (args[0] === "permit") return overrides.permits ?? [];
			if (args[0] === "inspect") {
				if (overrides.inspectFails) throw Object.assign(new Error("cold agent"), { code: "TIMEOUT" });
				return { Id: args[1], ParentAgentId: args[1] === "lead" ? "sup" : args[1] === "peer" ? "lead" : null };
			}
			throw new Error(`unexpected argv: ${args.join(" ")}`);
		},
	};
}

{
	const fake = fakeRunner();
	const store = { version: cache.CACHE_VERSION, parents: {} };
	const result = await collectGraph({
		runPaseoJson: fake.run,
		cache: store,
		persistCache: false,
		maxInspect: 2,
		now: 1000,
	});
	assert.equal(result.ok, true);
	assert.equal(result.inspectSpent, 2, "the inspect budget is respected");
	assert.equal(result.pendingParents, 2, "what the budget could not cover is reported, not hidden");
	assert.equal(fake.calls.filter((call) => call.startsWith("inspect")).length, 2);
	assert.ok(fake.calls.includes("ls -g"));
	assert.ok(fake.calls.includes("permit ls"));
}

{
	// Second pass with a warm cache: no inspect is spent, and the tree is
	// complete. This is the property that makes a 5s poll affordable.
	const fake = fakeRunner();
	const store = { version: cache.CACHE_VERSION, parents: {} };
	await collectGraph({ runPaseoJson: fake.run, cache: store, persistCache: false, maxInspect: 10, now: 1000 });
	const warm = await collectGraph({ runPaseoJson: fake.run, cache: store, persistCache: false, maxInspect: 10, now: 2000 });
	assert.equal(warm.inspectSpent, 0);
	assert.equal(warm.pendingParents, 0);
	assert.equal(warm.edges.filter((edge) => edge.type === "spawn").length, 2);
}

{
	// One cold agent must degrade its own entry, not the whole snapshot.
	const fake = fakeRunner({ inspectFails: true });
	const result = await collectGraph({
		runPaseoJson: fake.run,
		cache: { version: cache.CACHE_VERSION, parents: {} },
		persistCache: false,
		maxInspect: 1,
		now: 1000,
	});
	assert.equal(result.ok, true);
	assert.equal(result.counts.agents, 4, "the graph still renders");
	assert.ok(result.degraded.some((fault) => fault.reason === "TIMEOUT"));
}

{
	// No agent list means no graph — but the answer is still a document that
	// explains itself, because the WebUI has to render something.
	const result = await collectGraph({
		runPaseoJson: async (args) => {
			if (args[0] === "ls") throw Object.assign(new Error("daemon down"), { code: "DAEMON_NOT_RUNNING" });
			return [];
		},
		cache: { version: cache.CACHE_VERSION, parents: {} },
		persistCache: false,
		now: 0,
	});
	assert.equal(result.ok, false);
	assert.equal(result.nodes.length, 0);
	assert.equal(result.degraded[0].reason, "DAEMON_NOT_RUNNING");
}

{
	// A failing permit list must not take the agent list down with it.
	const result = await collectGraph({
		runPaseoJson: async (args) => {
			if (args[0] === "permit") throw Object.assign(new Error("nope"), { code: "CLI_ERROR" });
			if (args[0] === "ls") return AGENTS;
			return { Id: args[1], ParentAgentId: null };
		},
		cache: { version: cache.CACHE_VERSION, parents: {} },
		persistCache: false,
		maxInspect: 0,
		now: 0,
	});
	assert.equal(result.ok, true);
	assert.equal(result.counts.agents, 4);
	assert.ok(result.degraded.some((fault) => fault.reason === "CLI_ERROR"));
}

// --- agent state: domain, model, and free spawn edges ----------------------
// Paseo's own per-agent state files carry the parent link and the resolved
// model, so the graph can stop paying ~3s per `paseo inspect` for a tree it
// can read off disk. See cli/lib/agent-state.mjs.
{
	const graph = buildGraph({
		agents: AGENTS,
		// No inspect-derived parents at all: everything comes from state.
		parents: {},
		states: {
			sup: { agentId: "sup", domain: "security", parentAgentId: null, model: "o/m", modelDrift: false, sessionId: "s-sup" },
			lead: { agentId: "lead", domain: "payments", parentAgentId: "sup", model: "o/m", modelDrift: false, sessionId: "s-lead" },
			peer: { agentId: "peer", domain: "payments", parentAgentId: "lead", model: "o/other", modelDrift: true, sessionId: "s-peer" },
		},
		now: 0,
	});
	const by = Object.fromEntries(graph.nodes.map((n) => [n.id, n]));
	assert.equal(by.lead.parentId, "sup", "the spawn edge comes from the state file");
	assert.equal(by.lead.parentSource, "state");
	assert.equal(by.lead.domain, "payments");
	assert.equal(by.peer.modelDrift, true, "a config/runtime model disagreement stays visible");
	assert.equal(by.peer.sessionId, "s-peer", "the pi session id rides along for fork/handoff");
	assert.equal(by.lost.parentId, null, "an agent with no state and no inspect has an unknown parent");
	assert.equal(by.lost.parentKnown, false);
	assert.equal(by.lost.domain, null);
	assert.equal(graph.edges.filter((e) => e.type === "spawn").length, 2);

	// A11 — two seats in different domains must not collapse into one bucket.
	assert.equal(graph.counts.byDomain.payments, 2);
	assert.equal(graph.counts.byDomain.security, 1);
	assert.equal(graph.counts.byDomain.unknown, 1, "an agent with no domain is counted as unknown, never silently dropped");
}

{
	// `paseo inspect` stays authoritative where we paid for it: a state file
	// that disagrees must not silently override a fresh inspect.
	const graph = buildGraph({
		agents: AGENTS,
		parents: { peer: "lead" },
		states: { peer: { agentId: "peer", parentAgentId: "sup", domain: "x" } },
		now: 0,
	});
	const peer = graph.nodes.find((n) => n.id === "peer");
	assert.equal(peer.parentId, "lead");
	assert.equal(peer.parentSource, "inspect");
	assert.equal(peer.domain, "x", "non-parent fields still come from state");
}

{
	// collectGraph must spend inspect calls ONLY on agents that have no state
	// file — that is the whole cost saving.
	const seen = [];
	const result = await collectGraph({
		runPaseoJson: async (args) => {
			seen.push(args.join(" "));
			if (args[0] === "ls") return AGENTS;
			if (args[0] === "permit") return [];
			return { Id: args[1], ParentAgentId: null };
		},
		readStates: () => ({
			states: {
				sup: { agentId: "sup", parentAgentId: null, domain: "security" },
				lead: { agentId: "lead", parentAgentId: "sup", domain: "security" },
				peer: { agentId: "peer", parentAgentId: "lead", domain: "security" },
			},
			degraded: [],
		}),
		cache: { version: cache.CACHE_VERSION, parents: {} },
		persistCache: false,
		maxInspect: 10,
		now: 0,
	});
	assert.equal(result.ok, true);
	const inspects = seen.filter((c) => c.startsWith("inspect"));
	assert.equal(inspects.length, 1, "only the one agent without a state file costs an inspect");
	assert.ok(inspects[0].includes("lost"));
	assert.equal(result.edges.filter((e) => e.type === "spawn").length, 2);
}

{
	// A degraded state read is reported, and the graph still renders.
	const result = await collectGraph({
		runPaseoJson: async (args) => (args[0] === "ls" ? AGENTS : args[0] === "permit" ? [] : { Id: args[1], ParentAgentId: null }),
		readStates: () => ({ states: {}, degraded: [{ reason: "AGENT_STATE_ROOT_UNREADABLE", detail: "no such dir" }] }),
		cache: { version: cache.CACHE_VERSION, parents: {} },
		persistCache: false,
		maxInspect: 0,
		now: 0,
	});
	assert.equal(result.ok, true);
	assert.equal(result.counts.agents, 4);
	assert.ok(result.degraded.some((f) => f.reason === "AGENT_STATE_ROOT_UNREADABLE"));
}

// --- OCR-005: dedup must not let one message erase another -----------------
// correlationId is chosen by the sender, so it is not a unique key. Two
// distinct messages sharing one must both draw, or a crafted (or merely
// careless) collision silently deletes a real edge from the graph.
{
	const A = "aaaaaaaa-1111-4111-8111-111111111111";
	const Bq = "bbbbbbbb-2222-4222-8222-222222222222";
	const graph = buildGraph({
		agents: [
			{ id: A, shortId: "aaaaaaa", provider: "pi-lead/o/m", status: "idle" },
			{ id: Bq, shortId: "bbbbbbb", provider: "pi-lead/o/m", status: "idle" },
		],
		messages: [
			{ from: A, to: Bq, kind: "question", correlationId: "same", room: "coord", confidence: "confirmed" },
			{ from: Bq, to: A, kind: "decision", correlationId: "same", room: "coord", confidence: "confirmed" },
			{ from: A, to: Bq, kind: "question", correlationId: "same", room: "leases", confidence: "confirmed" },
			// A true duplicate (same room, same author, same correlation) still draws once.
			{ from: A, to: Bq, kind: "question", correlationId: "same", room: "coord", confidence: "confirmed" },
		],
		now: 0,
	});
	const messages = graph.edges.filter((e) => e.type === "message");
	assert.equal(messages.length, 3, "distinct author/room pairs survive; the exact repeat is deduped");
}

// --- OCR-004: a parent disagreement is reported, not silently resolved ------
{
	const graph = buildGraph({
		agents: AGENTS,
		parents: { peer: "lead" },
		states: { peer: { agentId: "peer", parentAgentId: "sup" } },
		now: 0,
	});
	const peer = graph.nodes.find((n) => n.id === "peer");
	assert.equal(peer.parentId, "lead", "the paid-for inspect answer still wins");
	assert.ok(
		graph.degraded.some((f) => f.reason === "PARENT_SOURCE_DISAGREEMENT" && f.agentId === "peer"),
		"but the operator is told the two sources disagree",
	);
}

// --- PR-D: jurisdiction is visible on the board ----------------------------
// The policy already refuses on an overlap; an operator who cannot SEE the
// overlap has no way to find out why every Lead underneath went quiet.
{
	const seats = [
		{ id: "sup-a", shortId: "sup-a", name: "sup A", provider: "pi-supervisor/o/m", status: "idle", cwd: "/w" },
		{ id: "sup-b", shortId: "sup-b", name: "sup B", provider: "claude-supervisor/m", status: "idle", cwd: "/w" },
		{ id: "sup-c", shortId: "sup-c", name: "sup C", provider: "pi-supervisor/o/m", status: "idle", cwd: "/w" },
		{ id: "lead-1", shortId: "lead-1", name: "lead", provider: "pi-lead/o/m", status: "running", cwd: "/w" },
		{ id: "peer-1", shortId: "peer-1", name: "peer", provider: "pi-peer/o/m", status: "running", cwd: "/w" },
	];
	const graph = buildGraph({
		agents: seats,
		states: {
			"sup-a": { agentId: "sup-a", domain: "backend" },
			"sup-b": { agentId: "sup-b", domain: "backend.auth" },
			"sup-c": { agentId: "sup-c", domain: "frontend" },
			"lead-1": { agentId: "lead-1", domain: "backend.auth" },
			"peer-1": { agentId: "peer-1", domain: null },
		},
		now: 0,
	});
	const { conflicts, unlabeled, supervisors } = graph.jurisdiction;
	assert.equal(supervisors.length, 3);
	assert.equal(conflicts.length, 1, "backend contains backend.auth, so A and B collide");
	assert.deepEqual(conflicts[0].agents.sort(), ["sup-a", "sup-b"]);
	assert.match(conflicts[0].detail, /overlapping jurisdiction/i);
	assert.equal(
		unlabeled.length,
		0,
		"an unlabelled PEER is not a governance gap — only Leads and Supervisors are",
	);
	assert.equal(graph.counts.byDomain["backend.auth"], 2);

	// Spelling must not decide who collides: `Backend/Auth` is the same seat.
	const spelled = buildGraph({
		agents: seats.slice(0, 2),
		states: {
			"sup-a": { agentId: "sup-a", domain: "Backend" },
			"sup-b": { agentId: "sup-b", domain: "backend/auth" },
		},
		now: 0,
	});
	assert.equal(spelled.jurisdiction.conflicts.length, 1);

	// Disjoint domains are the normal, healthy case.
	const clean = buildGraph({
		agents: seats.slice(0, 3).filter((seat) => seat.id !== "sup-b"),
		states: {
			"sup-a": { agentId: "sup-a", domain: "backend" },
			"sup-c": { agentId: "sup-c", domain: "frontend" },
		},
		now: 0,
	});
	assert.equal(clean.jurisdiction.conflicts.length, 0);

	// A Lead with no domain cannot be governed under multi; say so.
	const unlabelled = buildGraph({
		agents: [seats[3]],
		states: {},
		now: 0,
	});
	assert.equal(unlabelled.jurisdiction.unlabeled.length, 1);
	assert.equal(unlabelled.jurisdiction.unlabeled[0].role, "lead");
}

// --- cluster diagnostic: the workspace axis, surfaced before it bites ------
// `supervisorTurnVerdict` (policy-core.ts) already refuses every
// SUPERVISOR_DECISION between a cluster-separate Supervisor/Lead pair with
// CLUSTER_MISMATCH. Policy cannot fix a seat it did not create — a human
// spinning up a Supervisor in the wrong workspace fails silently from the
// Lead's side — so the graph must show the mismatch BEFORE it shows up as a
// refused decision.
{
	// A11 — `node.cluster` follows agentCluster's own precedence: an explicit
	// team.cluster label wins over workspaceId, which wins over cwd, and a
	// missing state file resolves to null rather than crashing.
	const graph = buildGraph({
		agents: [
			{ id: "labelled", shortId: "labelled", name: "labelled", provider: "pi-lead/o/m", status: "idle", cwd: "/w" },
			{ id: "workspaced", shortId: "workspaced", name: "workspaced", provider: "pi-lead/o/m", status: "idle", cwd: "/w" },
			{ id: "bare-cwd", shortId: "bare-cwd", name: "bare-cwd", provider: "pi-lead/o/m", status: "idle", cwd: "/w" },
			{ id: "no-state", shortId: "no-state", name: "no-state", provider: "pi-lead/o/m", status: "idle", cwd: "/w" },
		],
		states: {
			labelled: { agentId: "labelled", labels: { "team.cluster": "Shop" }, workspaceId: "ws-1", cwd: "/shop" },
			workspaced: { agentId: "workspaced", workspaceId: "ws-2", cwd: "/blog" },
			"bare-cwd": { agentId: "bare-cwd", cwd: "D:\\Code\\Shop" },
		},
		now: 0,
	});
	const by = Object.fromEntries(graph.nodes.map((n) => [n.id, n]));
	assert.equal(by.labelled.cluster, "shop", "an explicit team.cluster label wins, and is case/slash normalized");
	assert.equal(by.workspaced.cluster, "ws-2", "workspaceId is next when there is no label");
	assert.equal(by["bare-cwd"].cluster, "d:/code/shop", "cwd is the last fallback, normalized the same way");
	assert.equal(by["no-state"].cluster, null, "no state file means an unproven cluster, not a crash");
}

{
	// THE bug pinned here: a Supervisor and a Lead in different clusters with
	// NO edge between them (no spawn, no fork, no message — i.e. two entirely
	// unrelated projects sharing a host) must NOT warn. This is the ordinary
	// state of every multi-project machine; `clustersSeparate` alone cannot
	// distinguish it from a real split team, so it must never fire by itself.
	const graph = buildGraph({
		agents: [
			{ id: "sup", shortId: "sup", name: "sup", provider: "pi-supervisor/o/m", status: "idle", cwd: "/w" },
			{ id: "lead", shortId: "lead", name: "lead", provider: "pi-lead/o/m", status: "running", cwd: "/w" },
		],
		parents: { sup: null, lead: null },
		states: {
			sup: { agentId: "sup", labels: { "team.cluster": "pod-product" } },
			lead: { agentId: "lead", labels: { "team.cluster": "wonderquest" } },
		},
		now: 0,
	});
	assert.equal(graph.edges.length, 0, "sanity check: this fixture really has no edge between them");
	assert.deepEqual(
		graph.clusterMismatches,
		[],
		"two unrelated projects on one host are the normal case, not a mismatch",
	);
}

{
	// A Supervisor and a Lead already connected by a spawn edge, but genuinely
	// in different clusters: the board must name the exact consequence
	// (CLUSTER_MISMATCH on every SUPERVISOR_DECISION) and the exact fix
	// (team.cluster / PASEO_TEAM_CLUSTER on both seats).
	const graph = buildGraph({
		agents: [
			{ id: "sup", shortId: "sup", name: "sup", provider: "pi-supervisor/o/m", status: "idle", cwd: "/w" },
			{ id: "lead", shortId: "lead", name: "lead", provider: "pi-lead/o/m", status: "running", cwd: "/w" },
		],
		states: {
			sup: { agentId: "sup", labels: { "team.cluster": "shop" } },
			// The spawn edge (sup -> lead) is the positive evidence these two are
			// meant to be one team.
			lead: { agentId: "lead", labels: { "team.cluster": "blog" }, parentAgentId: "sup" },
		},
		now: 0,
	});
	assert.ok(graph.edges.some((e) => e.type === "spawn" && e.from === "sup" && e.to === "lead"));
	assert.equal(graph.clusterMismatches.length, 1);
	const mismatch = graph.clusterMismatches[0];
	assert.equal(mismatch.supervisor.id, "sup");
	assert.equal(mismatch.supervisor.cluster, "shop");
	assert.equal(mismatch.lead.id, "lead");
	assert.equal(mismatch.lead.cluster, "blog");
	assert.match(mismatch.detail, /SUPERVISOR_DECISION/);
	assert.match(mismatch.detail, /CLUSTER_MISMATCH/);
	assert.match(mismatch.detail, /team\.cluster/);
	assert.match(mismatch.detail, /PASEO_TEAM_CLUSTER/);
}

{
	// A message edge is just as much evidence of a team as a spawn edge.
	const graph = buildGraph({
		agents: [
			{ id: "sup", shortId: "sup", name: "sup", provider: "pi-supervisor/o/m", status: "idle", cwd: "/w" },
			{ id: "lead", shortId: "lead", name: "lead", provider: "pi-lead/o/m", status: "running", cwd: "/w" },
		],
		parents: { sup: null, lead: null },
		states: {
			sup: { agentId: "sup", labels: { "team.cluster": "shop" } },
			lead: { agentId: "lead", labels: { "team.cluster": "blog" } },
		},
		messages: [{ from: "sup", to: "lead", kind: "observation", correlationId: "c1", confidence: "confirmed" }],
		now: 0,
	});
	assert.equal(graph.clusterMismatches.length, 1, "a message edge is enough to prove relatedness");
}

{
	// Direction must not decide relatedness: a Lead replying to its own
	// Supervisor (edge lead -> sup) is exactly as much evidence as sup -> lead.
	const graph = buildGraph({
		agents: [
			{ id: "sup", shortId: "sup", name: "sup", provider: "pi-supervisor/o/m", status: "idle", cwd: "/w" },
			{ id: "lead", shortId: "lead", name: "lead", provider: "pi-lead/o/m", status: "running", cwd: "/w" },
		],
		parents: { sup: null, lead: null },
		states: {
			sup: { agentId: "sup", labels: { "team.cluster": "shop" } },
			lead: { agentId: "lead", labels: { "team.cluster": "blog" } },
		},
		messages: [{ from: "lead", to: "sup", kind: "observation", correlationId: "c1", confidence: "confirmed" }],
		now: 0,
	});
	assert.equal(graph.clusterMismatches.length, 1, "the edge still counts in reverse");
}

{
	// An unprovable cluster on EITHER side must not warn even when a real edge
	// connects them: a false warning teaches an operator to ignore warnings.
	// This mirrors clustersSeparate's own null-is-"not separate" rule exactly
	// — that predicate is reused here, not re-implemented.
	const graph = buildGraph({
		agents: [
			{ id: "sup", shortId: "sup", name: "sup", provider: "pi-supervisor/o/m", status: "idle", cwd: "/w" },
			{ id: "lead", shortId: "lead", name: "lead", provider: "pi-lead/o/m", status: "running", cwd: "/w" },
		],
		states: {
			sup: { agentId: "sup", labels: { "team.cluster": "shop" } },
			// lead has no state file at all: cluster is null, not "different".
			// The spawn edge still exists (inspect answered it directly).
		},
		parents: { sup: null, lead: "sup" },
		now: 0,
	});
	assert.ok(graph.edges.some((e) => e.type === "spawn" && e.to === "lead"), "sanity check: the edge is really there");
	assert.deepEqual(graph.clusterMismatches, []);
}

{
	// The healthy case: same cluster, spelled differently, still resolves as one.
	const graph = buildGraph({
		agents: [
			{ id: "sup", shortId: "sup", name: "sup", provider: "pi-supervisor/o/m", status: "idle", cwd: "/w" },
			{ id: "lead", shortId: "lead", name: "lead", provider: "pi-lead/o/m", status: "running", cwd: "/w" },
		],
		states: {
			sup: { agentId: "sup", labels: { "team.cluster": "Shop" } },
			lead: { agentId: "lead", labels: { "team.cluster": "shop/" }, parentAgentId: "sup" },
		},
		now: 0,
	});
	assert.deepEqual(graph.clusterMismatches, []);
}

{
	// A garbage state entry (not an object) must degrade to a null cluster,
	// not throw — the same fail-open discipline as the rest of buildGraph.
	assert.doesNotThrow(() => {
		const graph = buildGraph({
			agents: [{ id: "lead", shortId: "lead", name: "lead", provider: "pi-lead/o/m", status: "idle", cwd: "/w" }],
			states: { lead: "not-an-object" },
			now: 0,
		});
		assert.equal(graph.nodes[0].cluster, null);
	});
}

{
	// describeClusterMismatches takes the SAME edges buildGraph already built
	// — it must not re-derive relatedness from parentId itself.
	const nodes = [
		{ id: "sup", role: "supervisor", shortId: "sup", cluster: "a" },
		{ id: "lead", role: "lead", shortId: "lead", cluster: "b" },
		{ id: "peer", role: "peer", shortId: "peer", cluster: "c" },
	];
	const edges = [{ type: "spawn", from: "sup", to: "lead", confidence: "confirmed" }];
	assert.equal(
		describeClusterMismatches(nodes, edges).length,
		1,
		"only supervisor/lead pairs with a real edge are checked, never peers",
	);
	assert.equal(
		describeClusterMismatches(nodes, []).length,
		0,
		"no edges at all means no warning, even though the clusters differ",
	);
	assert.deepEqual(describeClusterMismatches(nodes), [], "edges defaults to empty, not a crash");
}

// --- PR-E: a fork is lineage the board must show ---------------------------
// An imported fork is a ROOT agent (paseo import leaves ParentAgentId null), so
// without an explicit edge two Leads holding the very same transcript render as
// strangers — which is precisely the state an operator must not misread.
{
	const graph = buildGraph({
		agents: [
			{ id: "lead-a", shortId: "lead-a", name: "A", provider: "pi-lead/o/m", status: "idle", cwd: "/w" },
			{ id: "lead-b", shortId: "lead-b", name: "B", provider: "pi-lead/o/m", status: "running", cwd: "/w" },
			{ id: "lead-c", shortId: "lead-c", name: "C", provider: "pi-lead/o/m", status: "idle", cwd: "/w" },
		],
		states: {
			"lead-b": { agentId: "lead-b", forkOf: "lead-a" },
			// Forked from an agent this listing does not cover (archived, other
			// host): no edge to draw, and no crash either.
			"lead-c": { agentId: "lead-c", forkOf: "gone" },
		},
		now: 0,
	});
	const forks = graph.edges.filter((edge) => edge.type === "fork");
	assert.equal(forks.length, 1);
	assert.deepEqual(
		{ from: forks[0].from, to: forks[0].to, confidence: forks[0].confidence },
		{ from: "lead-a", to: "lead-b", confidence: "confirmed" },
	);
	assert.equal(graph.nodes.find((node) => node.id === "lead-c").forkOf, "gone");
}

console.log("graph tests passed");

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildGraph, collectGraph, inferRole, normalizePermits, parsePeerMessage } from "../cli/lib/graph.mjs";
import * as cache from "../cli/lib/graph-cache.mjs";

// --- role inference --------------------------------------------------------
// `ls` reports "pi-lead/Owner/model" and `inspect` reports "pi-lead"; both
// must land on the same role or the graph would colour the same agent twice.
assert.equal(inferRole("pi-supervisor/Minnyat/deepseek-v4-flash"), "supervisor");
assert.equal(inferRole("pi-lead"), "lead");
assert.equal(inferRole("PI-PEER/x"), "peer");
assert.equal(inferRole("claude"), null, "an unknown provider is unknown, not bucketed into a role");
assert.equal(inferRole(undefined), null);

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

console.log("graph tests passed");

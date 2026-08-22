import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const CLI = join(HERE, "..", "cli", "paseo-team.mjs");
const FAKE = join(HERE, "fixtures", "fake-paseo-live.mjs");

const sandbox = mkdtempSync(join(tmpdir(), "pst-cli-"));

/** Every run is pointed at a throwaway HOME so no test can touch a real config. */
function run(args, extraEnv = {}) {
	const result = spawnSync(process.execPath, [CLI, ...args], {
		encoding: "utf8",
		input: extraEnv.__stdin ?? "",
		env: {
			...process.env,
			PASEO_TEAM_PASEO_EXEC: `node "${FAKE}"`,
			PI_HOME: join(sandbox, "pi"),
			PST_TEAM_CONFIG_DIR: join(sandbox, "team"),
			PASEO_CONFIG_JSON: join(sandbox, "paseo-config.json"),
			...extraEnv,
		},
	});
	let json = null;
	try {
		json = JSON.parse(result.stdout);
	} catch {
		/* not every command answers with JSON (help does not) */
	}
	return { ...result, json };
}

try {
	// --- help + fail-closed dispatch ---------------------------------------
	{
		const help = run(["--help"]);
		assert.equal(help.status, 0);
		for (const command of ["agents", "permits list", "graph", "web", "chat read"]) {
			assert.ok(help.stdout.includes(command), `help documents '${command}'`);
		}

		const unknown = run(["teleport"]);
		assert.equal(unknown.status, 2, "an unknown command exits 2, it does not fall through to help");

		// Typos must never be silently ignored — that is how a --strict-shaped
		// flag ends up doing nothing while looking like it worked.
		const badFlag = run(["graph", "--with-logs"]);
		assert.notEqual(badFlag.status, 0);
		assert.match(badFlag.stderr, /unknown flag/);

		const badSub = run(["permits", "approve"]);
		assert.notEqual(badSub.status, 0);
		assert.match(badSub.stderr, /unknown subcommand/);
	}

	// --- agents: role inference travels with the row -----------------------
	{
		const agents = run(["agents"]);
		assert.equal(agents.status, 0);
		assert.equal(agents.json.ok, true);
		assert.equal(agents.json.count, 3);
		assert.deepEqual(agents.json.agents.map((agent) => agent.role), ["supervisor", "lead", "peer"]);
	}

	// --- agent refs are validated before they reach argv --------------------
	{
		const bad = run(["agent", "inspect", "$(rm -rf /)"]);
		assert.notEqual(bad.status, 0);
		assert.match(bad.stderr, /invalid agent reference/);

		const good = run(["agent", "inspect", "22222222-2222-2222-2222-222222222222"]);
		assert.equal(good.status, 0);
		assert.equal(good.json.agent.ParentAgentId, "11111111-1111-1111-1111-111111111111");
	}

	// --- send: the prompt travels as a file, not as a command line ----------
	{
		const body = "x".repeat(20_000);
		const sent = run(["agent", "send", "33333333-3333-3333-3333-333333333333"], { __stdin: body });
		assert.equal(sent.status, 0, sent.stderr);
		assert.equal(sent.json.ok, true);
		assert.equal(sent.json.response.body, body, "a 20k prompt survives intact");
		assert.equal(sent.json.bytes, 20_000);
	}

	// --- permits -------------------------------------------------------------
	{
		const empty = run(["permits", "list"]);
		assert.equal(empty.json.count, 0);

		const listed = run(["permits", "list"], { FAKE_PERMITS: "1" });
		assert.equal(listed.json.permits.length, 1);
		assert.equal(listed.json.permits[0].tool, "write");
		// The row nothing could name is still shown — someone is blocked on it —
		// but it arrives in `unclassified`, where the UI cannot one-click it.
		assert.equal(listed.json.unclassified.length, 1);
		assert.equal(listed.json.count, 2);

		const decided = run(["permits", "allow", "33333333-3333-3333-3333-333333333333", "req-1"]);
		assert.equal(decided.status, 0, decided.stderr);
		assert.equal(decided.json.response.decided, "allow");

		// Approving a tool call is an authority act and leaves a record.
		const audit = join(sandbox, "team", "permit-audit.jsonl");
		assert.ok(existsSync(audit), "a permit decision is audited");
		const entry = JSON.parse(readFileSync(audit, "utf8").trim().split("\n").at(-1));
		assert.equal(entry.action, "allow");
		assert.equal(entry.requestId, "req-1");
		assert.equal(entry.agentId, "33333333-3333-3333-3333-333333333333");

		const malformed = run(["permits", "deny", "33333333-3333-3333-3333-333333333333", "req 1"]);
		assert.notEqual(malformed.status, 0);
	}

	// --- graph over a fake daemon -------------------------------------------
	{
		const graph = run(["graph"]);
		assert.equal(graph.status, 0, graph.stderr);
		assert.equal(graph.json.ok, true);
		assert.equal(graph.json.counts.agents, 3);
		assert.deepEqual(
			graph.json.edges.filter((edge) => edge.type === "spawn").map((edge) => `${edge.from.slice(0, 4)}->${edge.to.slice(0, 4)}`),
			["1111->2222", "2222->3333"],
		);
		assert.deepEqual(graph.json.degraded, []);

		// The cache lives in the throwaway team dir, not in the repo.
		assert.ok(existsSync(join(sandbox, "team", "graph-cache.json")));

		// Second run: the tree is already known, so no inspect is spent. This is
		// what makes polling affordable at ~3s per paseo call.
		const warm = run(["graph"]);
		assert.equal(warm.json.inspectSpent, 0);
		assert.equal(warm.json.pendingParents, 0);
		assert.equal(warm.json.counts.edges, 2);
	}

	// --- chat ----------------------------------------------------------------
	{
		const rooms = run(["chat", "list"]);
		assert.equal(rooms.json.rooms[0].name, "team");

		const read = run(["chat", "read", "team", "--limit", "10"]);
		assert.equal(read.json.messages[0].body, "hello");

		const badRoom = run(["chat", "read", "../etc"]);
		assert.notEqual(badRoom.status, 0);
		assert.match(badRoom.stderr, /invalid room/);
	}

	// --- config still round-trips through the sandbox ------------------------
	{
		const written = run(["config", "write", "routing"], { __stdin: '{"hostId":"box-1"}' });
		assert.equal(written.status, 0, written.stderr);
		const read = run(["config", "read", "routing"]);
		assert.equal(read.json.exists, true);
		assert.deepEqual(read.json.data, { hostId: "box-1" });
		assert.match(read.json.path, /model-routing\.local\.json$/);

		const invalid = run(["config", "write", "routing"], { __stdin: "{not json" });
		assert.notEqual(invalid.status, 0);
	}
} finally {
	rmSync(sandbox, { recursive: true, force: true });
}

console.log("cli-contract tests passed");

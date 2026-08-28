import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync, existsSync } from "node:fs";
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
			// Paseo's own home, so the graph never reads the developer's real
			// agent state — that difference is what let a bug reach CI green here
			// and red on every runner.
			PASEO_HOME: join(sandbox, "paseo"),
			PST_TEAM_CONFIG_DIR: join(sandbox, "team"),
			PASEO_CONFIG_JSON: join(sandbox, "paseo-config.json"),
			// The Claude half of the pack lives in two more user-owned files;
			// both are redirected so uninstall can never touch the real ones.
			CLAUDE_CONFIG_DIR: join(sandbox, "claude"),
			PASEO_TEAM_CLAUDE_USER_CONFIG: join(sandbox, "claude.json"),
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
		for (const command of ["agents", "permits list", "graph", "web", "chat read", "update", "uninstall"]) {
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

	// --- every section carries the form schema the WebUI renders -------------
	{
		for (const section of ["providers", "routing", "cluster", "mcp", "paseo", "pi-settings"]) {
			const read = run(["config", "read", section]);
			assert.equal(read.status, 0, `${section}: ${read.stderr}`);
			assert.ok(Array.isArray(read.json.schema?.groups), `${section} read carries a form schema`);
		}

		// pi-settings points at Pi's own settings file and works before it exists
		const pi = run(["config", "read", "pi-settings"]);
		assert.equal(pi.json.exists, false);
		assert.match(pi.json.path, /[\\/]settings\.json$/);
		const retryGroup = pi.json.schema.groups.find((group) => group.id === "retry");
		assert.ok(retryGroup, "the retry group is described even before any file exists");
		const preset = pi.json.schema.presets.find((entry) => entry.id === "unstable-provider");
		assert.equal(preset?.patch?.retry?.maxRetries, 6, "the unstable-provider preset ships its retry budget");

		// A save must never drop keys the form does not know about.
		const settingsPath = join(sandbox, "pi", "agent", "settings.json");
		mkdirSync(dirname(settingsPath), { recursive: true });
		writeFileSync(settingsPath, JSON.stringify({ packages: ["npm:pi-web-access"], theme: "dark" }));
		const saved = run(["config", "write", "pi-settings"], {
			__stdin: JSON.stringify({ packages: ["npm:pi-web-access"], theme: "dark", retry: { maxRetries: 6 } }),
		});
		assert.equal(saved.status, 0, saved.stderr);
		const after = JSON.parse(readFileSync(settingsPath, "utf8"));
		assert.equal(after.packages[0], "npm:pi-web-access", "alien keys survive the write");
		assert.equal(after.retry.maxRetries, 6);
		assert.ok(
			readdirSync(dirname(settingsPath)).some((file) => /^settings\.json\.bak-\d+$/.test(file)),
			"a pi-settings rewrite leaves a .bak-* sibling",
		);

		const help = run(["--help"]);
		assert.ok(help.stdout.includes("pi-settings"), "help lists the pi-settings section");

		const unknown = run(["config", "read", "pi"]);
		assert.notEqual(unknown.status, 0);
		assert.match(unknown.stderr, /unknown config section/);
	}

	// --- version + update -----------------------------------------------------
	{
		const pkg = JSON.parse(readFileSync(join(HERE, "..", "package.json"), "utf8"));
		const FAKE_GIT = join(HERE, "fixtures", "fake-git.mjs");
		const gitEnv = (tags, extra = {}) => ({
			PASEO_TEAM_GIT_EXEC: `node "${FAKE_GIT}"`,
			FAKE_GIT_TAGS: tags,
			...extra,
		});

		const v = run(["--version"]);
		assert.equal(v.status, 0);
		assert.equal(v.stdout.trim(), `pteam ${pkg.version}`);

		const status = run(["status"]);
		assert.equal(
			status.json.version,
			pkg.version,
			"status.version must read package.json (the old hardcoded drift bug)",
		);

		const helpUpdate = run(["--help"]);
		assert.ok(helpUpdate.stdout.includes("update"), "help documents 'update'");

		const newer = run(["update", "--check"], gitEnv("sha\trefs/tags/v99.0.0\n"));
		assert.equal(newer.status, 0);
		assert.equal(newer.json.latest, "v99.0.0");
		assert.equal(newer.json.updateAvailable, true);

		const older = run(["update", "--check"], gitEnv("sha\trefs/tags/v0.0.1\n"));
		assert.equal(older.status, 0);
		assert.equal(older.json.updateAvailable, false);
		assert.equal(older.json.upToDate, true);

		// an unreachable remote degrades to JSON + exit 0; it must not crash
		const down = run(["update", "--check"], gitEnv("", { FAKE_GIT_FAIL: "1" }));
		assert.equal(down.status, 0);
		assert.equal(down.json.updateAvailable, null);
		assert.ok(Array.isArray(down.json.degraded) && down.json.degraded.length === 1);

		// from the test sandbox the CLI lives in a checkout: an actual update
		// must hand the pull back to the user instead of spawning npm
		const manual = run(["update"], gitEnv("sha\trefs/tags/v99.0.0\n"));
		assert.equal(manual.status, 0);
		assert.equal(manual.json.action, "manual");
		assert.equal(manual.json.mode, "checkout");

		const noop = run(["update"], gitEnv("sha\trefs/tags/v0.0.1\n"));
		assert.equal(noop.status, 0);
		assert.equal(noop.json.action, "none");

		const badUpdateFlag = run(["update", "--yes"]);
		assert.notEqual(badUpdateFlag.status, 0);
		assert.match(badUpdateFlag.stderr, /unknown flag/);
	}

	// --- uninstall ------------------------------------------------------------
	{
		// seed the exact footprint install leaves behind, inside the sandbox
		const agentRoot = join(sandbox, "pi", "agent");
		const mk = (rel, content) => {
			const p = join(agentRoot, rel);
			mkdirSync(dirname(p), { recursive: true });
			writeFileSync(p, content);
		};
		mk(join("extensions", "paseo-team-policy.ts"), "export {};");
		// The shared policy core installs next to the extension and must go with
		// it: left behind, it would keep a Claude hook working after the pack is
		// uninstalled.
		mk(join("extensions", "paseo-team-core", "policy-core.ts"), "export {};");
		mk(join("extensions", "paseo-team-core", "claude-policy.ts"), "export {};");
		for (const role of ["supervisor", "lead", "peer"]) {
			mk(join("extensions", "prompts", `${role}.md`), "prompt");
		}
		for (const skill of ["paseo-team-lead", "paseo-ocr-reviewer", "agent-browser"]) {
			mk(join("skills", skill, "SKILL.md"), "skill");
		}
		mk(join("extensions", "paseo-team-scripts", "preflight.mjs"), "// support");
		const mcpPath = join(agentRoot, "mcp.json");
		writeFileSync(
			mcpPath,
			JSON.stringify({ mcpServers: { "agent-browser": { command: "x" }, "other-tool": { command: "y" } } }),
		);
		const teamDir = join(sandbox, "team");
		mkdirSync(teamDir, { recursive: true });
		writeFileSync(join(teamDir, "permit-audit.jsonl"), "{}\n");

		const out = run(["uninstall"]);
		assert.equal(out.status, 0);
		for (const t of out.json.targets) assert.equal(t.status, "removed", `${t.kind} must be removed`);
		assert.equal(out.json.mcp.status, "removed");
		// Nothing was installed for Claude in this sandbox, so the removal is a
		// clean no-op — reported, never a crash, and never a write.
		assert.equal(out.json.claude.status, "missing");
		assert.ok(!existsSync(join(sandbox, "claude", "settings.json")));
		const mcpAfter = JSON.parse(readFileSync(mcpPath, "utf8"));
		assert.equal(mcpAfter.mcpServers["agent-browser"], undefined, "own MCP entry removed");
		assert.ok(mcpAfter.mcpServers["other-tool"], "other tools' MCP entries must survive");
		assert.ok(
			readdirSync(agentRoot).some((f) => /^mcp\.json\.bak-\d+$/.test(f)),
			"the mcp.json rewrite must leave a .bak-* sibling (recoverability claim)",
		);
		assert.ok(!existsSync(join(agentRoot, "extensions", "paseo-team-policy.ts")));
		assert.ok(!existsSync(join(agentRoot, "skills", "paseo-team-lead")));
		assert.ok(
			existsSync(join(agentRoot, "extensions", "prompts")),
			"the shared prompts dir itself must never be deleted",
		);
		assert.equal(out.json.teamData.status, "kept", "audit log survives without --purge");
		assert.ok(existsSync(join(teamDir, "permit-audit.jsonl")));

		// idempotent: a second run finds everything missing and still succeeds
		const again = run(["uninstall"]);
		assert.equal(again.status, 0);
		assert.ok(again.json.targets.every((t) => t.status === "missing"));
		assert.equal(again.json.mcp.status, "entry-missing");

		// --purge deletes the team dir including the audit log
		const purged = run(["uninstall", "--purge"]);
		assert.equal(purged.status, 0);
		assert.equal(purged.json.teamData.status, "removed");
		assert.ok(!existsSync(teamDir));

		// a present-but-corrupt mcp.json is reported and left byte-identical,
		// never conflated with "no config" and never rewritten
		writeFileSync(mcpPath, "{not json");
		const corrupt = run(["uninstall"]);
		assert.equal(corrupt.status, 0);
		assert.equal(corrupt.json.mcp.status, "mcp-config-unreadable");
		assert.ok(corrupt.json.mcp.error, "unreadable report carries the parse error");
		assert.equal(readFileSync(mcpPath, "utf8"), "{not json", "corrupt file must stay untouched");

		const badUninstallFlag = run(["uninstall", "--force"]);
		assert.notEqual(badUninstallFlag.status, 0);
	}
} finally {
	rmSync(sandbox, { recursive: true, force: true });
}

console.log("cli-contract tests passed");

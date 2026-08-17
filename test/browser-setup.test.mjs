import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	AGENT_BROWSER_MCP_SERVER,
	agentBrowserCdpTarget,
	assertCdpPort,
	browserMcpConfig,
	cdpEndpointUrl,
	isValidAgentBrowserMcpServer,
	mergeAgentBrowserMcpConfig,
	mcpConfigCandidates,
	probeCdpEndpoint,
	resolveExistingEntryDecision,
	skillIsInstalled,
} from "../scripts/browser-setup.mjs";

// Existing MCP servers/config must survive installation byte-for-byte in meaning.
{
	const existing = {
		settings: { toolPrefix: "server" },
		mcpServers: {
			github: { command: "gh-mcp", args: ["serve"] },
			[AGENT_BROWSER_MCP_SERVER]: {
				command: "agent-browser",
				args: ["mcp", "--tools", "core"],
				disabled: true,
			},
		},
	};
	const merged = mergeAgentBrowserMcpConfig(existing);
	assert.deepEqual(
		merged,
		existing,
		"valid existing agent-browser config is never overwritten",
	);
}

{
	const merged = mergeAgentBrowserMcpConfig({
		mcpServers: { [AGENT_BROWSER_MCP_SERVER]: "enabled", github: { command: "gh" } },
	});
	assert.deepEqual(merged.mcpServers[AGENT_BROWSER_MCP_SERVER], browserMcpConfig());
	assert.deepEqual(merged.mcpServers.github, { command: "gh" });
}

{
	const merged = mergeAgentBrowserMcpConfig({
		mcpServers: { github: { command: "gh" } },
	});
	assert.deepEqual(merged.mcpServers.github, { command: "gh" });
	assert.deepEqual(
		merged.mcpServers[AGENT_BROWSER_MCP_SERVER],
		browserMcpConfig(),
	);
}

assert.equal(
	mergeAgentBrowserMcpConfig({}).mcpServers[AGENT_BROWSER_MCP_SERVER].args[0],
	"mcp",
);
assert.equal(isValidAgentBrowserMcpServer(browserMcpConfig()), true);
assert.equal(isValidAgentBrowserMcpServer("enabled"), false);
assert.equal(isValidAgentBrowserMcpServer({ command: "agent-browser", args: ["open"] }), false);
assert.equal(isValidAgentBrowserMcpServer({ command: "agent-browser", args: ["mcp"] }), true);
assert.ok(
	mcpConfigCandidates("C:/pi").some((path) =>
		/agent[\\/]mcp\.json$/.test(path),
	),
);
const skillRoot = mkdtempSync(join(tmpdir(), "paseo-browser-test-"));
mkdirSync(join(skillRoot, "agent-browser"), { recursive: true });
writeFileSync(join(skillRoot, "agent-browser", "SKILL.md"), "# test\n");
assert.equal(
	skillIsInstalled(join(skillRoot, "agent-browser", "SKILL.md")),
	true,
);
assert.equal(skillIsInstalled(join(skillRoot, "agent-browser")), false);
rmSync(skillRoot, { recursive: true, force: true });

// --- CDP attach mode ------------------------------------------------------------
//
// Launch mode is the default on purpose: agent-browser starts a browser with no
// ambient credentials, which is the isolation BROWSER_MCP_AUTHORITY is sized
// for. Attaching to a running Chrome hands a granted Peer every session in that
// profile, so it must be an explicit opt-in — never a default, never implied.

// Default stays launch mode: no --cdp is written into anyone's config.
assert.deepEqual(browserMcpConfig().args, ["mcp"]);
assert.equal(browserMcpConfig().args.includes("--cdp"), false);

// agent-browser takes --cdp as a GLOBAL flag, before the subcommand:
//   agent-browser --cdp 9222 mcp
assert.deepEqual(browserMcpConfig({ cdpPort: 9222 }).args, [
	"--cdp",
	"9222",
	"mcp",
]);
assert.deepEqual(browserMcpConfig({ cdpPort: "9222" }).args, [
	"--cdp",
	"9222",
	"mcp",
]);

// Ports are validated at the boundary so a typo can never reach mcp.json.
assert.equal(assertCdpPort(9222), 9222);
assert.equal(assertCdpPort(" 9222 "), 9222);
// Every rejection must be THIS error, not an incidental one from formatting the
// offending value — a fail-closed helper that dies the wrong way is a helper you
// cannot diagnose.
for (const bad of [
	"",
	" ",
	"abc",
	"0",
	"-1",
	"65536",
	"92.22",
	null,
	undefined,
	{},
	1.5,
	Number.NaN,
	9222n,
	Symbol("9222"),
	[9222],
]) {
	assert.throws(
		() => assertCdpPort(bad),
		/CDP port must be an integer/,
		`assertCdpPort must reject ${String(bad)} with its own error`,
	);
}
assert.throws(() => browserMcpConfig({ cdpPort: "nope" }), /CDP port/);

// The validator accepts both shapes. It must stay a superset of the old rule:
// anything it rejects gets OVERWRITTEN by the installer, so tightening it here
// would silently clobber a config the user edited by hand.
assert.equal(isValidAgentBrowserMcpServer({ command: "agent-browser", args: ["mcp"] }), true);
assert.equal(
	isValidAgentBrowserMcpServer({ command: "agent-browser", args: ["mcp", "--tools", "core"] }),
	true,
);
assert.equal(
	isValidAgentBrowserMcpServer({ command: "agent-browser", args: ["--cdp", "9222", "mcp"] }),
	true,
);
assert.equal(
	isValidAgentBrowserMcpServer({ command: "agent-browser", args: ["mcp", "--cdp", "9222"] }),
	true,
);
assert.equal(isValidAgentBrowserMcpServer(browserMcpConfig({ cdpPort: 9222 })), true);
// --cdp without a usable port is not a config we can reason about.
assert.equal(
	isValidAgentBrowserMcpServer({ command: "agent-browser", args: ["--cdp", "9222"] }),
	false,
);
assert.equal(
	isValidAgentBrowserMcpServer({ command: "agent-browser", args: ["--cdp", "mcp"] }),
	false,
);
assert.equal(
	isValidAgentBrowserMcpServer({ command: "agent-browser", args: ["--cdp", "0", "mcp"] }),
	false,
);
assert.equal(
	isValidAgentBrowserMcpServer({ command: "agent-browser", args: ["--cdp", "70000", "mcp"] }),
	false,
);
assert.equal(isValidAgentBrowserMcpServer({ command: "agent-browser", args: [] }), false);

// Superset guard. Every rejection here makes the installer OVERWRITE that entry,
// so the rule must never reject anything the pre-CDP rule accepted — including
// fields it did not look at, such as `lifecycle`. This replays the old rule
// verbatim over a corpus and fails on any entry that lost validity.
{
	const preCdpRule = (server) =>
		Boolean(
			server &&
				typeof server === "object" &&
				!Array.isArray(server) &&
				typeof server.command === "string" &&
				server.command.trim() === "agent-browser" &&
				Array.isArray(server.args) &&
				server.args[0] === "mcp" &&
				server.args.every((arg) => typeof arg === "string") &&
				(server.disabled === undefined || typeof server.disabled === "boolean"),
		);
	const argSets = [
		["mcp"],
		["mcp", "--tools", "core"],
		["mcp", "--cdp"],
		["mcp", "--cdp", "9222"],
		["mcp", "--cdp", "0"],
		["open"],
		[],
		["--cdp", "9222", "mcp"],
	];
	const extras = [
		{},
		{ disabled: true },
		{ disabled: false },
		{ lifecycle: "lazy" },
		{ lifecycle: 7 },
		{ lifecycle: null },
		{ lifecycle: {} },
		{ someFutureField: { nested: true } },
	];
	for (const args of argSets) {
		for (const extra of extras) {
			const server = { command: "agent-browser", args, ...extra };
			if (preCdpRule(server)) {
				assert.equal(
					isValidAgentBrowserMcpServer(server),
					true,
					`the installer would clobber a previously valid entry: ${JSON.stringify(server)}`,
				);
			}
		}
	}
}

// Preflight needs the parsed target, not a second ad-hoc scan of args.
assert.deepEqual(agentBrowserCdpTarget({ command: "agent-browser", args: ["mcp"] }), {
	mode: "launch",
	port: null,
});
assert.deepEqual(
	agentBrowserCdpTarget({ command: "agent-browser", args: ["--cdp", "9222", "mcp"] }),
	{ mode: "attach", port: 9222 },
);
assert.deepEqual(
	agentBrowserCdpTarget({ command: "agent-browser", args: ["mcp", "--cdp", "9333"] }),
	{ mode: "attach", port: 9333 },
);
// Same port twice is redundant but unambiguous; two different ports is not, and
// guessing which one agent-browser honours is not our call.
assert.deepEqual(
	agentBrowserCdpTarget({
		command: "agent-browser",
		args: ["--cdp", "9222", "mcp", "--cdp", "9222"],
	}),
	{ mode: "attach", port: 9222 },
);
assert.deepEqual(
	agentBrowserCdpTarget({
		command: "agent-browser",
		args: ["--cdp", "9222", "mcp", "--cdp", "9333"],
	}),
	{ mode: "ambiguous", port: null },
);
// A trailing --cdp with no port stays VALID (the old rule accepted it, and
// re-classifying it would clobber a user's entry) but is not a target we will
// probe — preflight reports it instead of guessing.
assert.equal(
	isValidAgentBrowserMcpServer({ command: "agent-browser", args: ["mcp", "--cdp"] }),
	true,
);
assert.deepEqual(
	agentBrowserCdpTarget({ command: "agent-browser", args: ["mcp", "--cdp"] }),
	{ mode: "ambiguous", port: null },
);
assert.throws(() => agentBrowserCdpTarget({ command: "gh", args: ["mcp"] }), /agent-browser/);

// An IPv6 target has to be bracketed or the URL is nonsense — and the exposure
// probe now dials IPv6 addresses too, so this is on a live path.
assert.equal(cdpEndpointUrl("127.0.0.1", 9222), "http://127.0.0.1:9222/json/version");
assert.equal(cdpEndpointUrl("::1", 9222), "http://[::1]:9222/json/version");
assert.equal(cdpEndpointUrl("fd00::1", 9222), "http://[fd00::1]:9222/json/version");
// Already-bracketed input must not be double-wrapped.
assert.equal(cdpEndpointUrl("[::1]", 9222), "http://[::1]:9222/json/version");
assert.throws(() => cdpEndpointUrl("127.0.0.1", 0), /CDP port/);

// The conflict rule is the safety behaviour of this whole change. It lives in a
// pure function so it is testable without shelling out to npm/agent-browser.
{
	const launchEntry = {
		path: "/home/u/.pi/agent/mcp.json",
		server: { command: "agent-browser", args: ["mcp"] },
	};
	const attach9222 = {
		path: "/home/u/.pi/agent/mcp.json",
		server: { command: "agent-browser", args: ["--cdp", "9222", "mcp"] },
	};

	// No port requested: whatever the user has stays, in either mode.
	assert.deepEqual(resolveExistingEntryDecision(launchEntry, null), {
		action: "keep",
		target: { mode: "launch", port: null },
	});
	assert.equal(resolveExistingEntryDecision(attach9222, null).action, "keep");

	// Requested port already in place: idempotent, not a conflict.
	assert.equal(resolveExistingEntryDecision(attach9222, 9222).action, "keep");

	// Requested port the existing entry cannot satisfy: loud, never a silent
	// no-op, and never an overwrite.
	for (const [entry, requested] of [
		[launchEntry, 9222],
		[attach9222, 9333],
	]) {
		const decision = resolveExistingEntryDecision(entry, requested);
		assert.equal(decision.action, "conflict");
		assert.match(decision.message, /--attach-cdp-port/);
		assert.match(decision.message, /never rewritten/);
		assert.ok(
			decision.message.includes(entry.path),
			"the conflict must name the config file the user has to edit",
		);
	}
}

// A requested attach port must reach the merged config.
{
	const merged = mergeAgentBrowserMcpConfig({}, { cdpPort: 9222 });
	assert.deepEqual(merged.mcpServers[AGENT_BROWSER_MCP_SERVER].args, [
		"--cdp",
		"9222",
		"mcp",
	]);
}
// ...but an entry the user already owns still wins, in either shape.
for (const args of [["mcp", "--tools", "core"], ["--cdp", "9333", "mcp"]]) {
	const existing = {
		mcpServers: { [AGENT_BROWSER_MCP_SERVER]: { command: "agent-browser", args } },
	};
	assert.deepEqual(
		mergeAgentBrowserMcpConfig(existing, { cdpPort: 9222 }),
		existing,
		`existing ${args.join(" ")} entry survives a --attach-cdp-port install`,
	);
}

// --- CDP reachability probe -----------------------------------------------------
//
// A config entry only says which port to dial. Without this probe an unreachable
// CDP endpoint surfaces as a failed browser call in the middle of a Peer turn
// instead of as a host-readiness failure.
{
	const server = createServer((req, res) => {
		if (req.url === "/json/version") {
			res.writeHead(200, { "Content-Type": "application/json" });
			res.end(JSON.stringify({ Browser: "Chrome/141.0.0.0", "Protocol-Version": "1.3" }));
			return;
		}
		res.writeHead(404).end("nope");
	});
	await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
	const { port } = server.address();

	const reachable = await probeCdpEndpoint({ port, timeoutMs: 2000 });
	assert.equal(reachable.ok, true);
	assert.match(reachable.browser, /Chrome\/141/);

	await new Promise((resolve) => server.close(resolve));

	const unreachable = await probeCdpEndpoint({ port, timeoutMs: 500 });
	assert.equal(unreachable.ok, false);
	assert.ok(unreachable.error.length > 0, "an unreachable probe explains itself");
}
// Garbage on the port is not a CDP endpoint.
{
	const server = createServer((_req, res) => {
		res.writeHead(200, { "Content-Type": "text/html" }).end("<html>hi</html>");
	});
	await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
	const { port } = server.address();
	const probe = await probeCdpEndpoint({ port, timeoutMs: 2000 });
	assert.equal(probe.ok, false);
	await new Promise((resolve) => server.close(resolve));
}
// The probe must actually work over IPv6, not just format the URL correctly.
{
	const server = createServer((req, res) => {
		if (req.url === "/json/version") {
			res.writeHead(200, { "Content-Type": "application/json" });
			res.end(JSON.stringify({ Browser: "Chrome/141.0.0.0" }));
			return;
		}
		res.writeHead(404).end("nope");
	});
	const listening = await new Promise((resolve) => {
		server.once("error", () => resolve(false));
		server.listen(0, "::1", () => resolve(true));
	});
	assert.ok(listening, "IPv6 loopback must be available to exercise the probe");
	const { port } = server.address();
	const probe = await probeCdpEndpoint({ host: "::1", port, timeoutMs: 2000 });
	assert.equal(probe.ok, true, "probeCdpEndpoint must reach an IPv6 endpoint");
	await new Promise((resolve) => server.close(resolve));
}

console.log("[paseo-team] browser setup tests passed");

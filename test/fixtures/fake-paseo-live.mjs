#!/usr/bin/env node
// fake-paseo-live.mjs — a paseo stand-in for the live-plane CLI tests
// (agents / permits / graph).
//
// Separate from fake-paseo.mjs on purpose: that one echoes argv back for the
// remote-paseo wrapper tests, while these tests need CLI-shaped *results*.
// Returning real shapes here would have broken the echo assertions there.

const argv = process.argv.slice(2).filter((part) => part !== "--json");
const say = (value) => {
	console.log(JSON.stringify(value));
	process.exit(0);
};

const AGENTS = [
	{ id: "11111111-1111-1111-1111-111111111111", shortId: "1111111", name: "supervisor", provider: "pi-supervisor/o/m", thinking: "medium", status: "idle", cwd: "/w", created: "1 day ago" },
	{ id: "22222222-2222-2222-2222-222222222222", shortId: "2222222", name: "lead", provider: "pi-lead/o/m", thinking: "high", status: "running", cwd: "/w", created: "1 hour ago" },
	{ id: "33333333-3333-3333-3333-333333333333", shortId: "3333333", name: "peer", provider: "pi-peer/o/m", thinking: "high", status: "running", cwd: "/w", created: "5 min ago" },
];

const PARENTS = {
	"11111111-1111-1111-1111-111111111111": null,
	"22222222-2222-2222-2222-222222222222": "11111111-1111-1111-1111-111111111111",
	"33333333-3333-3333-3333-333333333333": "22222222-2222-2222-2222-222222222222",
};

if (argv[0] === "ls") say(AGENTS);

if (argv[0] === "inspect") {
	const id = argv[1];
	say({
		Id: id,
		Name: AGENTS.find((agent) => agent.id === id)?.name ?? "unknown",
		Provider: "pi-peer",
		Status: "running",
		PendingPermissions: [],
		ParentAgentId: PARENTS[id] ?? null,
	});
}

if (argv[0] === "permit" && argv[1] === "ls") {
	say(
		process.env.FAKE_PERMITS === "1"
			? [{ agentId: "33333333-3333-3333-3333-333333333333", requestId: "req-1", tool: "write" }, { mystery: true }]
			: [],
	);
}

if (argv[0] === "permit" && (argv[1] === "allow" || argv[1] === "deny")) {
	say({ decided: argv[1], agent: argv[2], request: argv[3] });
}

// Provider/model inventory. FAKE_PROVIDER_LS steers the shapes the discovery
// path has to survive: a disabled provider, an unhealthy one, and the
// error-envelope-with-exit-0 that the real paseo CLI emits when the daemon is
// unreachable.
if (argv[0] === "provider" && argv[1] === "ls") {
	if (process.env.FAKE_PROVIDER_LS === "envelope") {
		say({ error: { code: "UNKNOWN_ERROR", message: "Connection timed out" } });
	}
	const claudeEntry =
		process.env.FAKE_PROVIDER_LS === "claude-disabled"
			? { provider: "claude-peer", status: "available", enabled: "Disabled" }
			: process.env.FAKE_PROVIDER_LS === "claude-unhealthy"
				? { provider: "claude-peer", status: "error", enabled: "Enabled" }
				: { provider: "claude-peer", status: "available", enabled: "Enabled" };
	say([
		{ provider: "pi-supervisor", status: "available", enabled: "Enabled" },
		{ provider: "pi-peer", status: "available", enabled: "Enabled" },
		claudeEntry,
	]);
}

if (argv[0] === "provider" && argv[1] === "models") {
	const provider = argv[2];
	if (provider.startsWith("claude-")) {
		say([
			{ id: "claude-opus-5", thinkingOptionIds: ["off", "high", "ultracode"] },
			{ id: "claude-sonnet-5", thinkingOptionIds: ["off", "high"] },
		]);
	}
	say([
		{ id: "testprov/fast-small", thinkingOptionIds: ["off", "low", "minimal"] },
		{ id: "testprov/deep-large", thinkingOptionIds: ["off", "low", "high", "max"] },
	]);
}


if (argv[0] === "send") {
	// The prompt must arrive through a file, never as one giant argv element.
	const fileIndex = argv.indexOf("--prompt-file");
	if (fileIndex < 0) {
		console.error("fake-paseo-live: send without --prompt-file");
		process.exit(1);
	}
	const { readFileSync } = await import("node:fs");
	say({ sent: true, agent: argv[1], body: readFileSync(argv[fileIndex + 1], "utf8") });
}

console.error(`fake-paseo-live: unhandled argv ${argv.join(" ")}`);
process.exit(1);

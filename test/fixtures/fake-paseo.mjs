#!/usr/bin/env node
// fake-paseo.mjs — fake paseo CLI for remote-paseo.mjs tests.
//
// Echoes argv as JSON (with the --host VALUE redacted so tests can assert the
// endpoint never leaks into wrapper output). Recognizes a few commands to
// return CLI-shaped results, and "--fail" to exercise the CLI_ERROR path.

const argv = process.argv.slice(2);

// The endpoint value is redacted in the echo ON PURPOSE: in production the
// real paseo never echoes argv back, so the wrapper's stdout must be free of
// the secret. The fake mimics that so the leak assertion is meaningful.
const shown = [...argv];
{
	const hostIdx = shown.indexOf("--host");
	if (hostIdx >= 0 && hostIdx + 1 < shown.length) {
		shown[hostIdx + 1] = "<host-redacted>";
	}
}

if (argv.includes("--fail")) {
	// Simulate a paseo CLI that leaks the endpoint into its own stderr — the
	// wrapper must redact it from the error it surfaces.
	const hostIdx = argv.indexOf("--host");
	const leaked =
		hostIdx >= 0 && hostIdx + 1 < argv.length ? argv[hostIdx + 1] : "?";
	console.error(`boom: ${leaked}`);
	process.exit(1);
}

if (argv[0] === "run") {
	console.log(
		JSON.stringify({
			agentId: "9f8e7d6c-0000-0000-0000-000000000000",
			status: "running",
			provider: "pi-peer",
			cwd: "/fake/worktree",
			title: argv.includes("--title")
				? argv[argv.indexOf("--title") + 1]
				: null,
		}),
	);
	process.exit(0);
}

if (argv[0] === "inspect") {
	console.log(
		JSON.stringify({
			Id: argv[1],
			Name: "fake-agent",
			Provider: "pi",
			Model: "testprov/model-a",
			Thinking: "low",
			Status: "idle",
		}),
	);
	process.exit(0);
}

console.log(JSON.stringify({ argv: shown }));

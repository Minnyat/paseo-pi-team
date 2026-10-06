#!/usr/bin/env node
// fake-paseo-routing.mjs — a paseo stand-in for `pteam routing` tests.
//
// Answers only the two inventory reads route validation makes, from a JSON file
// named by FAKE_ROUTING_INVENTORY:
//   { "providers": [<provider ls entries>], "models": { "<role-provider>": [<entries>] } }
// A missing file or provider answers the way the real CLI does when the daemon
// is down or the provider is unknown, so the refusal paths are exercised too.

import { readFileSync } from "node:fs";

const argv = process.argv.slice(2).filter((part) => part !== "--json");
const fail = (message) => {
	process.stderr.write(`${message}\n`);
	process.exit(1);
};

let inventory;
try {
	inventory = JSON.parse(readFileSync(process.env.FAKE_ROUTING_INVENTORY ?? "", "utf8"));
} catch {
	fail("Error: daemon not reachable");
}

if (argv[0] === "provider" && argv[1] === "ls") {
	console.log(JSON.stringify(inventory.providers ?? []));
	process.exit(0);
}
if (argv[0] === "provider" && argv[1] === "models") {
	const models = inventory.models?.[argv[2]];
	if (!models) fail(`Error: unknown provider ${argv[2]}`);
	console.log(JSON.stringify(models));
	process.exit(0);
}
fail(`fake-paseo-routing: unsupported command ${argv.join(" ")}`);

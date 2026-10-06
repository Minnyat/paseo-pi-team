import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// `npm ci` trusts package-lock.json: an entry without `integrity` is installed
// without checking the tarball against a hash, and an entry whose `resolved`
// points off the npm registry fetches code from somewhere the lock never
// vouched for. Both used to slip in unnoticed: three nested entries inherited
// from pi-coding-agent's own shrinkwrap shipped without a hash, and nothing
// checked the lock. This runs with the rest of `npm test`, so CI covers it.
const lock = JSON.parse(readFileSync(new URL("../package-lock.json", import.meta.url), "utf8"));
const entries = Object.entries(lock.packages ?? {}).filter(([path, entry]) => path !== "" && !entry.link);
assert.ok(entries.length > 0, "the lockfile lists packages");

const missing = entries.filter(([, entry]) => !/^sha512-[A-Za-z0-9+/]+={0,2}$/.test(entry.integrity ?? ""));
assert.deepEqual(
	missing.map(([path]) => path),
	[],
	"every locked package carries a sha512 integrity hash (if `npm install` stripped one, restore it from `npm view <pkg>@<version> dist.integrity`)",
);

const offRegistry = entries.filter(([, entry]) => entry.resolved && !entry.resolved.startsWith("https://registry.npmjs.org/"));
assert.deepEqual(
	offRegistry.map(([path, entry]) => `${path} -> ${entry.resolved}`),
	[],
	"every locked package resolves over https from registry.npmjs.org (no git, http, file or credential-bearing URLs)",
);

const withCredentials = entries.filter(([, entry]) => /\/\/[^/]*@/.test(entry.resolved ?? ""));
assert.deepEqual(withCredentials.map(([path]) => path), [], "no resolved URL embeds userinfo");

console.log("lockfile-integrity tests passed");

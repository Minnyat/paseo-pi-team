import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// The SPA is one ES module: a `$("id")` that resolves to null throws at module
// scope, the boot never reaches selectTab(), and the whole page freezes on its
// placeholder markup with nothing in the console for a user to act on. That
// happened once with a leftover "graph-rooms" listener, so the ids the client
// reaches for are checked against the document that has to provide them.
const PUBLIC_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "webui", "public");
const html = readFileSync(join(PUBLIC_DIR, "index.html"), "utf8");

const declared = new Set([...html.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]));

for (const file of ["app.js", "config-form.js", "humanize.js"]) {
	const source = readFileSync(join(PUBLIC_DIR, file), "utf8");
	for (const [, id] of source.matchAll(/\$\("([^"]+)"\)/g)) {
		assert.ok(declared.has(id), `${file} looks up #${id}, which index.html never declares`);
	}
}

// The tab buttons and the panes they reveal are two separate id spaces
// (data-tab="x" -> #tab-x); a rename on one side alone leaves a tab that
// selects nothing.
for (const [, tab] of html.matchAll(/data-tab="([^"]+)"/g)) {
	assert.ok(declared.has(`tab-${tab}`), `a tab button targets "${tab}" but #tab-${tab} does not exist`);
}

console.log("webui-dom tests passed");

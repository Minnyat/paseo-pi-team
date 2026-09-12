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

// The section dropdown is hand-written markup while the sections themselves
// live in two other files. A new section that nobody added an <option> for is
// reachable by URL and by the CLI but invisible in the browser — which is how
// "Kho model Pi" shipped unreachable the first time.
{
	const { CONFIG_SECTIONS } = await import("../webui/server.mjs");
	const { schemaForSection } = await import("../cli/lib/config-schema.mjs");

	// Scope to THIS select: the roles dropdown has its own options, and a
	// document-wide scan would compare "supervisor" against config sections.
	const block = /<select id="config-section"[\s\S]*?<\/select>/.exec(html);
	assert.ok(block, "the config section dropdown still exists");
	const offered = [...block[0].matchAll(/<option value="([^"]+)"/g)].map((m) => m[1]);
	assert.ok(offered.length > 0, "and it still offers sections");
	for (const value of offered) {
		assert.ok(CONFIG_SECTIONS.includes(value), `the form offers section "${value}", which the server would 400`);
	}

	// "paseo" is deliberately absent: it is the same file as "providers", and
	// offering both would put one document behind two entries.
	const ALIASED = new Set(["paseo"]);
	for (const section of CONFIG_SECTIONS) {
		if (ALIASED.has(section) || !schemaForSection(section)) continue;
		assert.ok(offered.includes(section), `section "${section}" has a form schema but no <option> to reach it`);
	}
}

console.log("webui-dom tests passed");

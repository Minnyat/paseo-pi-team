// install-drift.test.mjs — "do the installed copies match this release?"
//
// The failure this guards is quiet by construction: `npm i -g` refreshes the
// CLI, the copies under ~/.pi/agent stay put, and both halves then report the
// same version number while enforcing different rules. So the test installs a
// pack into a throwaway HOME, asserts a clean install is silent, and then
// reproduces each way an install can go stale.

import assert from "node:assert/strict";
import {
	appendFileSync,
	cpSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

const piHome = mkdtempSync(join(tmpdir(), "paseo-drift-pi-"));
const claudeHome = mkdtempSync(join(tmpdir(), "paseo-drift-claude-"));
process.env.PI_HOME = piHome;
delete process.env.PI_CODING_AGENT_DIR;

// Imported AFTER the env is set: config-walker resolves paths per call, but
// reading the module with the developer's real HOME in scope is the kind of
// test that edits the machine it runs on.
const { installDrift, summarizeDrift } = await import("../cli/lib/install-drift.mjs");

const extDir = join(piHome, "agent", "extensions");
const skillsDir = join(piHome, "agent", "skills");
const coreDir = join(extDir, "paseo-team-core");
const scriptsDir = join(extDir, "paseo-team-scripts");

const drift = (env) => installDrift({ env: env ?? { ...process.env } }).drift;
const verdicts = (items, kind) =>
	items.filter((item) => item.kind === kind).map((item) => `${item.file}:${item.verdict}`);

// An install that never happened is every file missing — the honest answer, and
// the one the caller special-cases into a single "not installed" line.
{
	const initial = drift();
	assert.ok(initial.length > 0);
	assert.ok(
		initial.every((item) => item.verdict === "missing"),
		"an absent install reports missing, never changed or unexpected",
	);
}

// --- a faithful install, performed exactly the way scripts/install.sh does ----

function install() {
	mkdirSync(join(extDir, "prompts"), { recursive: true });
	mkdirSync(skillsDir, { recursive: true });
	cpSync(join(root, "extensions", "paseo-team-policy.ts"), join(extDir, "paseo-team-policy.ts"));
	rmSync(coreDir, { recursive: true, force: true });
	cpSync(join(root, "extensions", "paseo-team-core"), coreDir, { recursive: true });
	// install.sh deletes the built .js from the target: every loader prefers
	// .js, so an installed pair would let pi read the current rules while the
	// Claude hook reads stale ones.
	for (const name of ["policy-core", "claude-policy", "agent-directory"]) {
		rmSync(join(coreDir, `${name}.js`), { force: true });
	}
	for (const role of ["lead", "peer", "supervisor"]) {
		cpSync(join(root, "prompts", `${role}.md`), join(extDir, "prompts", `${role}.md`));
	}
	for (const name of ["paseo-team-lead", "paseo-ocr-reviewer"]) {
		rmSync(join(skillsDir, name), { recursive: true, force: true });
		cpSync(join(root, "skills", name), join(skillsDir, name), { recursive: true });
	}
	rmSync(scriptsDir, { recursive: true, force: true });
	mkdirSync(scriptsDir, { recursive: true });
	for (const file of supportFiles()) {
		cpSync(join(root, "scripts", file), join(scriptsDir, file));
	}
}

/** The installers own the list; read it from install.sh rather than repeat it. */
function supportFiles() {
	const text = readFileSync(join(root, "scripts", "install.sh"), "utf8");
	const start = text.indexOf("TEAM_SUPPORT_FILES=(");
	assert.ok(start >= 0, "install.sh must still declare TEAM_SUPPORT_FILES");
	const end = text.indexOf("\n)", start);
	const files = [...text.slice(start, end).matchAll(/^\s*([a-z0-9-]+\.mjs)\s*$/gm)].map(
		(m) => m[1],
	);
	assert.ok(files.length >= 4, "install.sh support-file list did not parse");
	return files;
}

install();
assert.deepEqual(drift(), [], "a faithful install reports no drift at all");
assert.deepEqual(summarizeDrift([]), []);

// --- the three ways an install goes stale ------------------------------------

// 1. A file edited in place, or left behind by an older release. This is the
//    one the policy-core load check cannot see: it still loads, still exports
//    the same API, and enforces different rules.
appendFileSync(join(coreDir, "policy-core.ts"), "\n// left over from an older release\n");
assert.deepEqual(verdicts(drift(), "policy-core"), ["policy-core.ts:changed"]);

// 2. A file this release ships that the install does not have.
rmSync(join(skillsDir, "paseo-ocr-reviewer", "SKILL.md"));
assert.deepEqual(verdicts(drift(), "skill"), ["paseo-ocr-reviewer/SKILL.md:missing"]);

// 3. A file the installers no longer ship, still sitting in a directory this
//    pack owns and replaces wholesale.
writeFileSync(join(scriptsDir, "retired-helper.mjs"), "from an older release");
assert.deepEqual(verdicts(drift(), "support-script"), ["retired-helper.mjs:unexpected"]);

// A built .js in the policy core is drift in its own right, for the reason
// install.sh deletes it: two sources of truth for one rule set, and the two
// runtimes would not agree on which they read.
install();
cpSync(join(root, "extensions", "paseo-team-core", "policy-core.js"), join(coreDir, "policy-core.js"));
assert.deepEqual(verdicts(drift(), "policy-core"), ["policy-core.js:unexpected"]);

// The prompts directory is SHARED with whatever else the user keeps under
// ~/.pi/agent/extensions/prompts/, so a file we did not install is not ours to
// call a leftover.
install();
writeFileSync(join(extDir, "prompts", "someone-elses.md"), "not ours");
assert.deepEqual(drift(), [], "an unknown file in the shared prompts dir is not drift");

// --- the Claude copies -------------------------------------------------------
//
// Checked only when that side was installed at all: a pi-only host is a
// supported configuration, and two permanently-missing skill packages there
// would be noise rather than a finding.
{
	install();
	const env = { ...process.env, CLAUDE_CONFIG_DIR: join(claudeHome, ".claude") };
	assert.deepEqual(drift(env), [], "no Claude install means nothing to compare");

	const claudeSkills = join(claudeHome, ".claude", "skills");
	mkdirSync(claudeSkills, { recursive: true });
	cpSync(join(root, "skills", "paseo-team-lead"), join(claudeSkills, "paseo-team-lead"), {
		recursive: true,
	});
	assert.deepEqual(drift(env), [], "a current Claude copy is not drift either");

	appendFileSync(join(claudeSkills, "paseo-team-lead", "SKILL.md"), "\nstale\n");
	assert.deepEqual(verdicts(drift(env), "claude-skill"), ["paseo-team-lead/SKILL.md:changed"]);
}

// --- CRLF is not a version difference ----------------------------------------
//
// The repo pins LF, but a file copied by PowerShell and re-saved by an editor
// comes back with CRLF. Reporting that as drift would make the check cry wolf
// on every Windows host.
{
	install();
	const promptPath = join(extDir, "prompts", "lead.md");
	writeFileSync(promptPath, readFileSync(promptPath, "utf8").replace(/\n/g, "\r\n"));
	assert.deepEqual(drift(), [], "a CRLF copy of the same content is not drift");
}

// --- the summary stays readable ----------------------------------------------
{
	rmSync(coreDir, { recursive: true, force: true });
	const lines = summarizeDrift(drift(), { perKind: 2 });
	assert.ok(lines.some((line) => line.startsWith("policy-core: ")));
	assert.ok(
		lines.every((line) => line.length < 200),
		"the summary is a preflight line, not a file listing",
	);
	assert.match(summarizeDrift(drift(), { perKind: 1 }).join("\n"), /\+\d+ more/);
}

rmSync(piHome, { recursive: true, force: true });
rmSync(claudeHome, { recursive: true, force: true });
console.log("install drift tests passed");

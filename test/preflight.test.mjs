// preflight.test.mjs — the checks preflight reports, and at what severity.
//
// Until this file existed, `scripts/preflight.mjs` — 1,100 lines, and the one
// surface an operator actually reads before routing work — was never executed
// by any test. Mutation testing made the cost concrete: deleting the
// workspace-protocol block entirely, deleting the install-drift block entirely,
// downgrading an invalid protocol from `fail` to `warn`, and making `--strict`
// stop failing on drift ALL passed the full suite. Every module preflight calls
// was well covered; the file that decides which of them runs, and what a
// finding is worth, was not covered at all.
//
// That is what this pins: not the pure functions underneath, but presence,
// severity and the escalation `--strict` promises. Checks that depend on a real
// daemon, provider or model inventory are deliberately not asserted — this host
// has none, and the point is the decision layer, not the environment.

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
	chmodSync,
	cpSync,
	mkdirSync,
	mkdtempSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { installerSupportFiles } from "../cli/lib/install-drift.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

// The stubs are executable node scripts on PATH. Windows resolves
// executables by extension and `tryExec` routes through a shell there, so the
// same trick needs .cmd shims and a different quoting path — a second
// implementation of the harness to test the same platform-independent branch.
// The decision layer under test has no platform-specific code, so this runs on
// POSIX and says so rather than shipping a shim nobody would maintain.
const POSIX = process.platform !== "win32";

const home = mkdtempSync(join(tmpdir(), "paseo-preflight-"));
const binDir = join(home, "bin");
const repo = join(home, "repo");
const piHome = join(home, "pi");
const extDir = join(piHome, "agent", "extensions");
const skillsDir = join(piHome, "agent", "skills");
mkdirSync(binDir, { recursive: true });
mkdirSync(repo, { recursive: true });

/**
 * A `git` that answers only what preflight asks. Anything else exits 64, so an
 * unexpected argv can never be mistaken for success — the same rule
 * test/fixtures/fake-git.mjs follows.
 */
function writeGitStub() {
	// Absolute shebang, not `/usr/bin/env node`: PATH is deliberately trimmed to
	// the stub directory so an absent CLI fails fast instead of finding the
	// developer's real one, and `env` would then have no node to resolve.
	const script = `#!${process.execPath}
const argv = process.argv.slice(2);
const at = (i) => argv[i] ?? "";
if (at(0) === "--version") { process.stdout.write("git version 2.99.0\\n"); process.exit(0); }
if (at(0) === "rev-parse" && at(1) === "--is-inside-work-tree") { process.stdout.write("true\\n"); process.exit(0); }
if (at(0) === "rev-parse" && at(1) === "--show-toplevel") { process.stdout.write(process.env.FAKE_REPO_ROOT + "\\n"); process.exit(0); }
if (at(0) === "status" && at(1) === "--porcelain") { process.stdout.write(""); process.exit(0); }
process.stderr.write("fake git: unsupported argv " + JSON.stringify(argv) + "\\n");
process.exit(64);
`;
	const path = join(binDir, "git");
	writeFileSync(path, script);
	chmodSync(path, 0o755);
}

/** A faithful install, performed the way scripts/install.sh does. */
function install() {
	mkdirSync(join(extDir, "prompts"), { recursive: true });
	mkdirSync(skillsDir, { recursive: true });
	cpSync(join(root, "extensions", "paseo-team-policy.ts"), join(extDir, "paseo-team-policy.ts"));
	const coreDir = join(extDir, "paseo-team-core");
	rmSync(coreDir, { recursive: true, force: true });
	cpSync(join(root, "extensions", "paseo-team-core"), coreDir, { recursive: true });
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
	const scriptsDir = join(extDir, "paseo-team-scripts");
	rmSync(scriptsDir, { recursive: true, force: true });
	mkdirSync(scriptsDir, { recursive: true });
	for (const file of installerSupportFiles(root) ?? []) {
		cpSync(join(root, "scripts", file), join(scriptsDir, file));
	}
}

/** Run preflight against the fake host and return its parsed report. */
function preflight(extraArgs = []) {
	let stdout = "";
	let status = 0;
	try {
		stdout = execFileSync(
			process.execPath,
			[join(root, "scripts", "preflight.mjs"), "--json", "--skip-models", "--runtime", "pi", ...extraArgs],
			{
				cwd: repo,
				encoding: "utf8",
				timeout: 120_000,
				stdio: ["ignore", "pipe", "pipe"],
				env: {
					...process.env,
					PATH: binDir,
					PI_HOME: piHome,
					PST_TEAM_CONFIG_DIR: home,
					CLAUDE_CONFIG_DIR: join(home, ".claude"),
					PASEO_CONFIG_JSON: join(home, "paseo-config.json"),
					FAKE_REPO_ROOT: repo,
				},
			},
		);
	} catch (error) {
		// A non-zero exit is expected on this host: there is no daemon, no
		// provider and no model inventory. The report is still on stdout, and it
		// is the report this file is about.
		stdout = String(error?.stdout ?? "");
		status = error?.status ?? 1;
	}
	const report = JSON.parse(stdout);
	return {
		status,
		checks: report.checks,
		of: (id) => report.checks.find((check) => check.id === id),
	};
}

const PROTOCOL = [
	"# Workspace Protocol",
	"",
	"WORKSPACE_PROTOCOL_VERSION: 1",
	"PROJECT_ID: demo",
	"",
].join("\n");
const protocolPath = join(repo, "WORKSPACE_PROTOCOL.md");

if (POSIX) writeGitStub();

// --- the report is a report ---------------------------------------------------

test("preflight emits a JSON report with unique check ids", { skip: !POSIX }, () => {
	const run = preflight();
	assert.ok(Array.isArray(run.checks) && run.checks.length > 5);
	const ids = run.checks.map((check) => check.id);
	assert.deepEqual(
		[...new Set(ids)].length,
		ids.length,
		"a duplicated id means one check silently overwrites another in any consumer keyed by id",
	);
	for (const check of run.checks) {
		assert.ok(["pass", "warn", "fail"].includes(check.status), `${check.id}: ${check.status}`);
	}
});

// --- workspace-protocol -------------------------------------------------------
//
// The severity split is the whole point, so it is asserted rather than assumed:
// `missing` is a fact a Lead can act on, while a protocol carrying an
// unresolved conflict is WORSE than absent — the Lead opens it and reads both
// sides of the conflict as rules.

test("workspace-protocol: missing warns, and names the template", { skip: !POSIX }, () => {
	rmSync(protocolPath, { force: true });
	const check = preflight().of("workspace-protocol");
	assert.ok(check, "the check must run inside a repository at all");
	assert.equal(check.status, "warn");
	assert.match(check.detail, /WORKSPACE_PROTOCOL\.example\.md/);
});

test("workspace-protocol: a valid protocol passes, with its digest", { skip: !POSIX }, () => {
	writeFileSync(protocolPath, PROTOCOL);
	const check = preflight().of("workspace-protocol");
	assert.equal(check.status, "pass");
	assert.match(check.detail, /\(v1, [0-9a-f]{12}\)/);
});

test("workspace-protocol: an unresolved conflict FAILS, not warns", { skip: !POSIX }, () => {
	writeFileSync(
		protocolPath,
		["WORKSPACE_PROTOCOL_VERSION: 1", "<<<<<<< HEAD", "PROJECT_ID: a", "=======", "PROJECT_ID: b", ">>>>>>> x"].join("\n"),
	);
	const run = preflight();
	const check = run.of("workspace-protocol");
	assert.equal(check.status, "fail", "a misleading protocol is not a warning");
	assert.match(check.detail, /merge conflict/);
	assert.equal(run.status, 1, "and a failing check means a non-zero exit");
});

test("workspace-protocol: a legacy-path protocol warns rather than passing", { skip: !POSIX }, () => {
	rmSync(protocolPath, { force: true });
	mkdirSync(join(repo, ".orchestration"), { recursive: true });
	writeFileSync(join(repo, ".orchestration", "WORKSPACE_PROTOCOL.md"), PROTOCOL);
	const check = preflight().of("workspace-protocol");
	assert.equal(check.status, "warn", "the Lead reads the root, so this is not a pass");
	assert.match(check.detail, /LEGACY/);
	rmSync(join(repo, ".orchestration"), { recursive: true, force: true });
	writeFileSync(protocolPath, PROTOCOL);
});

// --- install-drift ------------------------------------------------------------

test("install-drift: no install at all is one line, not a file listing", { skip: !POSIX }, () => {
	rmSync(piHome, { recursive: true, force: true });
	const check = preflight().of("install-drift");
	assert.ok(check, "the check must run");
	assert.equal(check.status, "warn");
	assert.match(check.detail, /not installed for this user/);
});

test("install-drift: a faithful install passes", { skip: !POSIX }, () => {
	install();
	const check = preflight().of("install-drift");
	assert.equal(check.status, "pass", check.detail);
});

test("install-drift: a stale copy names the file, and --strict FAILS on it", { skip: !POSIX }, () => {
	install();
	writeFileSync(
		join(extDir, "paseo-team-core", "policy-core.ts"),
		`${"// left over from an older release\n"}`,
	);

	const lax = preflight().of("install-drift");
	assert.equal(lax.status, "warn", "drift is a warning by default");
	assert.match(lax.detail, /policy-core\.ts \(changed\)/, "the filename is what makes it actionable");
	assert.doesNotMatch(
		lax.detail,
		/not installed for this user/,
		"a stale install is not an absent one — that message suppresses the filename",
	);

	const strict = preflight(["--strict"]).of("install-drift");
	assert.equal(
		strict.status,
		"fail",
		"--strict exists to reject exactly this: the rules a running agent enforces are not the rules this CLI reports",
	);
	install();
});

test("install-drift: a customised prompt says what the remedy costs", { skip: !POSIX }, () => {
	install();
	const promptPath = join(extDir, "prompts", "lead.md");
	writeFileSync(promptPath, `${PROTOCOL}\n## Local house rule\n`);
	const check = preflight().of("install-drift");
	assert.equal(check.status, "warn");
	assert.match(check.detail, /lead\.md \(changed\)/);
	assert.match(
		check.detail,
		/OVERWRITES/,
		"`pteam prompts write` is a first-class command; a check that tells someone to destroy their own edit without saying so is worse than one that says nothing",
	);
	install();
});

test.after(() => rmSync(home, { recursive: true, force: true }));

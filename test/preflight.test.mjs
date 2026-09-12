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
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { installerSupportFiles } from "../cli/lib/install-drift.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

// Read the pins out of preflight rather than repeating them: a version bump
// must not silently turn a "this passes" test into a "this warns" one, and a
// duplicated constant here would do exactly that.
const preflightSource = readFileSync(join(root, "scripts", "preflight.mjs"), "utf8");
const pin = (name) => {
	const found = new RegExp(`${name}:\\s*"([^"]+)"`).exec(preflightSource)?.[1];
	assert.ok(found, `could not read the ${name} pin out of preflight.mjs`);
	return found;
};
const PINNED_PASEO = pin("paseo");
const PINNED_PI = pin("pi");
const PINNED_ADAPTER = pin("adapter");

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
 * The CLIs preflight shells out to, as stubs on a trimmed PATH.
 *
 * Every one answers ONLY the argv preflight actually sends and exits 64 on
 * anything else, so an argv this pack stops sending — or starts sending
 * differently — shows up as a broken stub rather than as a silent pass. Same
 * rule test/fixtures/fake-git.mjs already follows.
 *
 * Each stub reads its answers from the environment, so one set of files serves
 * every scenario and a test says what it is changing by naming the variable.
 *
 * Absolute shebang, not `/usr/bin/env node`: PATH is trimmed to this directory
 * precisely so an absent CLI fails fast instead of finding the developer's
 * real one, and `env` would then have no node to resolve.
 */
function stub(name, body) {
	const path = join(binDir, name);
	writeFileSync(path, `#!${process.execPath}\nconst argv = process.argv.slice(2);\nconst at = (i) => argv[i] ?? "";\nconst env = process.env;\n${body}\nprocess.stderr.write("fake ${name}: unsupported argv " + JSON.stringify(argv) + "\\n");\nprocess.exit(64);\n`);
	chmodSync(path, 0o755);
}

function writeStubs() {
	stub(
		"git",
		`
if (at(0) === "--version") { process.stdout.write("git version 2.99.0\\n"); process.exit(0); }
if (at(0) === "rev-parse" && at(1) === "--is-inside-work-tree") { process.stdout.write("true\\n"); process.exit(0); }
if (at(0) === "rev-parse" && at(1) === "--show-toplevel") { process.stdout.write(env.FAKE_REPO_ROOT + "\\n"); process.exit(0); }
if (at(0) === "status" && at(1) === "--porcelain") { process.stdout.write(env.FAKE_GIT_DIRTY ?? ""); process.exit(0); }`,
	);
	stub(
		"paseo",
		`
if (at(0) === "--version") { process.stdout.write((env.FAKE_PASEO_VERSION ?? "${PINNED_PASEO}") + "\\n"); process.exit(0); }
if (at(0) === "status" && at(1) === "--json") {
  if (env.FAKE_DAEMON_DOWN) { process.stderr.write("daemon unreachable\\n"); process.exit(1); }
  process.stdout.write(env.FAKE_PASEO_STATUS ?? JSON.stringify({ localDaemon: "running", listen: "127.0.0.1:6767" }));
  process.exit(0);
}
if (at(0) === "provider" && at(1) === "ls" && at(2) === "--json") {
  process.stdout.write(env.FAKE_PROVIDERS ?? "[]"); process.exit(0);
}
if (at(0) === "provider" && at(1) === "models" && at(3) === "--json") {
  const key = "FAKE_MODELS_" + at(2).replace(/[^A-Za-z0-9]/g, "_").toUpperCase();
  const body = env[key] ?? env.FAKE_MODELS;
  if (body === undefined) { process.stderr.write("no inventory\\n"); process.exit(1); }
  process.stdout.write(body); process.exit(0);
}`,
	);
	stub(
		"pi",
		`
if (at(0) === "--version") {
  if (env.FAKE_NO_PI) process.exit(127);
  process.stdout.write((env.FAKE_PI_VERSION ?? "${PINNED_PI}") + "\\n"); process.exit(0);
}
if (at(0) === "list") { process.stdout.write(env.FAKE_PI_LIST ?? "pi-mcp-adapter\\n"); process.exit(0); }`,
	);
	stub(
		"ocr",
		`
if (at(0) === "version") {
  if (env.FAKE_NO_OCR) process.exit(127);
  process.stdout.write("open-code-review v" + (env.FAKE_OCR_VERSION ?? "1.9.2") + "\\n"); process.exit(0);
}
if (at(0) === "delegate" && at(2) === "--help") { process.stdout.write("--repo --from\\n"); process.exit(0); }`,
	);
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
function preflight(extraArgs = [], extraEnv = {}) {
	let stdout = "";
	let status = 0;
	// `--with-models` is this harness's own flag, not preflight's: almost every
	// test wants the fast path, and the few that are ABOUT the model inventory
	// have to switch it off. It is stripped before preflight sees it.
	const withModels = extraArgs.includes("--with-models");
	const args = extraArgs.filter((arg) => arg !== "--with-models");
	const baseArgs = [
		"--json",
		...(withModels ? [] : ["--skip-models"]),
		...(args.includes("--runtime") ? [] : ["--runtime", "pi"]),
	];
	try {
		stdout = execFileSync(
			process.execPath,
			[join(root, "scripts", "preflight.mjs"), ...baseArgs, ...args],
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
					...extraEnv,
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

if (POSIX) writeStubs();

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

// --- the installed-pack checks resolve the paths the INSTALLERS write to -----
//
// Found by trying to test this layer. install.sh and install.ps1 both honour
// PI_HOME and PI_CODING_AGENT_DIR; preflight hardcoded ~/.pi/agent in five
// places. On a host with either override set, `extension`, `policy-core` and
// `role-prompts` all reported missing on a correctly installed pack — three
// false failures and a non-zero exit — while `install-drift`, which resolved
// through the walker, called the same host healthy. Two halves of one command
// disagreeing, and the failing half naming a path the installer never wrote to.

test("the pack checks honour PI_CODING_AGENT_DIR, like the installers", { skip: !POSIX }, () => {
	install();
	for (const id of ["extension", "policy-core", "role-prompts", "install-drift"]) {
		const check = preflight().of(id);
		assert.equal(check.status, "pass", `${id}: ${check.detail}`);
	}
	// And when it is wrong, it says WHICH path — the override, not ~/.pi.
	const elsewhere = join(home, "nowhere", "agent");
	const check = preflight([], { PI_CODING_AGENT_DIR: elsewhere }).of("extension");
	assert.equal(check.status, "fail");
	assert.ok(
		check.detail.startsWith(elsewhere),
		`must name the configured agent dir, said: ${check.detail}`,
	);
});

test("policy-core present but unparseable FAILS, and says why it matters", { skip: !POSIX }, () => {
	install();
	// Presence is not enough: pi's extension loader SWALLOWS an import failure
	// and starts with no policy at all, so a core that is present and broken
	// looks identical to a healthy install until a Peer runs unrestricted.
	writeFileSync(
		join(extDir, "paseo-team-core", "policy-core.ts"),
		"export const broken = (;\n",
	);
	const check = preflight().of("policy-core");
	assert.equal(check.status, "fail");
	assert.match(check.detail, /NO policy/);
	install();
});

test("role-prompts names the roles that are missing", { skip: !POSIX }, () => {
	install();
	rmSync(join(extDir, "prompts", "peer.md"));
	const check = preflight().of("role-prompts");
	assert.equal(check.status, "fail");
	assert.match(check.detail, /peer/);
	assert.doesNotMatch(check.detail, /lead/, "only the absent ones");
	install();
});

// --- runtime selection --------------------------------------------------------

test("runtime: an unknown --runtime fails instead of guessing", { skip: !POSIX }, () => {
	const run = preflight(["--runtime", "sonnet"]);
	const check = run.of("runtime");
	assert.equal(check.status, "fail");
	assert.match(check.detail, /pi\|claude\|both/);
	assert.equal(run.status, 1);
});

test("runtime: a pi-only host does not fail on Claude bits", { skip: !POSIX }, () => {
	install();
	const run = preflight(["--runtime", "pi"]);
	assert.equal(run.of("runtime").detail, "pi");
	assert.equal(run.of("claude-cli"), undefined, "a pi host must not be asked for claude");
	assert.equal(run.of("claude-hooks"), undefined);
	// …and the mirror image: asking for claude on a host without it fails the
	// CLAUDE check, not the pi one.
	const claudeRun = preflight(["--runtime", "claude"]);
	assert.equal(claudeRun.of("claude-cli").status, "fail");
	assert.equal(claudeRun.of("pi-cli"), undefined);
});

test("runtime: auto-detection reports what is installed", { skip: !POSIX }, () => {
	assert.equal(preflight([]).of("runtime").detail, "pi", "the stub host has pi only");
	// With no runtime CLI at all it still reports the pi gaps rather than
	// silently checking nothing — the historical behaviour, pinned.
	const bare = preflight([], { FAKE_NO_PI: "1" });
	assert.equal(bare.of("runtime").detail, "pi");
	assert.equal(bare.of("pi-cli").status, "fail");
});

// --- version pins are warnings, never failures --------------------------------
//
// A pin is "the version this pack was verified against", not a requirement. A
// pinned-version mismatch that blocked a preflight would make every upstream
// release an outage.

test("a CLI version off the pin warns; the pinned one passes", { skip: !POSIX }, () => {
	install();
	const healthy = preflight();
	assert.equal(healthy.of("paseo-cli").status, "pass");
	assert.equal(healthy.of("pi-cli").status, "pass");

	const drifted = preflight([], { FAKE_PASEO_VERSION: "9.9.9", FAKE_PI_VERSION: "0.1.0" });
	assert.equal(drifted.of("paseo-cli").status, "warn");
	assert.match(drifted.of("paseo-cli").detail, new RegExp(PINNED_PASEO));
	assert.equal(drifted.of("pi-cli").status, "warn");
	assert.match(drifted.of("pi-cli").detail, new RegExp(PINNED_PI));
});

test("mcp-adapter: absent FAILS, present-but-unpinned warns", { skip: !POSIX }, () => {
	install();
	const absent = preflight([], { FAKE_PI_LIST: "something-else\n" }).of("mcp-adapter");
	assert.equal(absent.status, "fail", "Paseo cannot inject MCP tools into pi without it");
	assert.match(absent.detail, new RegExp(PINNED_ADAPTER), "the fix names the pinned version");

	// Installed but the version unreadable is a warning, not a failure: the
	// adapter is there and working, we just cannot name it.
	const check = preflight().of("mcp-adapter");
	assert.equal(check.status, "warn");
	assert.match(check.detail, /unreadable/);
});

test("ocr: below the verified baseline warns, at it passes", { skip: !POSIX }, () => {
	assert.equal(preflight().of("ocr-cli").status, "pass");
	const old = preflight([], { FAKE_OCR_VERSION: "1.8.9" }).of("ocr-cli");
	assert.equal(old.status, "warn");
	assert.match(old.detail, /1\.8\.10 baseline/);
	// Absent is a warning too: an OCR-less host cannot run an independent
	// review, but everything else about it may be fine.
	assert.equal(preflight([], { FAKE_NO_OCR: "1" }).of("ocr-cli").status, "warn");
});

// --- the daemon ---------------------------------------------------------------

test("paseo-daemon: unreachable fails, non-JSON fails, no localDaemon warns", { skip: !POSIX }, () => {
	assert.equal(preflight().of("paseo-daemon").status, "pass");
	assert.equal(preflight([], { FAKE_DAEMON_DOWN: "1" }).of("paseo-daemon").status, "fail");

	const garbage = preflight([], { FAKE_PASEO_STATUS: "not json" }).of("paseo-daemon");
	assert.equal(garbage.status, "fail");
	assert.match(garbage.detail, /did not return JSON/);

	// Answered, but without the field that says a daemon is actually local.
	// That is unverified rather than broken.
	const partial = preflight([], { FAKE_PASEO_STATUS: JSON.stringify({ listen: "x" }) });
	assert.equal(partial.of("paseo-daemon").status, "warn");
});

// --- role providers: "available" is a claim about the provider ----------------

const PROVIDERS = (extra = {}) =>
	JSON.stringify(
		["supervisor", "lead", "peer"].map((role) => ({
			provider: `pi-${role}`,
			enabled: "enabled",
			status: "available",
			...extra,
		})),
	);

test("role-provider: registered, enabled and healthy passes", { skip: !POSIX }, () => {
	const run = preflight(["--with-models"], {
		FAKE_PROVIDERS: PROVIDERS(),
		FAKE_MODELS: JSON.stringify([{ id: "m1" }, { id: "m2" }]),
	});
	for (const role of ["supervisor", "lead", "peer"]) {
		const check = run.of(`role-provider:pi-${role}`);
		assert.equal(check.status, "pass", check.detail);
		assert.match(check.detail, /2 model\(s\)/, "the inventory size is the routable fact");
	}
});

test("role-provider: absent or disabled or unhealthy all FAIL", { skip: !POSIX }, () => {
	const absent = preflight([], { FAKE_PROVIDERS: "[]" }).of("role-provider:pi-lead");
	assert.equal(absent.status, "fail");
	assert.match(absent.detail, /paseo\.providers\.example\.json/, "a pi operator is not sent to claude-setup");

    const disabled = preflight([], {
		FAKE_PROVIDERS: PROVIDERS({ enabled: "disabled" }),
	}).of("role-provider:pi-lead");
	assert.equal(disabled.status, "fail");
	assert.match(disabled.detail, /disabled/);

	// Enabled AND unhealthy is the false pass this check exists for: printing
	// the status next to a tick would read as routable.
	const unhealthy = preflight([], {
		FAKE_PROVIDERS: PROVIDERS({ status: "unauthorized" }),
	}).of("role-provider:pi-lead");
	assert.equal(unhealthy.status, "fail");
	assert.match(unhealthy.detail, /unhealthy/);
});

test("role-provider: an EMPTY inventory warns, and --strict fails it", { skip: !POSIX }, () => {
	// A registered, enabled, healthy provider whose model inventory is empty
	// passes every check above and cannot serve a single create_agent. Observed
	// live on pi-peer, which is why the message says what "available" means.
	const env = { FAKE_PROVIDERS: PROVIDERS(), FAKE_MODELS: "[]" };
	const lax = preflight(["--with-models"], env).of("role-provider:pi-lead");
	assert.equal(lax.status, "warn");
	assert.match(lax.detail, /list_models is EMPTY/);

	const strict = preflight(["--with-models", "--strict"], env).of("role-provider:pi-lead");
	assert.equal(strict.status, "fail", "unverifiable is not a pass in strict mode");

	// An inventory that cannot be READ is a different finding: telling an
	// operator to go check credentials when the daemon simply failed to answer
	// sends them to fix something that is not broken.
	const unreadable = preflight(["--with-models"], {
		FAKE_PROVIDERS: PROVIDERS(),
	}).of("role-provider:pi-lead");
	assert.equal(unreadable.status, "warn");
	assert.match(unreadable.detail, /could not be read/);
	assert.doesNotMatch(unreadable.detail, /EMPTY/);
});

test("role-provider: --skip-models does not pretend to know the inventory", { skip: !POSIX }, () => {
	// --skip-models is everywhere else in this file, so what it means has to be
	// pinned: the provider passes on its own status and the inventory question
	// is not answered at all.
	const check = preflight([], { FAKE_PROVIDERS: PROVIDERS(), FAKE_MODELS: "[]" }).of(
		"role-provider:pi-lead",
	);
	assert.equal(check.status, "pass");
	assert.doesNotMatch(check.detail, /model/);
});

// --- the browser surface both runtimes share ----------------------------------

test("paseo-browser-tools: browserTools disabled FAILS", { skip: !POSIX }, () => {
	const configPath = join(home, "paseo-config.json");
	writeFileSync(configPath, JSON.stringify({ daemon: { browserTools: { enabled: false } } }));
	const check = preflight().of("paseo-browser-tools");
	assert.equal(check.status, "fail", "no seat has a browser on either runtime");
	assert.match(check.detail, /BROWSER_MCP_AUTHORITY/);

	// Absent config is not evidence the browser is off — the default is on.
	rmSync(configPath, { force: true });
	assert.equal(preflight().of("paseo-browser-tools").status, "pass");
});

// --- routing config -----------------------------------------------------------

test("routing-config: an explicit --routes that does not exist FAILS", { skip: !POSIX }, () => {
	// Explicit beats default: being handed a path that is not there is an error,
	// not something to shrug at and skip.
	const check = preflight(["--routes", join(home, "no-such-routes.json")]).of("routing-config");
	assert.equal(check.status, "fail");
	assert.match(check.detail, /explicit --routes/);
});

test("routing-config: absent by default warns, and --strict fails it", { skip: !POSIX }, () => {
	const lax = preflight().of("routing-config");
	assert.equal(lax.status, "warn");
	assert.match(lax.detail, /model-routing\.example\.json/, "the remedy names the template");

	const strict = preflight(["--strict"]).of("routing-config");
	assert.equal(strict.status, "fail", "routing you cannot verify is not routing you can use");
});

// --- repository state ---------------------------------------------------------

test("repo-clean: a dirty tree warns about user-owned changes", { skip: !POSIX }, () => {
	assert.equal(preflight().of("repo-clean").status, "pass");
	const dirty = preflight([], { FAKE_GIT_DIRTY: " M src/thing.ts\n" }).of("repo-clean");
	assert.equal(dirty.status, "warn");
	assert.match(dirty.detail, /never be overwritten by agents/);
});

// --- routing: the routes a Lead will actually resolve -------------------------
//
// model-routing.mjs has its own test and sits at ~87%. What was uncovered is
// again the WIRING: whether preflight resolves every MODEL_CLASS at all,
// whether a RoutingError becomes a failure, and whether the two things the
// resolver cannot see — a silently clamped thinking level, and a model class
// nobody checked — are reported.

const ROUTE_MODEL = "prov/model-a";
const routesFile = join(home, "routes.json");
const MODEL_CLASSES = ["MONITOR_ECONOMY", "FAST_READ", "CODING_MEDIUM", "REASONING_HIGH", "REVIEW_HIGH"];

function writeRoutes({ model = ROUTE_MODEL, thinking = "low", provider = "pi-peer" } = {}) {
	writeFileSync(
		routesFile,
		JSON.stringify({
			version: 1,
			hostId: "stub-host",
			routes: Object.fromEntries(
				MODEL_CLASSES.map((cls) => [cls, { paseoProvider: provider, model, thinking }]),
			),
		}),
	);
}

const INVENTORY = (thinkingOptions = ["off", "low", "medium", "high"]) =>
	JSON.stringify([{ id: ROUTE_MODEL, thinkingOptions }]);

test("routing-config: a valid file passes and names the hostId", { skip: !POSIX }, () => {
	writeRoutes();
	const check = preflight(["--routes", routesFile]).of("routing-config");
	assert.equal(check.status, "pass");
	assert.match(check.detail, /hostId=stub-host/);
});

test("routing-config: a structurally invalid file FAILS with the reason", { skip: !POSIX }, () => {
	writeFileSync(routesFile, JSON.stringify({ version: 1, routes: {} }));
	const check = preflight(["--routes", routesFile]).of("routing-config");
	assert.equal(check.status, "fail");
	assert.ok(check.detail.length > 10, "the RoutingError message is the actionable part");
	writeRoutes();
});

test("route: every MODEL_CLASS is resolved, not just the first", { skip: !POSIX }, () => {
	// A loop that stopped early would leave a class unrouted and nothing would
	// say so until a Lead asked for it.
	writeRoutes();
	const run = preflight(["--with-models", "--routes", routesFile], {
		FAKE_PROVIDERS: PROVIDERS(),
		FAKE_MODELS: INVENTORY(),
	});
	for (const cls of MODEL_CLASSES) {
		const check = run.of(`route:${cls}`);
		assert.ok(check, `${cls} was never resolved`);
		assert.equal(check.status, "pass", `${cls}: ${check?.detail}`);
	}
});

test("route: a model absent from the inventory FAILS", { skip: !POSIX }, () => {
	writeRoutes({ model: "prov/not-offered" });
	const check = preflight(["--with-models", "--routes", routesFile], {
		FAKE_PROVIDERS: PROVIDERS(),
		FAKE_MODELS: INVENTORY(),
	}).of("route:CODING_MEDIUM");
	assert.equal(check.status, "fail");
	assert.match(check.detail, /not in the inventory/);
	writeRoutes();
});

test("route: an inventory that cannot be read warns, and --strict fails", { skip: !POSIX }, () => {
	writeRoutes();
	const env = { FAKE_PROVIDERS: PROVIDERS() }; // no FAKE_MODELS → exit 1
	const lax = preflight(["--with-models", "--routes", routesFile], env).of("route:FAST_READ");
	assert.equal(lax.status, "warn");
	const strict = preflight(["--with-models", "--strict", "--routes", routesFile], env).of(
		"route:FAST_READ",
	);
	assert.equal(strict.status, "fail");
	assert.match(strict.detail, /unverifiable is not a pass/);
});

test("route: a thinking level pi will silently CLAMP is reported", { skip: !POSIX }, () => {
	// The clamp lives in ~/.pi/agent/models.json and Paseo's own model list does
	// not reflect it, so the resolver cannot see it. thinkingLevelMap.low = null
	// means pi accepts the level and quietly runs something else — the exact
	// shape of silence preflight exists to break.
	install();
	writeRoutes({ thinking: "low" });
	writeFileSync(
		join(piHome, "agent", "models.json"),
		JSON.stringify({
			providers: { prov: { models: [{ id: "model-a", thinkingLevelMap: { low: null } }] } },
		}),
	);
	const env = { FAKE_PROVIDERS: PROVIDERS(), FAKE_MODELS: INVENTORY() };
	const lax = preflight(["--with-models", "--routes", routesFile], env).of("route:FAST_READ");
	assert.equal(lax.status, "warn");
	assert.match(lax.detail, /CLAMP/);
	const strict = preflight(["--with-models", "--strict", "--routes", routesFile], env).of(
		"route:FAST_READ",
	);
	assert.equal(strict.status, "fail");

	// The clamp map is pi-only. A Claude model id has no slash, and splitting
	// one at indexOf("/") === -1 used to yield a truncated provider name and
	// look it up anyway.
	writeRoutes({ provider: "claude-peer", model: "claude-model-x", thinking: "low" });
	const claudeRun = preflight(["--with-models", "--runtime", "both", "--routes", routesFile], {
		FAKE_PROVIDERS: JSON.stringify(
			["supervisor", "lead", "peer"].flatMap((role) =>
				["pi", "claude"].map((family) => ({
					provider: `${family}-${role}`,
					enabled: "enabled",
					status: "available",
				})),
			),
		),
		FAKE_MODELS: JSON.stringify([{ id: "claude-model-x", thinkingOptions: ["off", "low"] }]),
	}).of("route:FAST_READ");
	assert.equal(claudeRun.status, "pass", claudeRun.detail);

	rmSync(join(piHome, "agent", "models.json"), { force: true });
	writeRoutes();
});

test("routes: --skip-models says the inventory was not checked", { skip: !POSIX }, () => {
	// Every other test in this file passes --skip-models, so what it means has
	// to be on the record: the routes are NOT verified, and the report says so
	// rather than leaving the class silently absent.
	writeRoutes();
	const run = preflight(["--routes", routesFile]);
	assert.equal(run.of("routes").status, "warn");
	assert.match(run.of("routes").detail, /skipped/);
	assert.equal(run.of("route:FAST_READ"), undefined);
});

// --- the removed legacy host registry -----------------------------------------

test("hosts-config: a stale hosts.local.json is called out, not ignored", { skip: !POSIX }, () => {
	// Removing the reader silently would leave the file looking authoritative
	// while nothing read it.
	const legacy = join(home, "hosts.local.json");
	writeFileSync(legacy, JSON.stringify({ hosts: {} }));
	const check = preflight().of("hosts-config");
	assert.equal(check.status, "warn");
	assert.match(check.detail, /REMOVED legacy format/);
	rmSync(legacy, { force: true });

	// And the flag that used to read it.
	const flagged = preflight(["--hosts", join(home, "whatever.json")]).of("hosts-config");
	assert.equal(flagged.status, "warn");
	assert.match(flagged.detail, /--cluster/);
});

test.after(() => rmSync(home, { recursive: true, force: true }));

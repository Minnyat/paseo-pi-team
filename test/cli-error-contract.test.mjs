// cli-error-contract.test.mjs — what the CLI does when things go wrong.
//
// `cli/paseo-team.mjs` opens by stating its own contract: "Every command emits
// a single JSON object (or JSON for read bodies). Non-JSON errors go to stderr
// and the process exits non-zero." The WebUI is built on exactly that — it
// spawns this binary, treats a zero exit as "the CLI answered", and parses
// stdout as JSON.
//
// cli-contract.test.mjs covers the happy paths. Coverage said the gap was
// everything else: 82% of lines but 62% of BRANCHES, and almost every
// uncovered region was an error path — the PaseoError handlers, the degraded
// reports, the dispatcher rejections. Those are the paths that decide what the
// WebUI shows when the daemon is down and what exit code a script sees, which
// is the worst place for a contract nobody has executed.
//
// So this file asserts the contract itself, over the whole surface, rather
// than any one command's output.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const CLI = join(HERE, "..", "cli", "paseo-team.mjs");
const sandbox = mkdtempSync(join(tmpdir(), "pst-cli-errors-"));

/** The exit code the CLI uses for "you typed something it does not accept". */
const USAGE = 2;

/**
 * A `paseo` that fails the way a down daemon does: non-zero, a message on
 * stderr, nothing on stdout. This is the state the whole file is about.
 */
const brokenPaseo = join(sandbox, "broken-paseo.mjs");
writeFileSync(
	brokenPaseo,
	'process.stderr.write("connect ECONNREFUSED 127.0.0.1:6767\\n");\nprocess.exit(1);\n',
);

/** A `paseo` that exits 0 and prints something that is not JSON at all. */
const babblingPaseo = join(sandbox, "babbling-paseo.mjs");
writeFileSync(babblingPaseo, 'process.stdout.write("<html>login required</html>\\n");\n');

function run(args, extraEnv = {}) {
	const result = spawnSync(process.execPath, [CLI, ...args], {
		encoding: "utf8",
		input: extraEnv.__stdin ?? "",
		env: {
			...process.env,
			PI_HOME: join(sandbox, "pi"),
			PASEO_HOME: join(sandbox, "paseo"),
			PST_TEAM_CONFIG_DIR: join(sandbox, "team"),
			PASEO_CONFIG_JSON: join(sandbox, "paseo-config.json"),
			CLAUDE_CONFIG_DIR: join(sandbox, "claude"),
			PASEO_TEAM_CLAUDE_USER_CONFIG: join(sandbox, "claude.json"),
			...extraEnv,
		},
	});
	let json;
	let jsonError = null;
	if (result.stdout.trim() !== "") {
		try {
			json = JSON.parse(result.stdout);
		} catch (error) {
			jsonError = String(error?.message ?? error);
		}
	}
	return { ...result, json, jsonError };
}

const withBrokenDaemon = { PASEO_TEAM_PASEO_EXEC: `node "${brokenPaseo}"` };
const withBabblingDaemon = { PASEO_TEAM_PASEO_EXEC: `node "${babblingPaseo}"` };

/** The contract, as one assertion. */
function assertContract(result, label) {
	assert.equal(
		result.jsonError,
		null,
		`${label}: stdout must be parseable JSON or empty, got ${result.jsonError} — the WebUI parses this`,
	);
	if (result.status !== 0) {
		assert.ok(
			result.stderr.trim() !== "" || result.json !== undefined,
			`${label}: a failure must say something, on stderr or as a JSON body`,
		);
	}
}

// --- the dispatchers ----------------------------------------------------------
//
// A typo must never be silently absorbed. Every one of these is a way to get a
// noun wrong, and all of them have to answer the same way.

test("every dispatcher rejects a bad subcommand the same way", () => {
	const cases = [
		["config", "read|write"],
		["prompts", "read|write"],
		["skills", "list|read|write"],
		["protocol", "status"],
		["env", "list"],
		["agent", "inspect|send"],
		["permits", "list|allow|deny"],
		["seats", "list"],
	];
	for (const [parent, expected] of cases) {
		// `env` alone is a documented shorthand for `env list`, so only the
		// wrong-noun form is a usage error there.
		const forms =
			parent === "env"
				? [[parent, "definitely-not-a-subcommand"]]
				: [[parent], [parent, "definitely-not-a-subcommand"]];
		for (const argv of forms) {
			const result = run(argv);
			const label = argv.join(" ");
			assertContract(result, label);
			assert.equal(
				result.status,
				USAGE,
				`${label}: a usage error exits ${USAGE}, so a script can tell a typo from a daemon that is down`,
			);
			assert.match(result.stderr, /\[paseo-team\]/, `${label}: names the tool`);
			// The message has to say what WOULD work; "unknown subcommand" alone
			// sends the reader to --help for something the line could have said.
			for (const option of expected.split("|")) {
				assert.ok(
					result.stderr.includes(option),
					`${label}: does not name the valid option "${option}" — stderr was: ${result.stderr.trim()}`,
				);
			}
			assert.doesNotMatch(
				result.stderr,
				/undefined|\[object Object\]/,
				`${label}: a JavaScript artifact reached the user`,
			);
		}
	}
});

test("`env` with no subcommand is the documented shorthand, not an error", () => {
	// Lumping it in with the other dispatchers would have pinned a usage error
	// on a shorthand the CLI deliberately accepts.
	const result = run(["env"]);
	assertContract(result, "env");
	assert.equal(result.status, 0);
	assert.deepEqual(result.json.env, run(["env", "list"]).json.env);
});

test("an unknown top-level command exits on usage, not on help", () => {
	const result = run(["teleport"]);
	assertContract(result, "teleport");
	assert.equal(result.status, USAGE);
	assert.match(result.stderr, /--help/, "the remedy is named");
	assert.equal(result.stdout, "", "a usage error is not an answer");
});

test("a subcommand missing its required argument is a usage error", () => {
	for (const argv of [
		["config", "read"],
		["prompts", "write"],
		["skills", "read"],
		["agent", "inspect"],
		["agent", "send"],
	]) {
		const result = run(argv);
		const label = argv.join(" ");
		assertContract(result, label);
		assert.equal(result.status, USAGE, label);
		assert.match(result.stderr, /missing/i, label);
	}
});

// --- bad names ----------------------------------------------------------------

test("an unknown section, role or skill fails with the valid set, not a stack", () => {
	const cases = [
		[["config", "read", "no-such-section"], /section/i],
		[["prompts", "read", "no-such-role"], /role/i],
		[["skills", "read", "no-such-skill"], /skill/i],
	];
	for (const [argv, expected] of cases) {
		const result = run(argv);
		const label = argv.join(" ");
		assertContract(result, label);
		assert.notEqual(result.status, 0, label);
		assert.match(result.stderr, expected, label);
		assert.doesNotMatch(result.stderr, /at .*\.mjs:\d+/, `${label}: a stack trace is not a message`);
	}
});

test("a path-shaped skill name cannot escape the skills directory", () => {
	// cw.safeName is the guard; what is asserted here is that the CLI calls it
	// before touching the filesystem, on both read and write.
	//
	// The containment is checked by RESOLVING the reported path against the
	// skills directory, not by looking for ".." in it. An earlier version of
	// this test did the latter and proved nothing: `join()` normalises the
	// traversal away, so `skills/../../etc/passwd/SKILL.md` becomes a perfectly
	// clean absolute path with no ".." left to find, and removing the guard
	// entirely still passed.
	const skillsDir = resolve(run(["status"]).json.paths.skillsDir);
	const inside = (p) => {
		const abs = resolve(p);
		return abs === skillsDir || abs.startsWith(skillsDir + sep);
	};
	assert.ok(inside(join(skillsDir, "ok", "SKILL.md")), "the containment check itself works");
	assert.ok(!inside(join(skillsDir, "..", "elsewhere", "SKILL.md")), "and it catches an escape");

	for (const name of ["../../etc/passwd", "..", "a/b", "./x", "a\\b"]) {
		const read = run(["skills", "read", name]);
		assertContract(read, `skills read ${name}`);
		assert.notEqual(read.status, 0, `skills read ${name} must not succeed`);
		if (read.json?.path) {
			assert.ok(inside(read.json.path), `skills read ${name} escaped to ${read.json.path}`);
		}

		const wrote = run(["skills", "write", name], { __stdin: "# nope\n" });
		assertContract(wrote, `skills write ${name}`);
		assert.notEqual(wrote.status, 0, `skills write ${name} must not succeed`);
		const written = wrote.json?.path;
		assert.ok(
			written === undefined || inside(written),
			`skills write ${name} wrote outside the skills directory: ${written}`,
		);
		if (written) assert.ok(!existsSync(written), `skills write ${name} created ${written}`);
	}

	// A plain name still works, so the guard is a guard and not a wall.
	const good = run(["skills", "write", "a-real-skill"], { __stdin: "# yes\n" });
	assert.equal(good.status, 0, good.stderr);
	assert.ok(inside(good.json.path));

	// READING needs a target that actually exists, or the traversal fails on
	// its own and proves nothing: without this the guard could be deleted from
	// `skills read` and every assertion above would still pass, because a
	// missing file refuses the same way a blocked name does.
	const outside = join(sandbox, "outside");
	mkdirSync(outside, { recursive: true });
	writeFileSync(join(outside, "SKILL.md"), "# not yours to read\n");
	// PI_HOME/agent/skills -> three levels up is the sandbox root.
	const escape = run(["skills", "read", join("..", "..", "..", "outside")]);
	assertContract(escape, "skills read (traversal to a real file)");
	assert.notEqual(escape.status, 0, "a traversal to a file that EXISTS must still be refused");
	assert.ok(
		!escape.stdout.includes("not yours to read"),
		"the contents of a file outside the skills directory reached the caller",
	);
});

// --- the daemon is down -------------------------------------------------------
//
// The live-plane commands all reach the daemon through paseo-bridge, which
// throws PaseoError. What each command does with that is the branch coverage
// pointed at, and the answers differ on purpose: a per-agent command fails,
// while a fan-out reports what it could not reach and still answers.

// A single read has nothing to render when it fails, so the failure IS the
// answer: ok:false and a non-zero exit. The fan-outs (models, graph) are the
// other shape and are covered on their own below — mixing them here would pin
// the wrong contract on both.
const SINGLE_READS = [
	["agents"],
	["agent", "inspect", "11111111-1111-1111-1111-111111111111"],
	["permits", "list"],
	["models", "--provider", "pi-peer"],
	["cost"],
];
const FAN_OUTS = [["models"], ["graph"]];
// A third shape: `activity` RELAYS the daemon's text rather than parsing it,
// so arbitrary bytes are a legitimate answer and only the envelope is this
// file's business. It still fails like a single read when the daemon is down.
const TEXT_RELAYS = [["activity", "11111111-1111-1111-1111-111111111111"]];
const LIVE_COMMANDS = [...SINGLE_READS, ...FAN_OUTS, ...TEXT_RELAYS];

test("a down daemon never breaks the JSON contract", () => {
	for (const argv of [...SINGLE_READS, ...TEXT_RELAYS]) {
		const result = run(argv, withBrokenDaemon);
		const label = `${argv.join(" ")} (daemon down)`;
		assertContract(result, label);
		assert.notEqual(result.status, 0, `${label}: a failure must not exit 0`);
		// Whatever the shape, the reason has to be somewhere a caller can read.
		const said = `${result.stderr}${JSON.stringify(result.json ?? {})}`;
		assert.ok(said.trim().length > 0, `${label}: failed silently`);
	}
});

// `ok` answers "is this answer complete?", and the two command shapes here
// answer it differently ON PURPOSE.
//
//   - a single read (agents, cost, activity, permits, models --provider X) has
//     nothing to render when it fails, so it reports ok:false and exits 3;
//   - a fan-out (models, graph) keeps exit 0 and a renderable body, because
//     the WebUI turns a non-zero exit into a 502 that never parses the body —
//     the explaining page would be the thing lost.
//
// What is NOT a choice is claiming ok:true after reaching nothing.
test("a fan-out reports completeness, never a false ok", () => {
	const models = run(["models"], withBrokenDaemon);
	assertContract(models, "models (daemon down)");
	assert.equal(models.status, 0, "the body is renderable, so it is delivered");
	assert.equal(
		models.json.ok,
		false,
		"reaching nothing must not read as 'there are no models' — and it must not disagree with `models --provider X`, which fails loudly on the same daemon",
	);
	assert.ok(models.json.degraded.length > 0, "and it says what it could not reach");

	const graph = run(["graph"], withBrokenDaemon);
	assertContract(graph, "graph (daemon down)");
	assert.equal(graph.status, 0);
	assert.equal(graph.json.ok, false);
	assert.ok(graph.json.degraded.length > 0);

	// The single-read shape, for contrast — same daemon, different answer.
	const one = run(["models", "--provider", "pi-peer"], withBrokenDaemon);
	assertContract(one, "models --provider (daemon down)");
	assert.equal(one.status, 3, "nothing to render, so the failure is the answer");
	assert.equal(one.json.ok, false);
});

test("a daemon answering non-JSON is reported, not passed through", () => {
	// paseo exits 0 and prints an HTML login page — the shape a proxy or an
	// expired session produces. Forwarding that to stdout would hand the WebUI
	// something it cannot parse while claiming success.
	//
	// Quoting a short prefix of the daemon's output INTO the JSON message is
	// the opposite of passing it through: it is the diagnostic that tells an
	// operator they are looking at a login page rather than a protocol error.
	// The contract is about the shape of stdout, so that is what is asserted.
	for (const argv of SINGLE_READS) {
		const result = run(argv, withBabblingDaemon);
		const label = `${argv.join(" ")} (daemon babbling)`;
		assertContract(result, label);
		assert.notEqual(result.status, 0, `${label}: unparseable output is not success`);
		assert.match(
			`${result.stderr}${JSON.stringify(result.json ?? {})}`,
			/JSON/i,
			`${label}: must say the answer was not JSON, not just that something failed`,
		);
	}
	// The fan-outs keep their renderable body, and say the same thing inside it.
	for (const argv of FAN_OUTS) {
		const result = run(argv, withBabblingDaemon);
		const label = `${argv.join(" ")} (daemon babbling)`;
		assertContract(result, label);
		assert.equal(result.json.ok, false, `${label}: unparseable output is not completeness`);
	}
	// And the relay keeps relaying: bytes it cannot interpret are still the
	// agent's output, and suppressing them on a guess about their shape would
	// lose real activity. What it must not do is let them out of the envelope.
	for (const argv of TEXT_RELAYS) {
		const result = run(argv, withBabblingDaemon);
		const label = `${argv.join(" ")} (daemon babbling)`;
		assertContract(result, label);
		assert.equal(result.status, 0, `${label}: the daemon answered; relaying is the job`);
		assert.ok(
			JSON.stringify(result.json).includes("login required"),
			`${label}: the text reached the caller`,
		);
		assert.ok(
			!result.stdout.startsWith("<"),
			`${label}: and it stayed inside the JSON envelope`,
		);
	}
});

test("a misconfigured PASEO_TEAM_PASEO_EXEC is a named failure", () => {
	// The override exists for tests and debugging; an empty or nonsense value
	// must not read as "the daemon is down", which sends the operator to fix
	// the wrong thing.
	const result = run(["agents"], { PASEO_TEAM_PASEO_EXEC: "   " });
	assertContract(result, "agents (blank exec override)");
	assert.notEqual(result.status, 0);
});

// --- the local-plane commands stay usable without a daemon --------------------

test("commands that need no daemon answer with JSON and exit 0", () => {
	for (const argv of [["status"], ["env", "list"], ["skills", "list"], ["protocol", "status"]]) {
		const result = run(argv, withBrokenDaemon);
		const label = argv.join(" ");
		assertContract(result, label);
		assert.equal(result.status, 0, `${label}: a down daemon is irrelevant here`);
		assert.equal(typeof result.json, "object", `${label}: must answer with JSON`);
	}
});

test("env list reports the knobs that decide where config lives", () => {
	// These two were added when the pack's config directory stopped being
	// resolved twice under two names. A knob that decides where everything
	// lives and is not in `env list` is a knob nobody will find.
	const result = run(["env", "list"], { PST_TEAM_CONFIG_DIR: join(sandbox, "team") });
	const keys = result.json.env.map((entry) => entry.key);
	assert.ok(keys.includes("PST_TEAM_CONFIG_DIR"));
	assert.ok(keys.includes("PASEO_TEAM_HOME"));
	// The reported "current" is the live value, not the documented default.
	const current = result.json.env.find((e) => e.key === "PST_TEAM_CONFIG_DIR").current;
	assert.equal(current, join(sandbox, "team"));
	// An unset knob reads as null rather than "" — the two mean different
	// things to anyone deciding whether to set it.
	const unset = result.json.env.find((e) => e.current === null);
	assert.ok(unset, "at least one documented knob is unset in this sandbox");
});

// --- protocol status ----------------------------------------------------------

test("protocol status grades a repo and says which path it read", () => {
	const repo = join(sandbox, "protorepo");
	mkdirSync(repo, { recursive: true });

	const missing = run(["protocol", "status", "--path", repo]);
	assertContract(missing, "protocol status (missing)");
	assert.equal(missing.status, 0, "a missing protocol is a finding, not a CLI failure");
	assert.equal(missing.json.state, "missing");
	assert.equal(missing.json.repoRoot, repo);
	assert.match(missing.json.summary, /WORKSPACE_PROTOCOL\.example\.md/);

	writeFileSync(join(repo, "WORKSPACE_PROTOCOL.md"), "WORKSPACE_PROTOCOL_VERSION: 1\nPROJECT_ID: x\n");
	const valid = run(["protocol", "status", "--path", repo]);
	assert.equal(valid.json.state, "valid");
	assert.match(valid.json.digest, /^[0-9a-f]{64}$/, "the digest answers 'did it change?'");

	writeFileSync(join(repo, "WORKSPACE_PROTOCOL.md"), "<<<<<<< HEAD\nPROJECT_ID: x\n");
	const invalid = run(["protocol", "status", "--path", repo]);
	assert.equal(invalid.json.state, "invalid");
	assert.equal(invalid.status, 0, "grading is reporting; the CLI did its job");
	assert.match(invalid.json.summary, /merge conflict/);

	// No --path means the current directory, and a --path with nothing after it
	// must not silently become the current directory either.
	const bare = run(["protocol", "status"]);
	assert.equal(bare.status, 0);
	assert.equal(bare.json.repoRoot, process.cwd());
});

// --- flags --------------------------------------------------------------------

test("an unrecognised flag is refused, never silently dropped", () => {
	// A --strict-shaped flag that does nothing while looking like it worked is
	// the failure this rule exists for.
	for (const argv of [
		["graph", "--with-logs"],
		["cost", "--everything"],
		["agents", "--deep"],
	]) {
		const result = run(argv, withBrokenDaemon);
		const label = argv.join(" ");
		assertContract(result, label);
		assert.notEqual(result.status, 0, `${label}: an unknown flag must not be ignored`);
	}
});

test("--help on a subcommand answers without reaching the daemon", () => {
	for (const argv of [["agents", "--help"], ["cost", "--help"], ["protocol", "--help"]]) {
		const result = run(argv, withBrokenDaemon);
		const label = argv.join(" ");
		assert.equal(result.status, 0, `${label}: help is not a failure`);
		assert.ok(result.stdout.trim().length > 0, `${label}: help must say something`);
	}
});

test.after(() => rmSync(sandbox, { recursive: true, force: true }));

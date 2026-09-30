// routing-cli.test.mjs — `pteam routing show|check|set|unset`.
//
// Driven through the real CLI binary, against a throwaway config dir
// (PST_TEAM_CONFIG_DIR) and an injected inventory (fake-paseo-routing.mjs), so
// no case can read or write the developer's real ~/.paseo-pi-team or talk to a
// real daemon. What is pinned here is the contract that makes `set` safe to
// hand to a Lead or a Human: it validates STRICTLY against the live inventory,
// writes NOTHING when the route does not resolve, and always leaves a
// `<file>.bak-<epoch>` of what it replaced.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const CLI = join(HERE, "..", "cli", "paseo-team.mjs");
const FAKE = join(HERE, "fixtures", "fake-paseo-routing.mjs");
const sandbox = mkdtempSync(join(tmpdir(), "pteam-routing-cli-"));
after(() => rmSync(sandbox, { recursive: true, force: true }));

const BASE_ROUTES = {
	MONITOR_ECONOMY: { paseoProvider: "pi-supervisor", model: "Mx/cheap", thinking: "low" },
	FAST_READ: { paseoProvider: "pi-peer", model: "Mx/cheap", thinking: "low" },
	CODING_MEDIUM: { paseoProvider: "pi-peer", model: "Mx/mid", thinking: "medium" },
	REASONING_HIGH: { paseoProvider: "claude-peer", model: "claude-opus-5", thinking: "high" },
	REVIEW_HIGH: { paseoProvider: "claude-peer", model: "claude-opus-5", thinking: "xhigh" },
};

const INVENTORY = {
	providers: ["pi-supervisor", "pi-lead", "pi-peer", "claude-supervisor", "claude-lead", "claude-peer"].map((provider) => ({
		provider,
		enabled: "Enabled",
		status: "available",
	})),
	models: {
		"pi-peer": [
			{ id: "Mx/cheap", thinkingOptionIds: ["off", "low"] },
			{ id: "Mx/mid", thinkingOptionIds: ["low", "medium"] },
		],
		"pi-supervisor": [{ id: "Mx/cheap", thinkingOptionIds: ["low"] }],
		"pi-lead": [{ id: "Mx/big", thinkingOptionIds: ["medium", "high"] }],
		"claude-peer": [{ id: "claude-opus-5", thinkingOptionIds: ["high", "xhigh"] }],
		"claude-supervisor": [{ id: "claude-opus-5", thinkingOptionIds: ["high", "max"] }],
		"claude-lead": [{ id: "claude-opus-5", thinkingOptionIds: ["high"] }],
	},
};

let count = 0;
/** A fresh config dir + inventory file; returns the paths and a runner bound to them. */
function host({ routing, cluster, inventory = INVENTORY } = {}) {
	const dir = join(sandbox, `host-${(count += 1)}`);
	mkdirSync(dir, { recursive: true });
	const routingPath = join(dir, "model-routing.local.json");
	const clusterPath = join(dir, "cluster-routing.local.json");
	if (routing) writeFileSync(routingPath, `${JSON.stringify(routing, null, 2)}\n`);
	if (cluster) writeFileSync(clusterPath, `${JSON.stringify(cluster, null, 2)}\n`);
	const inventoryPath = join(dir, "inventory.json");
	if (inventory) writeFileSync(inventoryPath, JSON.stringify(inventory));
	const run = (args, extraEnv = {}) => {
		const env = { ...process.env };
		for (const key of Object.keys(env)) if (key.startsWith("PASEO_") || key.startsWith("PST_")) delete env[key];
		const result = spawnSync(process.execPath, [CLI, "routing", ...args], {
			encoding: "utf8",
			env: {
				...env,
				PST_TEAM_CONFIG_DIR: dir,
				PASEO_TEAM_PASEO_EXEC: `node "${FAKE}"`,
				FAKE_ROUTING_INVENTORY: inventoryPath,
				PI_HOME: join(dir, "pi"),
				PASEO_HOME: join(dir, "paseo"),
				...extraEnv,
			},
		});
		let json = null;
		try {
			json = JSON.parse(result.stdout);
		} catch {
			/* text output */
		}
		return { ...result, json };
	};
	const backups = () => readdirSync(dir).filter((name) => /\.bak-\d+$/.test(name));
	const read = (path) => JSON.parse(readFileSync(path, "utf8"));
	return { dir, routingPath, clusterPath, run, backups, read };
}

const routingOnly = () => host({ routing: { version: 1, hostId: "minnyat", routes: BASE_ROUTES } });
const clusterHost = () =>
	host({
		cluster: {
			version: 1,
			hosts: {
				ctl: { connection: { type: "local" }, required: true, capabilities: ["git-read"], routes: BASE_ROUTES },
				mac: {
					connection: { type: "remote", endpointEnv: "PASEO_MAC" },
					required: false,
					capabilities: ["git-read"],
					routes: BASE_ROUTES,
				},
			},
		},
	});

// --- show ----------------------------------------------------------------------

test("show: the effective route per class, optional classes marked unset, text and --json", () => {
	const h = routingOnly();
	const json = h.run(["show", "--json"]);
	assert.equal(json.status, 0, json.stderr);
	assert.equal(json.json.ok, true);
	assert.equal(json.json.source, "routing");
	assert.equal(json.json.path, h.routingPath);
	assert.equal(json.json.enforcement, "on");
	const byClass = Object.fromEntries(json.json.classes.map((entry) => [entry.class, entry]));
	assert.equal(byClass.CODING_MEDIUM.createAgentProvider, "pi-peer/Mx/mid");
	assert.equal(byClass.SUPERVISOR_GOVERNANCE.configured, false);
	assert.equal(byClass.SUPERVISOR_GOVERNANCE.required, false);
	assert.equal(byClass.LEAD_RECOVERY.configured, false);
	assert.ok(json.json.warnings.some((w) => /SUPERVISOR_GOVERNANCE is not configured/.test(w)));

	const text = h.run(["show"]);
	assert.equal(text.status, 0);
	assert.match(text.stdout, /SUPERVISOR_GOVERNANCE\s+— not configured \(optional\)/);
	assert.match(text.stdout, /CODING_MEDIUM\s+pi-peer\/Mx\/mid\s+thinking=medium/);

	const off = h.run(["show", "--json"], { PASEO_TEAM_ROUTE_ENFORCE: "off" });
	assert.equal(off.json.enforcement, "off");
	assert.ok(off.json.warnings.some((w) => /PASEO_TEAM_ROUTE_ENFORCE=off/.test(w)), "the opt-out is flagged");
});

test("show: a cluster host reports its LOCAL host; a missing file is a failure, not an empty table", () => {
	const c = clusterHost();
	const shown = c.run(["show", "--json"]);
	assert.equal(shown.json.source, "cluster");
	assert.equal(shown.json.hostId, "ctl");

	const empty = host({});
	const missing = empty.run(["show", "--json"]);
	assert.equal(missing.status, 1);
	assert.equal(missing.json.ok, false);
	assert.equal(missing.json.code, "ROUTE_FILE_MISSING");
});

// --- check ---------------------------------------------------------------------

test("check: resolves every configured class strictly against the live inventory", () => {
	const h = routingOnly();
	const ok = h.run(["check", "--json"]);
	assert.equal(ok.status, 0, ok.stdout);
	const byId = Object.fromEntries(ok.json.checks.map((check) => [check.id, check]));
	assert.equal(byId["route:CODING_MEDIUM"].status, "pass");
	assert.equal(byId["route:LEAD_RECOVERY"].status, "warn", "an absent optional class warns");
	assert.equal(byId["route-gate"].status, "pass");

	const noDaemon = host({ routing: { version: 1, hostId: "h", routes: BASE_ROUTES }, inventory: null });
	const down = noDaemon.run(["check", "--json"]);
	assert.equal(down.status, 1, "an unreadable inventory is not a pass");
	assert.match(down.json.checks.find((c) => c.id === "route:FAST_READ").detail, /unverifiable is not a pass/);

	const drift = host({
		routing: { version: 1, hostId: "h", routes: { ...BASE_ROUTES, CODING_MEDIUM: { paseoProvider: "pi-peer", model: "Mx/mid", thinking: "high" } } },
	});
	const bad = drift.run(["check"]);
	assert.equal(bad.status, 1);
	assert.match(bad.stdout, /✗ route:CODING_MEDIUM: .*thinking "high" is not offered/);
	assert.match(bad.stdout, /routing: FAILED/);
});

// --- set -----------------------------------------------------------------------

test("set: a routable value is written atomically, with a .bak-<epoch> of the previous file", () => {
	const h = routingOnly();
	const before = readFileSync(h.routingPath, "utf8");
	const set = h.run(["set", "SUPERVISOR_GOVERNANCE", "--provider", "claude-supervisor", "--model", "claude-opus-5", "--thinking", "max", "--json"]);
	assert.equal(set.status, 0, set.stderr);
	assert.equal(set.json.wrote, true);
	assert.equal(set.json.createAgentProvider, "claude-supervisor/claude-opus-5");
	assert.deepEqual(h.read(h.routingPath).routes.SUPERVISOR_GOVERNANCE, {
		paseoProvider: "claude-supervisor",
		model: "claude-opus-5",
		thinking: "max",
	});
	const backups = h.backups();
	assert.equal(backups.length, 1);
	assert.match(backups[0], /^model-routing\.local\.json\.bak-\d{13}$/);
	assert.equal(readFileSync(join(h.dir, backups[0]), "utf8"), before, "the backup is the previous file, byte for byte");
	assert.equal(set.json.backup, join(h.dir, backups[0]));
	assert.ok(!readdirSync(h.dir).some((name) => name.includes(".tmp-")), "no temp file is left behind");

	// Changing a required class works the same way.
	const change = h.run(["set", "CODING_MEDIUM", "--provider", "pi-peer", "--model", "Mx/mid", "--thinking", "low"]);
	assert.equal(change.status, 0, change.stderr);
	assert.equal(h.read(h.routingPath).routes.CODING_MEDIUM.thinking, "low");
});

test("set: an unroutable value is REFUSED and nothing is written", () => {
	const h = routingOnly();
	const before = readFileSync(h.routingPath, "utf8");
	const cases = [
		[["LEAD_RECOVERY", "--provider", "pi-lead", "--model", "Mx/big", "--thinking", "xhigh"], /THINKING_OPTION_UNAVAILABLE/],
		[["LEAD_RECOVERY", "--provider", "pi-lead", "--model", "Mx/nope", "--thinking", "high"], /MODEL_UNAVAILABLE/],
		[["LEAD_RECOVERY", "--provider", "pi-peer", "--model", "Mx/mid", "--thinking", "medium"], /LEAD_RECOVERY seats a lead/],
		[["SUPERVISOR_GOVERNANCE", "--provider", "claude-lead", "--model", "claude-opus-5", "--thinking", "high"], /seats a supervisor/],
		[["FAST_READ", "--provider", "pi-peer", "--model", "Mx/cheap", "--thinking", "ultracode"], /THINKING_INVALID/],
		[["FAST_READ", "--provider", "Pi-Peer", "--model", "Mx/cheap", "--thinking", "low"], /PROVIDER_INVALID/],
		[["FAST_READ", "--provider", "pi-peer", "--model", " Mx/cheap", "--thinking", "low"], /MODEL_INVALID/],
		[["GOVERNANCE", "--provider", "pi-supervisor", "--model", "Mx/cheap", "--thinking", "low"], /CLASS_UNKNOWN/],
	];
	for (const [args, pattern] of cases) {
		const result = h.run(["set", ...args]);
		assert.equal(result.status, 1, `${args.join(" ")} must be refused`);
		assert.match(result.stderr, pattern, args.join(" "));
	}
	const unavailable = host({ routing: { version: 1, hostId: "h", routes: BASE_ROUTES }, inventory: null });
	const down = unavailable.run(["set", "FAST_READ", "--provider", "pi-peer", "--model", "Mx/cheap", "--thinking", "low", "--json"]);
	assert.equal(down.status, 1);
	assert.equal(down.json.code, "INVENTORY_UNAVAILABLE");
	assert.deepEqual(unavailable.backups(), []);

	assert.equal(readFileSync(h.routingPath, "utf8"), before, "the route file is untouched");
	assert.deepEqual(h.backups(), [], "a refused set leaves no backup either");
});

test("set: cluster file — default is the gate's local host, --host-id a local host works, a remote host is refused", () => {
	const c = clusterHost();
	const local = c.run(["set", "LEAD_RECOVERY", "--provider", "pi-lead", "--model", "Mx/big", "--thinking", "high", "--json"]);
	assert.equal(local.status, 0, local.stderr);
	assert.equal(local.json.hostId, "ctl");
	assert.equal(local.json.path, c.clusterPath);
	assert.equal(c.read(c.clusterPath).hosts.ctl.routes.LEAD_RECOVERY.model, "Mx/big");
	assert.equal(c.read(c.clusterPath).hosts.mac.routes.LEAD_RECOVERY, undefined, "the remote host is untouched");

	const explicit = c.run(["set", "FAST_READ", "--provider", "pi-peer", "--model", "Mx/mid", "--thinking", "low", "--host-id", "ctl"]);
	assert.equal(explicit.status, 0, explicit.stderr);
	assert.equal(c.read(c.clusterPath).hosts.ctl.routes.FAST_READ.model, "Mx/mid");

	const before = readFileSync(c.clusterPath, "utf8");
	const remote = c.run(["set", "FAST_READ", "--provider", "pi-peer", "--model", "Mx/mid", "--thinking", "low", "--host-id", "mac", "--json"]);
	assert.equal(remote.status, 1);
	assert.equal(remote.json.code, "REMOTE_HOST_UNVERIFIABLE");
	assert.match(remote.json.message, /LOCAL one. Nothing written/);
	const unknown = c.run(["set", "FAST_READ", "--provider", "pi-peer", "--model", "Mx/mid", "--thinking", "low", "--host-id", "nope"]);
	assert.equal(unknown.status, 1);
	assert.match(unknown.stderr, /HOST_UNKNOWN/);
	assert.equal(readFileSync(c.clusterPath, "utf8"), before);
	assert.equal(c.backups().length, 2, "one backup per successful write");
});

test("set: refuses to invent a route file, and to rewrite one that does not load", () => {
	const empty = host({});
	const missing = empty.run(["set", "FAST_READ", "--provider", "pi-peer", "--model", "Mx/cheap", "--thinking", "low"]);
	assert.equal(missing.status, 1);
	assert.match(missing.stderr, /ROUTE_FILE_MISSING.*does not invent the five required classes/);
	assert.equal(existsSync(empty.routingPath), false);

	const broken = host({});
	writeFileSync(broken.routingPath, "{ not json");
	const refused = broken.run(["set", "FAST_READ", "--provider", "pi-peer", "--model", "Mx/cheap", "--thinking", "low"]);
	assert.equal(refused.status, 1);
	assert.match(refused.stderr, /CONFIG_INVALID/);
	assert.equal(readFileSync(broken.routingPath, "utf8"), "{ not json");
});

// --- unset ---------------------------------------------------------------------

test("unset: removes an optional class with a backup; a required class is refused; an absent one is a no-op", () => {
	const h = routingOnly();
	assert.equal(h.run(["set", "LEAD_RECOVERY", "--provider", "pi-lead", "--model", "Mx/big", "--thinking", "high"]).status, 0);
	const unset = h.run(["unset", "LEAD_RECOVERY", "--json"]);
	assert.equal(unset.status, 0, unset.stderr);
	assert.equal(unset.json.wrote, true);
	assert.equal(h.read(h.routingPath).routes.LEAD_RECOVERY, undefined);
	assert.equal(h.backups().length, 2);

	const again = h.run(["unset", "LEAD_RECOVERY", "--json"]);
	assert.equal(again.status, 0);
	assert.equal(again.json.wrote, false);
	assert.equal(h.backups().length, 2, "a no-op writes nothing");

	const required = h.run(["unset", "REVIEW_HIGH"]);
	assert.equal(required.status, 1);
	assert.match(required.stderr, /CLASS_REQUIRED/);
	assert.ok(h.read(h.routingPath).routes.REVIEW_HIGH);
});

// --- dispatch + help --------------------------------------------------------------

test("dispatch: usage errors exit 2, help lists every subcommand", () => {
	const h = routingOnly();
	for (const args of [[], ["frobnicate"], ["set"], ["set", "FAST_READ", "--provider", "pi-peer"], ["unset"]]) {
		const result = h.run(args);
		assert.equal(result.status, 2, `routing ${args.join(" ")} is a usage error`);
	}
	assert.equal(h.run(["show", "--bogus"]).status, 1, "an unknown flag is refused, never ignored");
	const help = h.run(["--help"]);
	assert.equal(help.status, 0);
	for (const sub of ["show", "check", "set <CLASS>", "unset <CLASS>"]) {
		assert.match(help.stdout, new RegExp(`pteam routing ${sub}`), `help names routing ${sub}`);
	}
});

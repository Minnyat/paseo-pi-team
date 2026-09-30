// route-gate.test.mts — the create_agent route gate, on both runtimes.
//
// Every case runs through BOTH adapters' decision points: the Pi one
// (mcpBlockReason with the `{ tool, args }` proxy shape) and the Claude one
// (claudeToolBlockReason with args as the tool input). A rule that holds on one
// runtime only is a rule the other runtime is the quiet way around.
//
// Route tables are never hand-built: they are written to temp dirs and read back
// through scripts/model-routing.mjs (gateRouteTable), the loader the adapters
// use, so the file-selection rules are exercised along with the comparison.
// Two host shapes are covered, as they exist in the field: a host with only
// model-routing.local.json (no optional classes), and a controller whose
// cluster-routing.local.json holds one local and one remote host.
//
// Every call passes an explicit `env`, so an inherited PASEO_TEAM_ROUTE_ENFORCE
// (a developer running the suite from inside a Paseo seat) cannot flip a case.

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test, after } from "node:test";
import { fileURLToPath } from "node:url";

import {
	createAgentRouteBlockReason,
	mcpBlockReason,
	routeEnforcement,
	routeEnforcementNotice,
	type RouteTable,
	type TeamRole,
} from "../extensions/paseo-team-core/policy-core.ts";
import { claudeToolBlockReason } from "../extensions/paseo-team-core/claude-policy.ts";
// @ts-ignore — plain .mjs module, no declarations
import { gateRouteTable } from "../scripts/model-routing.mjs";
// @ts-ignore — plain .mjs module, no declarations
import { handleEvent } from "../scripts/claude-hook.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const sandbox = mkdtempSync(join(tmpdir(), "pteam-route-gate-"));
after(() => rmSync(sandbox, { recursive: true, force: true }));

const ENFORCED: Record<string, string | undefined> = {};

// --- fixtures ----------------------------------------------------------------

const BASE_ROUTES = {
	MONITOR_ECONOMY: { paseoProvider: "pi-supervisor", model: "Mx/cheap", thinking: "low" },
	FAST_READ: { paseoProvider: "pi-peer", model: "Mx/cheap", thinking: "low" },
	CODING_MEDIUM: { paseoProvider: "pi-peer", model: "Mx/mid", thinking: "medium" },
	REASONING_HIGH: { paseoProvider: "claude-peer", model: "claude-opus-5", thinking: "high" },
	REVIEW_HIGH: { paseoProvider: "claude-peer", model: "claude-opus-5", thinking: "xhigh" },
};
const OPTIONAL_ROUTES = {
	SUPERVISOR_GOVERNANCE: { paseoProvider: "claude-supervisor", model: "claude-opus-5", thinking: "max" },
	LEAD_RECOVERY: { paseoProvider: "pi-lead", model: "Mx/big", thinking: "high" },
};

let dirCount = 0;
/** A config dir holding exactly the given files; returns its gate table. */
function hostTable(files: { routing?: unknown; cluster?: unknown; raw?: Record<string, string> }): RouteTable {
	const dir = join(sandbox, `host-${(dirCount += 1)}`);
	mkdirSync(dir, { recursive: true });
	if (files.routing !== undefined) {
		writeFileSync(join(dir, "model-routing.local.json"), JSON.stringify(files.routing));
	}
	if (files.cluster !== undefined) {
		writeFileSync(join(dir, "cluster-routing.local.json"), JSON.stringify(files.cluster));
	}
	for (const [name, text] of Object.entries(files.raw ?? {})) writeFileSync(join(dir, name), text);
	return gateRouteTable({ env: { PST_TEAM_CONFIG_DIR: dir } }) as RouteTable;
}

/** This host today: model-routing.local.json only, no optional classes. */
const ROUTING_ONLY = { version: 1, hostId: "minnyat", routes: BASE_ROUTES };
/** A controller: one local host (all seven classes) + one remote host. */
const CLUSTER = {
	version: 1,
	hosts: {
		ctl: {
			connection: { type: "local" },
			required: true,
			capabilities: ["git-read", "git-write", "focused-test"],
			routes: { ...BASE_ROUTES, ...OPTIONAL_ROUTES },
		},
		mac: {
			connection: { type: "remote", endpointEnv: "PASEO_MAC" },
			required: false,
			capabilities: ["git-read", "independent-review"],
			routes: {
				...BASE_ROUTES,
				FAST_READ: { paseoProvider: "pi-peer", model: "Remote/only-on-mac", thinking: "low" },
			},
		},
	},
};

const routingOnly = hostTable({ routing: ROUTING_ONLY });
const clusterHost = hostTable({ cluster: CLUSTER });

// --- decision helpers: the SAME case through both adapters --------------------

type Runtime = "pi" | "claude";
const RUNTIMES: Runtime[] = ["pi", "claude"];

function decide(
	runtime: Runtime,
	role: TeamRole,
	args: unknown,
	routeTable: RouteTable | null | undefined,
	env: Record<string, string | undefined> = ENFORCED,
): string | null {
	if (runtime === "pi") {
		return mcpBlockReason(role, { tool: "create_agent", args }, { routeTable, env });
	}
	return claudeToolBlockReason({
		role,
		toolName: "mcp__paseo__create_agent",
		toolInput: args,
		brief: null,
		routeTable,
		env,
	});
}

/** A Lead seating a Peer (claude-* seats need a mode; pi seats must not have one). */
function peerArgs(provider: string, thinking: string | undefined, modelClass?: string) {
	const claude = provider.trim().toLowerCase().startsWith("claude-");
	return {
		provider,
		settings: {
			...(thinking === undefined ? {} : { thinkingOptionId: thinking }),
			...(claude ? { modeId: "auto" } : {}),
		},
		labels: modelClass === undefined ? {} : { "team.model-class": modelClass },
	};
}

/** A Lead seating its Supervisor (PR-H shape + the class). */
function supervisorArgs(provider = "claude-supervisor/claude-opus-5", thinking = "max", modelClass = "SUPERVISOR_GOVERNANCE") {
	return {
		provider,
		settings: { thinkingOptionId: thinking, modeId: "auto" },
		labels: { purpose: "governance", "team.model-class": modelClass },
	};
}

/** A Supervisor's lead recovery (recovery shape + the class). */
function recoveryArgs(provider = "pi-lead/Mx/big", thinking = "high", modelClass = "LEAD_RECOVERY") {
	return {
		provider,
		settings: { thinkingOptionId: thinking },
		labels: { purpose: "recovery", recovery_for: "proj", "team.model-class": modelClass },
	};
}

const blocked = (reason: string | null, pattern: RegExp, message: string) => {
	assert.ok(reason, `${message}: expected a refusal, got an allow`);
	assert.match(reason, pattern, message);
};

// --- flow 1: Lead → Peer -------------------------------------------------------

test("Lead→Peer: every base class matching its route passes, on both host shapes and runtimes", () => {
	for (const runtime of RUNTIMES) {
		for (const table of [routingOnly, clusterHost]) {
			for (const [modelClass, route] of Object.entries(BASE_ROUTES)) {
				if (route.paseoProvider.endsWith("-supervisor")) continue; // see the MONITOR_ECONOMY case
				assert.equal(
					decide(runtime, "lead", peerArgs(`${route.paseoProvider}/${route.model}`, route.thinking, modelClass), table),
					null,
					`${runtime}: ${modelClass} on its own route must pass`,
				);
			}
		}
	}
});

test("Lead→Peer: model, thinking, provider role and class mismatches are refused with the expected values", () => {
	for (const runtime of RUNTIMES) {
		blocked(
			decide(runtime, "lead", peerArgs("pi-peer/Mx/big", "medium", "CODING_MEDIUM"), routingOnly),
			/ROUTE_MODEL_MISMATCH.*"Mx\/mid".*Expected provider "pi-peer\/Mx\/mid" with settings\.thinkingOptionId "medium"/,
			`${runtime}: a different model`,
		);
		blocked(
			decide(runtime, "lead", peerArgs("pi-peer/Mx/mid", "high", "CODING_MEDIUM"), routingOnly),
			/ROUTE_THINKING_MISMATCH.*thinking "medium".*"high"/,
			`${runtime}: a different thinking level`,
		);
		blocked(
			decide(runtime, "lead", peerArgs("pi-peer/Mx/mid", undefined, "CODING_MEDIUM"), routingOnly),
			/ROUTE_THINKING_MISMATCH.*<missing>/,
			`${runtime}: a dropped thinking level (the daemon would pick one)`,
		);
		blocked(
			decide(runtime, "lead", peerArgs("claude-peer/Mx/mid", "medium", "CODING_MEDIUM"), routingOnly),
			/ROUTE_PROVIDER_MISMATCH.*"pi-peer".*claude\/peer/,
			`${runtime}: a different runtime family`,
		);
		blocked(
			decide(runtime, "lead", peerArgs("pi-lead/Mx/mid", "medium", "CODING_MEDIUM"), routingOnly),
			/ROUTE_PROVIDER_MISMATCH.*cannot be used to seat a lead/,
			`${runtime}: a different role`,
		);
		blocked(
			decide(runtime, "lead", peerArgs("pi-peer/Mx/cheap", "low", "CODING_MEDIUM"), routingOnly),
			/ROUTE_MODEL_MISMATCH/,
			`${runtime}: FAST_READ's route declared as CODING_MEDIUM is a class mismatch`,
		);
		blocked(
			decide(runtime, "lead", peerArgs("pi-peer/Mx/mid", "medium", "SUPERVISOR_GOVERNANCE"), clusterHost),
			/ROUTE_CLASS_WRONG_FLOW.*a Lead seating a peer routes from MONITOR_ECONOMY/,
			`${runtime}: a governance class on a Peer`,
		);
	}
});

test("Lead→Peer: a class routed to a *-supervisor provider cannot seat a Peer (MONITOR_ECONOMY)", () => {
	for (const runtime of RUNTIMES) {
		for (const provider of ["pi-peer/Mx/cheap", "pi-supervisor/Mx/cheap"]) {
			const reason = decide(runtime, "lead", peerArgs(provider, "low", "MONITOR_ECONOMY"), routingOnly);
			if (provider.startsWith("pi-peer")) {
				blocked(
					reason,
					/ROUTE_PROVIDER_MISMATCH.*"pi-supervisor".*A class routed to a \*-supervisor provider cannot be used to seat a peer/,
					`${runtime}: MONITOR_ECONOMY → pi-supervisor cannot seat a Peer`,
				);
			} else {
				// Copying the route's own provider makes it a SUPERVISOR seating,
				// which has its own class — the loophole does not open.
				blocked(reason, /./, `${runtime}: seating a supervisor from MONITOR_ECONOMY`);
			}
		}
	}
});

test("Lead→Peer: a seat variant counts as its base family+role", () => {
	for (const runtime of RUNTIMES) {
		assert.equal(
			decide(runtime, "lead", peerArgs("claude-peer-audit/claude-opus-5", "xhigh", "REVIEW_HIGH"), routingOnly),
			null,
			`${runtime}: claude-peer-audit is claude/peer`,
		);
	}
});

// --- flow 2: Lead → Supervisor --------------------------------------------------

test("Lead→Supervisor: matches SUPERVISOR_GOVERNANCE on the cluster host; refused on each difference", () => {
	for (const runtime of RUNTIMES) {
		assert.equal(decide(runtime, "lead", supervisorArgs(), clusterHost), null, `${runtime}: matching seat passes`);
		blocked(
			decide(runtime, "lead", supervisorArgs("claude-supervisor/claude-sonnet-5"), clusterHost),
			/ROUTE_MODEL_MISMATCH.*Expected provider "claude-supervisor\/claude-opus-5" with settings\.thinkingOptionId "max"/,
			`${runtime}: supervisor on another model`,
		);
		blocked(
			decide(runtime, "lead", supervisorArgs(undefined, "high"), clusterHost),
			/ROUTE_THINKING_MISMATCH/,
			`${runtime}: supervisor at another thinking level`,
		);
		blocked(
			decide(runtime, "lead", { ...supervisorArgs("pi-supervisor/Mx/big"), settings: { thinkingOptionId: "max" } }, clusterHost),
			/ROUTE_PROVIDER_MISMATCH/,
			`${runtime}: supervisor on another family`,
		);
		blocked(
			decide(runtime, "lead", supervisorArgs(undefined, undefined, "REASONING_HIGH"), clusterHost),
			/ROUTE_CLASS_WRONG_FLOW.*a Lead seating its Supervisor routes from SUPERVISOR_GOVERNANCE/,
			`${runtime}: supervisor from a Peer class`,
		);
	}
});

test("Lead→Supervisor on a model-routing-only host: refused until SUPERVISOR_GOVERNANCE is configured, naming the command", () => {
	for (const runtime of RUNTIMES) {
		blocked(
			decide(runtime, "lead", supervisorArgs(), routingOnly),
			/ROUTE_CLASS_UNCONFIGURED — SUPERVISOR_GOVERNANCE has no route on host "minnyat".*optional class.*pteam routing set SUPERVISOR_GOVERNANCE --provider claude-supervisor --model <model-id> --thinking <level>.*does not fall back/,
			`${runtime}: optional class absent`,
		);
	}
});

// --- flow 3: Supervisor → Lead recovery ----------------------------------------

test("Supervisor→Lead recovery: matches LEAD_RECOVERY; refused on each difference and when unconfigured", () => {
	for (const runtime of RUNTIMES) {
		assert.equal(decide(runtime, "supervisor", recoveryArgs(), clusterHost), null, `${runtime}: matching recovery passes`);
		blocked(
			decide(runtime, "supervisor", recoveryArgs("pi-lead/Mx/mid"), clusterHost),
			/ROUTE_MODEL_MISMATCH.*Expected provider "pi-lead\/Mx\/big" with settings\.thinkingOptionId "high"/,
			`${runtime}: recovery on another model`,
		);
		blocked(
			decide(runtime, "supervisor", recoveryArgs(undefined, "low"), clusterHost),
			/ROUTE_THINKING_MISMATCH/,
			`${runtime}: recovery at another thinking level`,
		);
		blocked(
			decide(runtime, "supervisor", {
				...recoveryArgs("claude-lead/claude-opus-5", "high"),
				settings: { thinkingOptionId: "high", modeId: "auto" },
			}, clusterHost),
			/ROUTE_PROVIDER_MISMATCH/,
			`${runtime}: recovery on another family`,
		);
		blocked(
			decide(runtime, "supervisor", recoveryArgs(undefined, undefined, "REASONING_HIGH"), clusterHost),
			/ROUTE_CLASS_WRONG_FLOW.*Lead recovery routes from LEAD_RECOVERY/,
			`${runtime}: recovery from a Peer class`,
		);
		blocked(
			decide(runtime, "supervisor", recoveryArgs(), routingOnly),
			/ROUTE_CLASS_UNCONFIGURED — LEAD_RECOVERY.*pteam routing set LEAD_RECOVERY --provider pi-lead/,
			`${runtime}: LEAD_RECOVERY absent on a model-routing-only host`,
		);
	}
});

// --- class label ---------------------------------------------------------------

test("a missing or unknown class is refused on every flow", () => {
	for (const runtime of RUNTIMES) {
		blocked(
			decide(runtime, "lead", peerArgs("pi-peer/Mx/mid", "medium"), routingOnly),
			/ROUTE_CLASS_MISSING.*team\.model-class.*MONITOR_ECONOMY, FAST_READ/,
			`${runtime}: Lead→Peer without a class`,
		);
		blocked(
			decide(runtime, "lead", { ...supervisorArgs(), labels: { purpose: "governance" } }, clusterHost),
			/ROUTE_CLASS_MISSING.*SUPERVISOR_GOVERNANCE/,
			`${runtime}: Lead→Supervisor without a class`,
		);
		blocked(
			decide(runtime, "supervisor", { ...recoveryArgs(), labels: { purpose: "recovery", recovery_for: "proj" } }, clusterHost),
			/ROUTE_CLASS_MISSING.*LEAD_RECOVERY/,
			`${runtime}: recovery without a class`,
		);
		for (const bogus of ["coding_medium", " CODING_MEDIUM", "CODING-MEDIUM", "GOVERNANCE"]) {
			blocked(
				decide(runtime, "lead", peerArgs("pi-peer/Mx/mid", "medium", bogus), routingOnly),
				/ROUTE_CLASS_UNKNOWN/,
				`${runtime}: class "${bogus}"`,
			);
		}
	}
});

// --- mutation: casing / padding cannot bypass the gate ---------------------------

test("a differently-cased or padded provider never bypasses the gate", () => {
	for (const runtime of RUNTIMES) {
		for (const provider of [
			"Pi-Peer/Mx/mid",
			"PI-PEER/Mx/mid",
			" pi-peer/Mx/mid",
			"pi-peer /Mx/mid",
			"\tpi-peer/Mx/mid",
			// The same spellings carrying a WRONG model: if any of them skipped the
			// gate (parse failed → "not a create_agent we route"), this is the
			// string that would slip an unrouted model through.
			"Pi-Peer/Mx/big",
			" pi-peer/Any/model",
		]) {
			blocked(
				decide(runtime, "lead", peerArgs(provider, "medium", "CODING_MEDIUM"), routingOnly),
				/ROUTE_PROVIDER_NONCANONICAL.*must be written exactly "pi-peer"/,
				`${runtime}: provider ${JSON.stringify(provider)}`,
			);
		}
		// A padded MODEL is a different model id, not a spelling of the right one.
		blocked(
			decide(runtime, "lead", peerArgs("pi-peer/Mx/mid ", "medium", "CODING_MEDIUM"), routingOnly),
			/ROUTE_MODEL_MISMATCH/,
			`${runtime}: padded model`,
		);
		blocked(
			decide(runtime, "lead", peerArgs("pi-peer/Mx/mid", "Medium", "CODING_MEDIUM"), routingOnly),
			/ROUTE_THINKING_MISMATCH/,
			`${runtime}: cased thinking level (Paseo would run it at "medium" silently)`,
		);
		blocked(
			decide(runtime, "lead", peerArgs("codex-peer/x/y", "medium", "CODING_MEDIUM"), routingOnly),
			/ROUTE_PROVIDER_UNKNOWN/,
			`${runtime}: an unparseable provider is refused, not skipped`,
		);
	}
	// Pure function, directly: casing that parses still reaches the check.
	blocked(
		createAgentRouteBlockReason({
			role: "supervisor",
			args: recoveryArgs("PI-LEAD/Mx/big"),
			routeTable: clusterHost,
			env: ENFORCED,
		}),
		/ROUTE_PROVIDER_NONCANONICAL/,
		"recovery with a cased provider",
	);
});

// --- which file the gate reads ---------------------------------------------------

test("cluster host: the LOCAL host's routes are used, never the remote host's", () => {
	assert.equal(clusterHost.ok && clusterHost.hostId, "ctl");
	for (const runtime of RUNTIMES) {
		blocked(
			decide(runtime, "lead", peerArgs("pi-peer/Remote/only-on-mac", "low", "FAST_READ"), clusterHost),
			/ROUTE_MODEL_MISMATCH.*host "ctl"/,
			`${runtime}: the remote host's FAST_READ route does not authorise a local seat`,
		);
	}
});

test("file selection: shadowed legacy file, zero or two local hosts, invalid cluster never falls back", () => {
	const both = hostTable({ routing: { ...ROUTING_ONLY, hostId: "legacy" }, cluster: CLUSTER });
	assert.ok(both.ok);
	assert.equal(both.hostId, "ctl", "a cluster file with a local host wins");
	assert.match(String(both.shadowed), /model-routing\.local\.json$/);

	const remoteOnly = hostTable({
		routing: ROUTING_ONLY,
		cluster: { version: 1, hosts: { mac: CLUSTER.hosts.mac } },
	});
	assert.ok(remoteOnly.ok && remoteOnly.source === "routing" && remoteOnly.hostId === "minnyat");

	const twoLocals = hostTable({
		cluster: { version: 1, hosts: { a: CLUSTER.hosts.ctl, b: CLUSTER.hosts.ctl } },
	});
	assert.ok(!twoLocals.ok && twoLocals.code === "LOCAL_HOST_AMBIGUOUS");

	const invalidCluster = hostTable({ routing: ROUTING_ONLY, raw: { "cluster-routing.local.json": "{ not json" } });
	assert.ok(!invalidCluster.ok && invalidCluster.code === "CONFIG_INVALID");
	assert.match(invalidCluster.message, /does not fall back/);
});

// --- fail-closed ------------------------------------------------------------------

test("an unreadable, invalid or missing route file refuses every Lead/Supervisor create_agent", () => {
	const missing = hostTable({});
	const garbage = hostTable({ raw: { "model-routing.local.json": "{ nope" } });
	const invalid = hostTable({ routing: { version: 1, hostId: "h", routes: { FAST_READ: BASE_ROUTES.FAST_READ } } });
	// A directory where the file should be: it exists, and readFileSync fails
	// (EISDIR) — the "present but unreadable" case, distinct from absent.
	const unreadableDir = join(sandbox, "unreadable");
	mkdirSync(join(unreadableDir, "model-routing.local.json"), { recursive: true });
	const unreadableAgain = gateRouteTable({ env: { PST_TEAM_CONFIG_DIR: unreadableDir } }) as RouteTable;
	assert.equal(missing.ok, false);
	assert.equal(!missing.ok && missing.code, "ROUTE_FILE_MISSING");
	assert.equal(!garbage.ok && garbage.code, "CONFIG_INVALID");
	assert.equal(!invalid.ok && invalid.code, "CONFIG_INVALID");
	assert.equal(!unreadableAgain.ok && unreadableAgain.code, "CONFIG_INVALID");
	for (const runtime of RUNTIMES) {
		for (const [name, table] of [
			["missing", missing],
			["garbage", garbage],
			["invalid", invalid],
			["unreadable", unreadableAgain],
		] as const) {
			blocked(
				decide(runtime, "lead", peerArgs("pi-peer/Mx/mid", "medium", "CODING_MEDIUM"), table),
				/ROUTE_TABLE_UNAVAILABLE \((ROUTE_FILE_MISSING|CONFIG_INVALID)\).*model-routing\.local\.json/,
				`${runtime}: ${name} route file`,
			);
			blocked(decide(runtime, "supervisor", recoveryArgs(), table), /ROUTE_TABLE_UNAVAILABLE/, `${runtime}: ${name} (recovery)`);
		}
		// The adapter could not load a table at all: refused, not waved through.
		for (const table of [undefined, null]) {
			blocked(
				decide(runtime, "lead", peerArgs("pi-peer/Mx/mid", "medium", "CODING_MEDIUM"), table),
				/ROUTE_UNVERIFIABLE/,
				`${runtime}: route table ${table}`,
			);
		}
	}
});

// --- opt-out ------------------------------------------------------------------------

test("PASEO_TEAM_ROUTE_ENFORCE=off (exactly) disables the gate, loudly; anything else keeps it on", () => {
	const off = { PASEO_TEAM_ROUTE_ENFORCE: "off" };
	assert.equal(routeEnforcement(off), "off");
	assert.equal(routeEnforcement({}), "on");
	for (const runtime of RUNTIMES) {
		assert.equal(
			decide(runtime, "lead", peerArgs("pi-peer/any/model", "high"), undefined, off),
			null,
			`${runtime}: off skips the route gate`,
		);
		// The shape gates stay on: the opt-out is for the route, nothing else.
		blocked(
			decide(runtime, "lead", { provider: "claude-peer/claude-opus-5", settings: { thinkingOptionId: "high" } }, undefined, off),
			/settings\.modeId/,
			`${runtime}: the mode gate still runs with the route gate off`,
		);
		for (const value of ["OFF", "Off", " off", "0", "false", "no", "disabled", ""]) {
			blocked(
				decide(runtime, "lead", peerArgs("pi-peer/any/model", "high"), undefined, { PASEO_TEAM_ROUTE_ENFORCE: value }),
				/ROUTE_CLASS_MISSING/,
				`${runtime}: ${JSON.stringify(value)} is not the opt-out`,
			);
		}
	}
	const notice = routeEnforcementNotice("lead", off);
	assert.match(String(notice), /Route Enforcement: OFF[\s\S]*PASEO_TEAM_ROUTE_ENFORCE=off[\s\S]*never as a default/);
	assert.ok(routeEnforcementNotice("supervisor", off));
	assert.equal(routeEnforcementNotice("peer", off), null, "a Peer creates no agents");
	assert.equal(routeEnforcementNotice("lead", {}), null);
});

test("roles that create no agents are never route-gated", () => {
	assert.equal(
		createAgentRouteBlockReason({ role: "peer", args: {}, routeTable: null, env: ENFORCED }),
		null,
		"Peers are refused create_agent by the role policy, not by this gate",
	);
});

// --- the adapters' loaders ----------------------------------------------------------

test("Pi adapter's gate-routes subprocess answers exactly what the Claude hook loads in-process", () => {
	for (const files of [{ routing: ROUTING_ONLY }, { cluster: CLUSTER }, {}]) {
		const dir = join(sandbox, `subprocess-${(dirCount += 1)}`);
		mkdirSync(dir, { recursive: true });
		if ("routing" in files) writeFileSync(join(dir, "model-routing.local.json"), JSON.stringify(files.routing));
		if ("cluster" in files) writeFileSync(join(dir, "cluster-routing.local.json"), JSON.stringify(files.cluster));
		const env = { ...process.env, PST_TEAM_CONFIG_DIR: dir };
		const stdout = execFileSync(process.execPath, [join(ROOT, "scripts", "model-routing.mjs"), "gate-routes", "--json"], {
			env,
			encoding: "utf8",
		});
		assert.deepEqual(JSON.parse(stdout), gateRouteTable({ env: { PST_TEAM_CONFIG_DIR: dir } }));
	}
});

test("Claude hook end to end: the route gate runs in pre-tool-use, and the opt-out is announced every turn", async () => {
	const dir = join(sandbox, "hook-home");
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, "model-routing.local.json"), JSON.stringify(ROUTING_ONLY));
	// A pinned cluster, so the (earlier) cluster-label gate is satisfied the same
	// way wherever the suite runs from.
	const leadEnv = { PASEO_TEAM_HOME: dir, PASEO_PI_ROLE: "lead", PASEO_TEAM_CLUSTER: "route-gate" };
	const withCluster = (args: ReturnType<typeof peerArgs> | ReturnType<typeof supervisorArgs>) => ({
		...args,
		labels: { ...args.labels, "team.cluster": "route-gate" },
	});
	const call = (toolInput: ReturnType<typeof peerArgs> | ReturnType<typeof supervisorArgs>, env: Record<string, string> = leadEnv) =>
		handleEvent(
			"pre-tool-use",
			{ session_id: "route-gate", tool_name: "mcp__paseo__create_agent", tool_input: withCluster(toolInput) },
			env,
		);

	assert.equal(await call(peerArgs("pi-peer/Mx/mid", "medium", "CODING_MEDIUM")), null, "matching route is allowed");
	const refused = await call(peerArgs("pi-peer/Mx/big", "medium", "CODING_MEDIUM"));
	assert.equal(refused?.hookSpecificOutput?.permissionDecision, "deny");
	assert.match(String(refused?.hookSpecificOutput?.permissionDecisionReason), /ROUTE_MODEL_MISMATCH/);
	const seatSupervisor = await call(supervisorArgs());
	assert.match(String(seatSupervisor?.hookSpecificOutput?.permissionDecisionReason), /ROUTE_CLASS_UNCONFIGURED.*SUPERVISOR_GOVERNANCE/);

	const offEnv = { ...leadEnv, PASEO_TEAM_ROUTE_ENFORCE: "off" };
	assert.equal(await call(peerArgs("pi-peer/any/model", "high"), offEnv), null);
	const turn = await handleEvent("user-prompt-submit", { session_id: "route-gate", prompt: "next" }, offEnv);
	assert.match(String(turn?.hookSpecificOutput?.additionalContext), /Route Enforcement: OFF/);
	const quiet = await handleEvent("user-prompt-submit", { session_id: "route-gate", prompt: "next" }, leadEnv);
	assert.doesNotMatch(String(quiet?.hookSpecificOutput?.additionalContext ?? ""), /Route Enforcement: OFF/);
});

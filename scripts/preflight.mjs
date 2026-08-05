#!/usr/bin/env node
// preflight.mjs — host readiness check for the paseo-pi-team role pack.
//
// Usage:
//   node scripts/preflight.mjs [--json] [--strict] [--host-id <id>] [--cluster <path>]
//                              [--routes <path>] [--hosts <path>] [--skip-models]
//
// Checks (per host): node, git, paseo CLI + daemon, pi CLI, pi-mcp-adapter,
// role-pack extension + prompts, Paseo role providers, model inventory,
// routing-config validity, per-model thinking support, hosts config,
// cluster routing contract, endpoint env presence, repository state.
//
// Never prints secret values: only env-var NAMES are checked/reported.
// Exit code 1 when any check fails. In --strict mode, warnings that affect
// the ability to route the current task (missing routing config, unreadable
// model inventory, silently-clamped thinking levels, missing required remote
// endpoint env) are escalated to failures — unverifiable is NOT a pass.

import { execFileSync, execSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
	RoutingError,
	buildProviderInventory,
	defaultClusterRoutingPath,
	defaultRoutingDir,
	loadClusterConfig,
	loadRoutingConfig,
	missingHostCapabilities,
	modelsCacheKey,
	resolveClusterRoute,
	resolveRoute,
	validateRemoteEndpoint,
	cmdPercentExpansionRisk,
	MODEL_CLASSES,
	PROVIDER_OK_STATUSES,
} from "./model-routing.mjs";

const PINNED = Object.freeze({
	paseo: "0.2.5",
	pi: "0.83.0",
	adapter: "2.19.0",
	nodeMajor: 22,
});

const wantJson = process.argv.includes("--json");
const skipModels = process.argv.includes("--skip-models");
const wantStrict = process.argv.includes("--strict");
const opt = (name, fallback) => {
	const i = process.argv.indexOf(name);
	return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
};
const routesPath = opt(
	"--routes",
	join(defaultRoutingDir(), "model-routing.local.json"),
);
const hostsPath = opt("--hosts", join(defaultRoutingDir(), "hosts.local.json"));
const clusterPath = opt("--cluster", defaultClusterRoutingPath());
const hostIdArg = opt("--host-id", undefined);

const results = [];
function report(id, status, detail = "") {
	results.push({ id, status, detail });
	if (!wantJson) {
		const mark = status === "pass" ? "✓" : status === "warn" ? "⚠" : "✗";
		console.log(`${mark} ${id}${detail ? ` — ${detail}` : ""}`);
	}
}
const pass = (id, detail) => report(id, "pass", detail);
const warn = (id, detail) => report(id, "warn", detail);
const fail = (id, detail) => report(id, "fail", detail);
const clusterExplicit = process.argv.includes("--cluster");

/** In strict mode, route-affecting warnings are failures. */
const strictCheck = wantStrict ? fail : warn;

// On Windows, npm-installed CLIs (paseo, pi) are .cmd shims which execFile
// cannot spawn directly; route those through the shell via execSync. All
// arguments passed to tryExec are static literals (never user input), so
// joining them into a command string is safe.
const NEEDS_SHELL = process.platform === "win32";

function tryExec(cmd, argv, timeoutMs = 30000) {
	try {
		const stdout = NEEDS_SHELL
			? execSync([cmd, ...argv.map(String)].join(" "), {
					timeout: timeoutMs,
					encoding: "utf8",
					stdio: ["ignore", "pipe", "pipe"],
					env: process.env,
				})
			: execFileSync(cmd, argv, {
					timeout: timeoutMs,
					encoding: "utf8",
					stdio: ["ignore", "pipe", "pipe"],
					env: process.env,
				});
		return { ok: true, stdout };
	} catch (error) {
		return {
			ok: false,
			stdout: error?.stdout ? String(error.stdout) : "",
			error: String(error?.message ?? error),
		};
	}
}

function summarizeMessages() {
	if (results.some((r) => r.status === "fail")) return 1;
	return 0;
}

// --- node / git / CLIs --------------------------------------------------------

{
	const major = Number(process.versions.node.split(".")[0]);
	if (major >= PINNED.nodeMajor) pass("node", process.versions.node);
	else
		fail(
			"node",
			`node ${process.versions.node} < required ${PINNED.nodeMajor}`,
		);
}
{
	const git = tryExec("git", ["--version"]);
	if (git.ok) pass("git", git.stdout.trim());
	else fail("git", "git CLI not found");
}
{
	const v = tryExec("paseo", ["--version"]);
	if (!v.ok) fail("paseo-cli", "paseo CLI not found");
	else {
		const version = v.stdout.trim();
		if (version === PINNED.paseo) pass("paseo-cli", version);
		else
			warn(
				"paseo-cli",
				`detected ${version}, role pack was verified against ${PINNED.paseo}`,
			);
	}
}
{
	const v = tryExec("pi", ["--version"]);
	if (!v.ok) fail("pi-cli", "pi CLI not found");
	else {
		const version = v.stdout.trim();
		if (version === PINNED.pi) pass("pi-cli", version);
		else
			warn(
				"pi-cli",
				`detected ${version}, role pack was verified against ${PINNED.pi}`,
			);
	}
}

// --- daemon -------------------------------------------------------------------

let daemonUp = false;
{
	const status = tryExec("paseo", ["status", "--json"]);
	if (status.ok) {
		try {
			const parsed = JSON.parse(status.stdout);
			if (parsed.localDaemon) {
				daemonUp = true;
				pass("paseo-daemon", `${parsed.localDaemon} (${parsed.listen ?? "?"})`);
			} else {
				warn("paseo-daemon", "status returned but localDaemon field missing");
			}
		} catch {
			fail("paseo-daemon", "paseo status --json did not return JSON");
		}
	} else {
		fail("paseo-daemon", `daemon unreachable: ${status.error.slice(0, 160)}`);
	}
}

// --- pi-mcp-adapter -----------------------------------------------------------

{
	const list = tryExec("pi", ["list"]);
	const hasAdapter = list.ok && list.stdout.includes("pi-mcp-adapter");
	if (!hasAdapter) {
		fail(
			"mcp-adapter",
			"pi-mcp-adapter not installed → Paseo cannot inject MCP tools into pi agents (install: pi install npm:pi-mcp-adapter@" +
				PINNED.adapter +
				")",
		);
	} else {
		const pkgPath = join(
			homedir(),
			".pi",
			"agent",
			"npm",
			"node_modules",
			"pi-mcp-adapter",
			"package.json",
		);
		let version = "unknown";
		try {
			version = JSON.parse(readFileSync(pkgPath, "utf8")).version ?? "unknown";
		} catch {
			/* keep unknown */
		}
		if (version === PINNED.adapter) pass("mcp-adapter", version);
		else if (version === "unknown")
			warn("mcp-adapter", "installed but version unreadable");
		else warn("mcp-adapter", `detected ${version}, pinned ${PINNED.adapter}`);
	}
}

// --- role-pack installation ---------------------------------------------------

{
	const extPath = join(
		homedir(),
		".pi",
		"agent",
		"extensions",
		"paseo-team-policy.ts",
	);
	if (existsSync(extPath)) pass("extension", extPath);
	else fail("extension", `${extPath} missing → run scripts/install.{sh,ps1}`);
}
{
	const promptsDir = join(homedir(), ".pi", "agent", "extensions", "prompts");
	const missing = ["lead", "peer", "supervisor"].filter(
		(r) => !existsSync(join(promptsDir, `${r}.md`)),
	);
	if (missing.length === 0) pass("role-prompts", promptsDir);
	else fail("role-prompts", `missing prompts: ${missing.join(", ")}`);
}

// --- role providers + model inventory -----------------------------------------

const providersById = new Map();
if (daemonUp) {
	const ls = tryExec("paseo", ["provider", "ls", "--json"]);
	if (ls.ok) {
		try {
			const providers = JSON.parse(ls.stdout);
			for (const p of Array.isArray(providers) ? providers : []) {
				providersById.set(p.provider ?? p.id, p);
			}
		} catch {
			fail("role-providers", "paseo provider ls --json did not return JSON");
		}
		for (const role of ["pi-supervisor", "pi-lead", "pi-peer"]) {
			const entry = providersById.get(role);
			if (!entry)
				fail(`role-provider:${role}`, "not registered in ~/.paseo/config.json");
			else if (
				String(entry.enabled).toLowerCase() !== "enabled" &&
				entry.enabled !== true
			) {
				fail(`role-provider:${role}`, "registered but disabled");
			} else {
				// A provider can be enabled AND unhealthy — printing the status
				// next to a ✓ is a false pass. Reject the same statuses the
				// route resolver rejects.
				const status =
					typeof entry.status === "string" ? entry.status.toLowerCase() : null;
				if (status !== null && !PROVIDER_OK_STATUSES.has(status)) {
					fail(
						`role-provider:${role}`,
						`status "${entry.status}" is unhealthy (expected: ${[...PROVIDER_OK_STATUSES].join("/")})`,
					);
				} else {
					pass(`role-provider:${role}`, String(entry.status ?? "ok"));
				}
			}
		}
	} else {
		fail("role-providers", "could not list providers");
	}
}

const modelsCache = new Map();
function listModels(roleProvider) {
	if (modelsCache.has(roleProvider)) return modelsCache.get(roleProvider);
	const res = tryExec(
		"paseo",
		["provider", "models", roleProvider, "--json"],
		120000,
	);
	if (!res.ok) {
		modelsCache.set(roleProvider, null);
		return null;
	}
	try {
		const models = JSON.parse(res.stdout);
		modelsCache.set(roleProvider, models);
		return models;
	} catch {
		modelsCache.set(roleProvider, null);
		return null;
	}
}

// --- routing config + routes ---------------------------------------------------

const routesExplicit = process.argv.includes("--routes");
let routing = null;
if (!existsSync(routesPath)) {
	if (routesExplicit) {
		fail("routing-config", `${routesPath} (explicit --routes) does not exist`);
	} else {
		strictCheck(
			"routing-config",
			`${routesPath} missing (copy config/model-routing.example.json and edit). Routing checks skipped.`,
		);
	}
} else {
	try {
		routing = loadRoutingConfig(routesPath);
		pass("routing-config", `hostId=${routing.hostId}`);
	} catch (error) {
		if (error instanceof RoutingError) fail("routing-config", error.message);
		else fail("routing-config", String(error));
	}
}

// Per-model thinkingLevelMap from ~/.pi/agent/models.json (level null = unsupported).
function piModelLevelUnreachable(piProvider, modelId, level) {
	const modelsJsonPath = join(homedir(), ".pi", "agent", "models.json");
	if (!existsSync(modelsJsonPath)) return false;
	try {
		const data = JSON.parse(readFileSync(modelsJsonPath, "utf8"));
		const provider = data?.providers?.[piProvider];
		if (!provider) return false;
		const model = (provider.models ?? []).find((m) => m?.id === modelId);
		const map = model?.thinkingLevelMap;
		if (map && level in map && map[level] === null) return true;
	} catch {
		/* unreadable → do not block */
	}
	return false;
}

if (routing && daemonUp && !skipModels) {
	for (const modelClass of MODEL_CLASSES) {
		const route = routing.routes[modelClass];
		const models = listModels(route.paseoProvider);
		if (models === null) {
			strictCheck(
				`route:${modelClass}`,
				`could not list models for ${route.paseoProvider} (daemon busy?)${wantStrict ? " — strict: unverifiable is not a pass" : ""}`,
			);
			continue;
		}
		// buildProviderInventory keeps `status` intact and the resolver runs
		// in strict mode when --strict was passed — an enabled-but-erroring
		// provider or an unverifiable thinking list must NOT be a pass.
		const inventory = {
			providers: buildProviderInventory([...providersById.values()]),
			models,
		};
		try {
			const resolved = resolveRoute(routing, modelClass, inventory, {
				strict: wantStrict,
			});
			// Per-model thinkingLevelMap guard (Paseo's list does not reflect it).
			const { provider: piProvider, model: modelId } = (() => {
				const i = resolved.model.indexOf("/");
				return {
					provider: resolved.model.slice(0, i),
					model: resolved.model.slice(i + 1),
				};
			})();
			if (piModelLevelUnreachable(piProvider, modelId, route.thinking)) {
				strictCheck(
					`route:${modelClass}`,
					`model ${route.model} has thinkingLevelMap.${route.thinking}=null in ~/.pi/agent/models.json — pi will CLAMP the level silently; pick a supported level or another model`,
				);
			} else {
				pass(
					`route:${modelClass}`,
					`${resolved.createAgentProvider} + thinking=${route.thinking}`,
				);
			}
		} catch (error) {
			if (error instanceof RoutingError)
				fail(`route:${modelClass}`, error.message);
			else fail(`route:${modelClass}`, String(error));
		}
	}
} else if (routing && skipModels) {
	warn("routes", "model inventory checks skipped (--skip-models)");
}

// --- hosts config ---------------------------------------------------------------

if (existsSync(hostsPath)) {
	try {
		const data = JSON.parse(readFileSync(hostsPath, "utf8"));
		const hosts = data?.hosts ?? {};
		let problems = 0;
		for (const [hostId, entry] of Object.entries(hosts)) {
			if (typeof entry !== "object" || entry === null) {
				fail(`host:${hostId}`, "host entry must be an object");
				problems++;
				continue;
			}
			if (
				hostId !== "local" &&
				typeof entry.endpointEnv === "string" &&
				entry.endpointEnv.trim() !== ""
			) {
				if (process.env[entry.endpointEnv]) {
					pass(
						`host:${hostId}`,
						`endpoint env ${entry.endpointEnv} present (value not printed)`,
					);
				} else {
					warn(
						`host:${hostId}`,
						`endpoint env ${entry.endpointEnv} NOT set — remote routing to this host is blocked`,
					);
				}
			} else if (hostId !== "local") {
				warn(
					`host:${hostId}`,
					"no endpointEnv — only local-daemon routing is available for this host entry",
				);
			} else {
				pass(`host:${hostId}`, "local daemon entry");
			}
		}
		if (problems === 0) pass("hosts-config", hostsPath);
	} catch (error) {
		fail(
			"hosts-config",
			`hosts file is not valid JSON: ${String(error?.message ?? error)}`,
		);
	}
} else {
	warn(
		"hosts-config",
		`${hostsPath} missing (copy config/hosts.example.json for multi-host; single-host can ignore)`,
	);
}

// --- live remote preflight helpers ---------------------------------------------

/** Structural endpoint validation lives in model-routing.mjs so it can be
 * unit-tested: parse-based per scheme (offer URL / tcp:// with query params /
 * host:port), never a raw character whitelist. */
const isSafeEndpointValue = validateRemoteEndpoint;

/** Chars that can never appear in ANY argv element we quote for cmd.exe
 * (static literals are short ascii; endpoint values already passed the
 * stricter isSafeEndpointValue check). */
const UNSAFE_ARGV_RE = /[\s"'`<>|()[\]{}\\]/;

/** Quote one argv element for cmd.exe when NEEDS_SHELL joins the command. */
function cmdQuote(value) {
	if (UNSAFE_ARGV_RE.test(value)) {
		throw new Error(`refusing to pass unsafe argv value to shell`);
	}
	return `"${value}"`;
}
/** Run a paseo CLI command. On Windows (.cmd shims) every argv element is
 * quoted through cmdQuote; endpoint values carry secrets so they ONLY ever
 * travel inside argv — they are logged nowhere. */
function remoteExec(argv, timeoutMs = 60000) {
	if (NEEDS_SHELL) {
		return tryExecRaw(
			[argv[0], ...argv.slice(1).map(cmdQuote)].join(" "),
			timeoutMs,
		);
	}
	return tryExec(argv[0], argv.slice(1), timeoutMs);
}

function tryExecRaw(commandString, timeoutMs) {
	try {
		const stdout = execSync(commandString, {
			timeout: timeoutMs,
			encoding: "utf8",
			stdio: ["ignore", "pipe", "pipe"],
			env: process.env,
		});
		return { ok: true, stdout };
	} catch (error) {
		return {
			ok: false,
			stdout: error?.stdout ? String(error.stdout) : "",
			error: String(error?.message ?? error),
		};
	}
}

const remoteModelsCache = new Map();
/**
 * Model inventory is per-DAEMON. The cache key must therefore carry the
 * host identity, never the role-provider name alone — two remote hosts
 * serving the same "pi-peer" provider do NOT share an inventory, and a
 * mixed cache would let a preflight pass on a model that only exists on
 * the other host.
 */
function listModelsRemote(hostId, endpointValue, roleProvider) {
	const key = modelsCacheKey(hostId, roleProvider);
	if (remoteModelsCache.has(key)) {
		return remoteModelsCache.get(key);
	}
	const res = remoteExec(
		[
			"paseo",
			"provider",
			"models",
			roleProvider,
			"--host",
			endpointValue,
			"--json",
		],
		120000,
	);
	let models = null;
	if (res.ok) {
		try {
			const parsed = JSON.parse(res.stdout);
			models = Array.isArray(parsed) ? parsed : (parsed?.models ?? null);
		} catch {
			models = null;
		}
	}
	remoteModelsCache.set(key, models);
	return models;
}

function runRemotePreflight(hostId, host, endpointValue) {
	// 1. daemon reachable?
	const reach = remoteExec(["paseo", "ls", "--host", endpointValue, "--json"]);
	if (!reach.ok) {
		fail(
			`cluster-remote:${hostId}`,
			`remote daemon unreachable via ${host.connection.endpointEnv}: ${String(reach.error).slice(0, 120)}`,
		);
		return;
	}
	pass(`cluster-remote:${hostId}`, "remote daemon reachable (offer accepted)");

	// 2. role providers present + enabled + healthy on the remote daemon.
	const ls = remoteExec([
		"paseo",
		"provider",
		"ls",
		"--host",
		endpointValue,
		"--json",
	]);
	const remoteProviders = new Map();
	if (ls.ok) {
		try {
			for (const p of JSON.parse(ls.stdout)) {
				remoteProviders.set(p.provider ?? p.id, p);
			}
		} catch {
			fail(
				`cluster-remote:${hostId}:providers`,
				"provider ls --json unparseable",
			);
			return;
		}
	} else {
		fail(
			`cluster-remote:${hostId}:providers`,
			"could not list remote providers",
		);
		return;
	}
	const neededProviders = new Set(
		Object.values(host.routes).map((r) => r.paseoProvider),
	);
	for (const roleProvider of neededProviders) {
		const entry = remoteProviders.get(roleProvider);
		const status = String(entry?.status ?? "").toLowerCase();
		const enabled =
			entry?.enabled === true ||
			String(entry?.enabled ?? "").toLowerCase() === "enabled";
		if (!entry) {
			fail(
				`cluster-remote:${hostId}:provider:${roleProvider}`,
				"role provider NOT registered on remote daemon",
			);
		} else if (!enabled || !PROVIDER_OK_STATUSES.has(status)) {
			fail(
				`cluster-remote:${hostId}:provider:${roleProvider}`,
				`status="${entry.status}" enabled=${entry.enabled} (need enabled + healthy status: ${[...PROVIDER_OK_STATUSES].join("/")})`,
			);
		} else {
			pass(
				`cluster-remote:${hostId}:provider:${roleProvider}`,
				"enabled + healthy",
			);
		}
	}

	// 3. Route resolution against the REMOTE inventory.
	const inventoryProviders = buildProviderInventory([
		...remoteProviders.values(),
	]);
	for (const modelClass of MODEL_CLASSES) {
		const route = host.routes[modelClass];
		const models = listModelsRemote(hostId, endpointValue, route.paseoProvider);
		if (models === null) {
			strictCheck(
				`cluster-remote:${hostId}:route:${modelClass}`,
				`could not list models for ${route.paseoProvider} on remote`,
			);
			continue;
		}
		try {
			const resolved = resolveClusterRoute(
				cluster,
				hostId,
				modelClass,
				{ providers: inventoryProviders, models },
				{ strict: wantStrict },
			);
			pass(
				`cluster-remote:${hostId}:route:${modelClass}`,
				resolved.createAgentProvider,
			);
		} catch (error) {
			fail(
				`cluster-remote:${hostId}:route:${modelClass}`,
				error instanceof RoutingError ? error.message : String(error),
			);
		}
	}
}

// The repo-clean writer gate must use the host that was actually selected
// for verification (possibly inferred), not only an explicit --host-id.
let clusterVerifyHostId;

// --- cluster routing contract (controller-local) ------------------------------

// In strict mode the cluster contract file is REQUIRED (missing → exit 1).
// Otherwise absence only warns so single-host dev setups keep working.
let cluster = null;
if (existsSync(clusterPath)) {
	try {
		cluster = loadClusterConfig(clusterPath);
		pass(
			"cluster-config",
			`${Object.keys(cluster.hosts).length} host(s): ${Object.keys(cluster.hosts).join(", ")}`,
		);
	} catch (error) {
		fail(
			"cluster-config",
			error instanceof RoutingError ? error.message : String(error),
		);
	}
} else if (clusterExplicit || wantStrict) {
	fail("cluster-config", `${clusterPath} missing (required in strict mode)`);
} else {
	warn(
		"cluster-config",
		`${clusterPath} missing (copy config/cluster-routing.example.json; required for cross-host routing)`,
	);
}

if (cluster) {
	for (const [hostId, host] of Object.entries(cluster.hosts)) {
		// Required remote hosts must have their endpoint env present; the VALUE
		// is never read or printed — only name-based presence is checked.
		if (host.connection.type === "remote" && host.required) {
			const envName = host.connection.endpointEnv;
			if (envName && process.env[envName]) {
				pass(
					`cluster-host:${hostId}`,
					`endpoint env ${envName} present (value not printed)`,
				);
			} else {
				strictCheck(
					`cluster-host:${hostId}`,
					`required remote host but endpoint env ${envName ?? "<missing endpointEnv>"} NOT set`,
				);
			}
		}
		// Capability contract: a host that claims review roles must not also be
		// a writer; writer hosts must carry the writer capabilities.
		if (host.limits.writers > 0) {
			const missing = missingHostCapabilities(host, "writer");
			if (missing.length > 0) {
				fail(
					`cluster-host:${hostId}`,
					`declares writers=${host.limits.writers} but lacks writer capabilities: ${missing.join(", ")}`,
				);
			}
		}
	}

	// Resolve the route for the host this preflight was asked to verify.
	// Verify targets a single host: --host-id, or the only host when the
	// cluster has exactly one. Nothing is ever verified silently — every
	// skip produces an explicit result line.
	const verifyHostId =
		hostIdArg ??
		(Object.keys(cluster.hosts).length === 1
			? Object.keys(cluster.hosts)[0]
			: undefined);
	if (!hostIdArg && verifyHostId === undefined && wantStrict) {
		fail(
			"cluster-host-select",
			"multiple hosts in cluster config; strict preflight requires --host-id <id>",
		);
	} else if (!hostIdArg && verifyHostId === undefined) {
		warn(
			"cluster-host-select",
			`multiple hosts in cluster config (${Object.keys(cluster.hosts).join(", ")}); no per-host route verification performed — pass --host-id <id>`,
		);
	}
	clusterVerifyHostId = verifyHostId;
	if (verifyHostId !== undefined) {
		const host = cluster.hosts[verifyHostId];
		if (!host) {
			fail(
				`cluster-host:${verifyHostId}`,
				`--host-id "${verifyHostId}" not present in cluster routing config`,
			);
		} else if (host.connection.type === "local" && skipModels) {
			warn(
				`cluster-route:${verifyHostId}`,
				"local route verification skipped (--skip-models)",
			);
		} else if (host.connection.type === "local" && daemonUp && !skipModels) {
			// Local host: full route resolution against the live daemon, strict.
			for (const modelClass of MODEL_CLASSES) {
				const route = host.routes[modelClass];
				const models = listModels(route.paseoProvider);
				if (models === null) {
					strictCheck(
						`cluster-route:${verifyHostId}:${modelClass}`,
						`could not list models for ${route.paseoProvider}`,
					);
					continue;
				}
				const inventory = {
					providers: buildProviderInventory([...providersById.values()]),
					models,
				};
				try {
					const resolved = resolveClusterRoute(
						cluster,
						verifyHostId,
						modelClass,
						inventory,
						{ strict: wantStrict },
					);
					pass(
						`cluster-route:${verifyHostId}:${modelClass}`,
						resolved.createAgentProvider,
					);
				} catch (error) {
					fail(
						`cluster-route:${verifyHostId}:${modelClass}`,
						error instanceof RoutingError ? error.message : String(error),
					);
				}
			}
		} else if (host.connection.type === "remote") {
			// Remote host: if the endpoint env is set AND the value passes a
			// strict shape check, perform a LIVE remote preflight via the Paseo
			// CLI (the offer URL / tcp endpoint is accepted as --host). The
			// endpoint value is never logged.
			const envName = host.connection.endpointEnv;
			const envValue = envName ? process.env[envName] : undefined;
			if (!envValue) {
				strictCheck(
					`cluster-remote:${verifyHostId}`,
					`endpoint env ${envName ?? "<missing>"} NOT set — live remote preflight skipped`,
				);
			} else if (!isSafeEndpointValue(envValue)) {
				fail(
					`cluster-remote:${verifyHostId}`,
					`endpoint env ${envName} has an unexpected shape (expected paseo offer URL or tcp:// target) — refusing to use it`,
				);
			} else if (NEEDS_SHELL && cmdPercentExpansionRisk(envValue)) {
				// cmd.exe expands %VAR% before paseo sees the argv — the endpoint
				// would be silently corrupted or leak into expansions. Fail loudly
				// rather than trying to out-quote cmd's parser.
				fail(
					`cluster-remote:${verifyHostId}`,
					`endpoint env ${envName} contains 2+ '%' characters — unsafe with cmd.exe %VAR% expansion on Windows controllers (use a pairing offer URL or a non-cmd controller)`,
				);
			} else if (skipModels) {
				warn(
					`cluster-remote:${verifyHostId}`,
					"endpoint set but --skip-models active — remote inventory checks skipped",
				);
			} else {
				runRemotePreflight(verifyHostId, host, envValue);
			}
		} else if (!daemonUp) {
			strictCheck(
				`cluster-host:${verifyHostId}`,
				"local daemon down — cluster route resolution skipped",
			);
		}
	}
}

// --- repository state (if run inside a repo) ------------------------------------

{
	const repo = tryExec("git", ["rev-parse", "--is-inside-work-tree"]);
	if (repo.ok && repo.stdout.trim() === "true") {
		const status = tryExec("git", ["status", "--porcelain"]);
		if (status.ok && status.stdout.trim() === "") {
			pass("repo-clean", "working tree clean");
		} else if (status.ok) {
			const dirtyWriter =
				clusterVerifyHostId !== undefined &&
				cluster !== null &&
				cluster.hosts[clusterVerifyHostId] &&
				cluster.hosts[clusterVerifyHostId].limits.writers > 0;
			if (dirtyWriter) {
				strictCheck(
					"repo-clean",
					`writer host "${clusterVerifyHostId}" has uncommitted changes — writer workspaces must start clean`,
				);
			} else if (status.ok) {
				warn(
					"repo-clean",
					"uncommitted changes present (user-owned changes must never be overwritten by agents)",
				);
			}
		}
	}
}

if (wantJson) {
	console.log(
		JSON.stringify(
			{ checks: results, ok: !results.some((r) => r.status === "fail") },
			null,
			2,
		),
	);
}
process.exit(summarizeMessages());

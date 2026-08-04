#!/usr/bin/env node
// preflight.mjs — host readiness check for the paseo-pi-team role pack.
//
// Usage:
//   node scripts/preflight.mjs [--json] [--routes <path>] [--hosts <path>] [--skip-models]
//
// Checks (per host): node, git, paseo CLI + daemon, pi CLI, pi-mcp-adapter,
// role-pack extension + prompts, Paseo role providers, model inventory,
// routing-config validity, per-model thinking support, hosts config,
// endpoint env presence, repository state.
//
// Never prints secret values: only env-var NAMES are checked/reported.
// Exit code 1 when any check fails (warnings do not fail).

import { execFileSync, execSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
	RoutingError,
	loadRoutingConfig,
	resolveRoute,
	MODEL_CLASSES,
	defaultRoutingDir,
} from "./model-routing.mjs";

const PINNED = Object.freeze({
	paseo: "0.2.5",
	pi: "0.83.0",
	adapter: "2.19.0",
	nodeMajor: 22,
});

const wantJson = process.argv.includes("--json");
const skipModels = process.argv.includes("--skip-models");
const opt = (name, fallback) => {
	const i = process.argv.indexOf(name);
	return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
};
const routesPath = opt(
	"--routes",
	join(defaultRoutingDir(), "model-routing.local.json"),
);
const hostsPath = opt("--hosts", join(defaultRoutingDir(), "hosts.local.json"));

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
				pass(`role-provider:${role}`, String(entry.status ?? "ok"));
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
		warn(
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
			warn(
				`route:${modelClass}`,
				`could not list models for ${route.paseoProvider} (daemon busy?)`,
			);
			continue;
		}
		const inventory = {
			providers: [...providersById.values()].map((p) => ({
				id: p.provider ?? p.id,
				enabled:
					String(p.enabled).toLowerCase() === "enabled" || p.enabled === true,
			})),
			models,
		};
		try {
			const resolved = resolveRoute(routing, modelClass, inventory);
			// Per-model thinkingLevelMap guard (Paseo's list does not reflect it).
			const { provider: piProvider, model: modelId } = (() => {
				const i = resolved.model.indexOf("/");
				return {
					provider: resolved.model.slice(0, i),
					model: resolved.model.slice(i + 1),
				};
			})();
			if (piModelLevelUnreachable(piProvider, modelId, route.thinking)) {
				warn(
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

// --- repository state (if run inside a repo) ------------------------------------

{
	const repo = tryExec("git", ["rev-parse", "--is-inside-work-tree"]);
	if (repo.ok && repo.stdout.trim() === "true") {
		const status = tryExec("git", ["status", "--porcelain"]);
		if (status.ok && status.stdout.trim() === "") {
			pass("repo-clean", "working tree clean");
		} else if (status.ok) {
			warn(
				"repo-clean",
				"uncommitted changes present (user-owned changes must never be overwritten by agents)",
			);
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

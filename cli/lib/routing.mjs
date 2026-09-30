/**
 * routing.mjs — `pteam routing show|check|set|unset`.
 *
 * The route file is what the create_agent gate compares every Lead/Supervisor
 * seating against, so editing it has to be as strict as the gate itself:
 *
 *   - every read goes through scripts/model-routing.mjs (loadLocalRouteTable,
 *     validateRoutingConfig/validateClusterConfig, resolveRoute) — this file
 *     parses no route on its own;
 *   - `set` validates the new route with resolveRoute in STRICT mode against
 *     the live inventory, exactly like `preflight --strict`, and writes nothing
 *     when it does not resolve;
 *   - every write copies the previous file to `<file>.bak-<epoch>` and renames
 *     a temp file over the original (config-walker's atomicWrite), the same
 *     convention as `pteam config write`.
 *
 * Without --host-id, set/unset edit the file AND host the gate reads (the
 * single local host of cluster-routing.local.json, else
 * model-routing.local.json) — editing a file the gate ignores would look like
 * a fix and change nothing. --host-id targets that host in the cluster file.
 *
 * Nothing here prints a secret: route files hold none (remote endpoints are
 * env-var NAMES, and those are never read).
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import * as cw from "./config-walker.mjs";
import { runPaseoJson, PaseoError } from "./paseo-bridge.mjs";
import { teamConfigDir } from "../../scripts/lib-common.mjs";
import {
	ALL_MODEL_CLASSES,
	CLASS_REQUIRED_ROLE,
	MODEL_CLASSES,
	OPTIONAL_MODEL_CLASSES,
	ROLE_PROVIDERS,
	ROUTE_ENFORCE_ENV,
	RoutingError,
	THINKING_LEVELS_BY_FAMILY,
	composeProviderModel,
	loadLocalRouteTable,
	providerFamily,
	resolveRoute,
	validateClusterConfig,
	validateRoutingConfig,
} from "../../scripts/model-routing.mjs";

/** A refusal the command reports and exits 1 on (2 is kept for usage). */
export class RoutingCommandError extends Error {
	constructor(code, message, details = {}) {
		// A RoutingError's message already starts with its code; say it once.
		super(message.startsWith(`${code}: `) ? message.slice(code.length + 2) : message);
		this.name = "RoutingCommandError";
		this.code = code;
		this.details = details;
	}
}

/** The two route files, under the same config-dir resolution the gate uses. */
function paths(env) {
	const dir = teamConfigDir(env);
	return {
		routing: join(dir, "model-routing.local.json"),
		cluster: join(dir, "cluster-routing.local.json"),
	};
}

export function enforcementState(env = process.env) {
	return env[ROUTE_ENFORCE_ENV] === "off" ? "off" : "on";
}

function enforcementWarning(env) {
	return enforcementState(env) === "off"
		? `${ROUTE_ENFORCE_ENV}=off in this environment — create_agent is NOT checked against these routes. An emergency opt-out, never a default; unset it.`
		: null;
}

function describeRoutes(routes) {
	return ALL_MODEL_CLASSES.map((modelClass) => {
		const route = routes?.[modelClass];
		const required = MODEL_CLASSES.includes(modelClass);
		if (!route) return { class: modelClass, required, configured: false };
		return {
			class: modelClass,
			required,
			configured: true,
			paseoProvider: route.paseoProvider,
			model: route.model,
			thinking: route.thinking,
			createAgentProvider: composeProviderModel(route.paseoProvider, route.model),
		};
	});
}

/** `routing show` — the table the gate reads, per class, unset optional ones marked. */
export function routingShow({ env = process.env } = {}) {
	const table = loadLocalRouteTable({ env });
	const warnings = [enforcementWarning(env)].filter(Boolean);
	if (!table.ok) {
		return {
			ok: false,
			enforcement: enforcementState(env),
			code: table.code,
			message: table.message,
			paths: table.paths,
			warnings,
		};
	}
	if (table.shadowed) {
		warnings.push(`${table.shadowed} exists but is NOT read: the cluster file's local host "${table.hostId}" is the source`);
	}
	const classes = describeRoutes(table.routes);
	for (const entry of classes) {
		if (!entry.required && !entry.configured) {
			warnings.push(`${entry.class} is not configured — the gate refuses the flow that needs it (pteam routing set ${entry.class} ...)`);
		}
	}
	return {
		ok: true,
		enforcement: enforcementState(env),
		source: table.source,
		path: table.path,
		hostId: table.hostId,
		classes,
		warnings,
	};
}

/**
 * The live inventory for one role provider on the LOCAL daemon: the same two
 * reads preflight makes (`provider ls`, `provider models <rp>`). An `{ error }`
 * body or a non-array answer is a failure, never "zero models".
 */
export async function liveInventory(paseoProvider, { timeoutMs = 20_000 } = {}) {
	const read = async (args) => {
		try {
			const payload = await runPaseoJson(args, { timeoutMs });
			if (!Array.isArray(payload)) {
				const message =
					payload && typeof payload === "object" && payload.error
						? String(payload.error.message ?? payload.error)
						: "paseo returned no list";
				return { ok: false, message: `paseo ${args.join(" ")}: ${message}` };
			}
			return { ok: true, value: payload };
		} catch (error) {
			const code = error instanceof PaseoError ? error.code : "PASEO_FAILED";
			return { ok: false, message: `paseo ${args.join(" ")} failed (${code}): ${String(error?.message ?? error)}` };
		}
	};
	const providers = await read(["provider", "ls"]);
	if (!providers.ok) return providers;
	const models = await read(["provider", "models", paseoProvider]);
	if (!models.ok) return models;
	return { ok: true, inventory: { providers: providers.value, models: models.value } };
}

/**
 * The file (and cluster host) a set/unset edits.
 * @returns {{kind: "routing"|"cluster", path: string, hostId: string, raw: object}}
 */
function editTarget(env, hostIdArg) {
	const p = paths(env);
	if (hostIdArg !== undefined) {
		if (!existsSync(p.cluster)) {
			throw new RoutingCommandError(
				"CLUSTER_FILE_MISSING",
				`--host-id targets a host in ${p.cluster}, which does not exist (copy config/cluster-routing.example.json)`,
			);
		}
		const text = readText(p.cluster);
		const raw = parseJson(p.cluster, text);
		if (!raw?.hosts || typeof raw.hosts !== "object" || !(hostIdArg in raw.hosts)) {
			throw new RoutingCommandError(
				"HOST_UNKNOWN",
				`host "${hostIdArg}" is not in ${p.cluster} (hosts: ${Object.keys(raw?.hosts ?? {}).join(", ") || "none"})`,
			);
		}
		return { kind: "cluster", path: p.cluster, hostId: hostIdArg, raw, text };
	}
	const table = loadLocalRouteTable({ env });
	if (!table.ok) {
		throw new RoutingCommandError(
			table.code,
			table.code === "ROUTE_FILE_MISSING"
				? `${table.message}. \`routing set\` edits an existing route file; it does not invent the five required classes.`
				: `${table.message}. Fix the file first (pteam config read routing / cluster); \`routing set\` will not rewrite a file that does not load.`,
			{ paths: table.paths },
		);
	}
	const text = readText(table.path);
	return {
		kind: table.source,
		path: table.path,
		hostId: table.hostId,
		raw: parseJson(table.path, text),
		text,
	};
}

function readText(path) {
	try {
		return readFileSync(path, "utf8");
	} catch (error) {
		throw new RoutingCommandError("CONFIG_INVALID", `${path} is not readable: ${String(error?.message ?? error)}`);
	}
}

function parseJson(path, text) {
	try {
		return JSON.parse(text);
	} catch (error) {
		throw new RoutingCommandError("CONFIG_INVALID", `${path} is not readable JSON: ${String(error?.message ?? error)}`);
	}
}

function routesOf(target) {
	if (target.kind === "cluster") {
		const host = target.raw.hosts[target.hostId];
		host.routes = host.routes && typeof host.routes === "object" ? host.routes : {};
		return host.routes;
	}
	target.raw.routes = target.raw.routes && typeof target.raw.routes === "object" ? target.raw.routes : {};
	return target.raw.routes;
}

/** Validate the whole candidate document with the resolver's own validator. */
function validateCandidate(target) {
	try {
		if (target.kind === "cluster") validateClusterConfig(target.raw);
		else validateRoutingConfig(target.raw);
	} catch (error) {
		throw new RoutingCommandError(
			error instanceof RoutingError ? error.code : "CONFIG_INVALID",
			`${String(error?.message ?? error)} — nothing written`,
		);
	}
}

/**
 * Write the edited document — but only over the exact bytes it was read from.
 * `set` awaits the live inventory between reading and writing (seconds, on a
 * cold daemon); an edit made meanwhile — another `routing set`, the WebUI, a
 * hand edit — would otherwise be overwritten with no trace. Compared on the
 * CONTENT, not mtime+size: a same-size edit within one mtime tick is exactly
 * the case a stat comparison misses.
 */
function writeTarget(target) {
	let current;
	try {
		current = readFileSync(target.path, "utf8");
	} catch (error) {
		throw new RoutingCommandError("CONCURRENT_EDIT", `${target.path} could not be re-read before writing (${String(error?.message ?? error)}) — nothing written`);
	}
	if (current !== target.text) {
		throw new RoutingCommandError(
			"CONCURRENT_EDIT",
			`${target.path} changed while this command was validating the route — nothing written, so that edit is not lost. Re-run the command against the file as it is now.`,
		);
	}
	const backup = cw.atomicWrite(target.path, `${JSON.stringify(target.raw, null, 2)}\n`);
	return backup;
}

export function requireClass(modelClass) {
	if (!ALL_MODEL_CLASSES.includes(modelClass)) {
		throw new RoutingCommandError(
			"CLASS_UNKNOWN",
			`unknown class "${modelClass ?? ""}" (expected one of: ${ALL_MODEL_CLASSES.join(", ")})`,
		);
	}
}

/**
 * `routing set` — validate strictly against the live inventory, then write.
 *
 * `inventoryFor` is injectable for tests; production reads the local daemon.
 */
export async function routingSet(
	{ modelClass, provider, model, thinking, hostId },
	{ env = process.env, inventoryFor = liveInventory } = {},
) {
	requireClass(modelClass);
	if (!ROLE_PROVIDERS.includes(provider)) {
		throw new RoutingCommandError(
			"PROVIDER_INVALID",
			`--provider "${provider ?? ""}" must be a role provider (${ROLE_PROVIDERS.join(", ")})`,
		);
	}
	const requiredRole = CLASS_REQUIRED_ROLE[modelClass];
	if (requiredRole && !provider.endsWith(`-${requiredRole}`)) {
		throw new RoutingCommandError(
			"PROVIDER_INVALID",
			`${modelClass} seats a ${requiredRole}: --provider must be ${ROLE_PROVIDERS.filter((name) => name.endsWith(`-${requiredRole}`)).join(" or ")} (got "${provider}")`,
		);
	}
	if (typeof model !== "string" || model === "" || model !== model.trim()) {
		throw new RoutingCommandError("MODEL_INVALID", "--model must be a non-empty model id with no surrounding whitespace");
	}
	const levels = THINKING_LEVELS_BY_FAMILY[providerFamily(provider)] ?? [];
	if (!levels.includes(thinking)) {
		throw new RoutingCommandError(
			"THINKING_INVALID",
			`--thinking "${thinking ?? ""}" is not a ${providerFamily(provider)} thinking level (${levels.join(", ")})`,
		);
	}

	const target = editTarget(env, hostId);
	if (target.kind === "cluster") {
		const type = target.raw.hosts[target.hostId]?.connection?.type;
		if (type !== "local") {
			throw new RoutingCommandError(
				"REMOTE_HOST_UNVERIFIABLE",
				`host "${target.hostId}" is connection.type "${type}" — its inventory lives on another daemon, and this command validates only against the LOCAL one. Nothing written. Run \`pteam routing set\` on that host, or edit ${target.path} and verify with \`pteam preflight --strict --host-id ${target.hostId}\`.`,
			);
		}
	}
	const route = { paseoProvider: provider, model, thinking };
	const previous = routesOf(target)[modelClass] ?? null;
	routesOf(target)[modelClass] = route;
	validateCandidate(target);

	const live = await inventoryFor(provider, { env });
	if (!live.ok) {
		throw new RoutingCommandError(
			"INVENTORY_UNAVAILABLE",
			`${live.message} — the route cannot be verified, and an unverified route is not written`,
		);
	}
	let resolved;
	try {
		resolved = resolveRoute({ hostId: target.hostId, routes: { [modelClass]: route } }, modelClass, live.inventory, {
			strict: true,
		});
	} catch (error) {
		throw new RoutingCommandError(
			error instanceof RoutingError ? error.code : "ROUTE_UNROUTABLE",
			`${String(error?.message ?? error)} — nothing written`,
		);
	}
	const backup = writeTarget(target);
	return {
		ok: true,
		wrote: true,
		path: target.path,
		backup,
		hostId: target.hostId,
		class: modelClass,
		previous,
		route,
		createAgentProvider: resolved.createAgentProvider,
		thinkingValidated: resolved.thinkingValidated,
	};
}

/** `routing unset` — optional classes only; the five required ones are the contract. */
export function routingUnset({ modelClass, hostId }, { env = process.env } = {}) {
	requireClass(modelClass);
	if (!OPTIONAL_MODEL_CLASSES.includes(modelClass)) {
		throw new RoutingCommandError(
			"CLASS_REQUIRED",
			`${modelClass} is a required class and cannot be unset (only ${OPTIONAL_MODEL_CLASSES.join(", ")} can); use \`routing set\` to change it`,
		);
	}
	const target = editTarget(env, hostId);
	const routes = routesOf(target);
	if (!(modelClass in routes)) {
		return { ok: true, wrote: false, path: target.path, hostId: target.hostId, class: modelClass, note: "not configured; nothing to do" };
	}
	const previous = routes[modelClass];
	delete routes[modelClass];
	validateCandidate(target);
	const backup = writeTarget(target);
	return { ok: true, wrote: true, path: target.path, backup, hostId: target.hostId, class: modelClass, previous };
}

/**
 * `routing check` — the routing half of preflight and nothing else: both files'
 * schemas, the table the gate reads, and every configured class of the local
 * host resolved STRICTLY against the live daemon. Remote cluster hosts get the
 * schema check only (their inventory is on another daemon — `pteam preflight
 * --host-id <id>` does the live remote check).
 */
export async function routingCheck({ env = process.env, inventoryFor = liveInventory } = {}) {
	const p = paths(env);
	const checks = [];
	const add = (id, status, detail) => checks.push({ id, status, detail });
	for (const [id, path, validate] of [
		["routing-config", p.routing, (data) => validateRoutingConfig(data)],
		["cluster-config", p.cluster, (data) => validateClusterConfig(data)],
	]) {
		if (!existsSync(path)) {
			add(id, "skip", `${path} absent`);
			continue;
		}
		try {
			validate(JSON.parse(readFileSync(path, "utf8")));
			add(id, "pass", path);
		} catch (error) {
			add(id, "fail", `${path}: ${String(error?.message ?? error)}`);
		}
	}
	const table = loadLocalRouteTable({ env });
	if (!table.ok) {
		add("route-gate", "fail", `${table.code}: ${table.message}`);
	} else {
		add("route-gate", "pass", `create_agent is checked against ${table.path} (host "${table.hostId}")`);
		for (const modelClass of ALL_MODEL_CLASSES) {
			const route = table.routes[modelClass];
			if (!route) {
				add(`route:${modelClass}`, "warn", "optional class not configured — the flow that needs it is refused until it is");
				continue;
			}
			const live = await inventoryFor(route.paseoProvider, { env });
			if (!live.ok) {
				add(`route:${modelClass}`, "fail", `${live.message} — unverifiable is not a pass`);
				continue;
			}
			try {
				const resolved = resolveRoute(table, modelClass, live.inventory, { strict: true });
				add(`route:${modelClass}`, "pass", `${resolved.createAgentProvider} + thinking=${route.thinking}`);
			} catch (error) {
				add(`route:${modelClass}`, "fail", String(error?.message ?? error));
			}
		}
	}
	const warning = enforcementWarning(env);
	add("route-enforcement", warning ? "warn" : "pass", warning ?? "on");
	return { ok: !checks.some((check) => check.status === "fail"), checks };
}

/** Human rendering for `routing show` (the JSON form is the same object). */
export function formatShow(result) {
	const lines = [];
	if (!result.ok) {
		lines.push(`route table: UNAVAILABLE (${result.code}) — ${result.message}`);
	} else {
		lines.push(`route table: ${result.path}  (host "${result.hostId}", source ${result.source})`);
		lines.push(`enforcement: ${result.enforcement}`);
		for (const entry of result.classes) {
			const tag = entry.required ? "" : " (optional)";
			lines.push(
				entry.configured
					? `  ${entry.class.padEnd(22)} ${entry.createAgentProvider}  thinking=${entry.thinking}${tag}`
					: `  ${entry.class.padEnd(22)} — not configured${tag}`,
			);
		}
	}
	for (const warning of result.warnings ?? []) lines.push(`WARN ${warning}`);
	return `${lines.join("\n")}\n`;
}

export function formatCheck(result) {
	const mark = { pass: "✓", warn: "!", fail: "✗", skip: "-" };
	return `${result.checks.map((check) => `${mark[check.status] ?? "?"} ${check.id}: ${check.detail}`).join("\n")}\n${result.ok ? "routing: OK" : "routing: FAILED"}\n`;
}

// model-routing.mjs — stateless logical-model-class resolver for the
// paseo-pi-team role pack.
//
// What this module is ALLOWED to do:
//   - read + validate a host-local routing config;
//   - compose the exact `<role-provider>/<model-id>` create_agent string;
//   - validate a route against a real provider/model inventory;
//   - compare requested values against observed runtime info;
//   - return structured, fail-closed errors.
//
// What it must NEVER do: store agent lifecycle, manage sessions, keep a task
// database, hold API keys, or fall back to another model/host on its own.
// Paseo remains the only control plane; git SHA remains the artifact anchor.

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

export const MODEL_CLASSES = Object.freeze([
	"MONITOR_ECONOMY",
	"FAST_READ",
	"CODING_MEDIUM",
	"REASONING_HIGH",
	"REVIEW_HIGH",
]);

export const THINKING_LEVELS = Object.freeze([
	"off",
	"minimal",
	"low",
	"medium",
	"high",
	"xhigh",
	"max",
]);

/** The three durable Paseo role profiles. Model-per-role profiles are not created. */
export const ROLE_PROVIDERS = Object.freeze([
	"pi-supervisor",
	"pi-lead",
	"pi-peer",
]);

export const ERROR_CODES = Object.freeze([
	"CONFIG_INVALID",
	"ROLE_PROVIDER_UNAVAILABLE",
	"MODEL_UNAVAILABLE",
	"THINKING_OPTION_UNAVAILABLE",
	"MODEL_RESOLUTION_MISMATCH",
	"HOST_ROUTE_UNAVAILABLE",
]);

/** Structured failure. Always fail-closed; never a fallback signal. */
export class RoutingError extends Error {
	/**
	 * @param {string} code one of ERROR_CODES
	 * @param {string} message human-readable explanation
	 * @param {Record<string, unknown>} [details] machine-readable context
	 */
	constructor(code, message, details = {}) {
		super(`${code}: ${message}`);
		this.name = "RoutingError";
		this.code = code;
		this.details = details;
	}
}

export function defaultRoutingDir() {
	return process.env.PASEO_TEAM_HOME ?? join(homedir(), ".paseo-pi-team");
}

export function defaultRoutingConfigPath() {
	return join(defaultRoutingDir(), "model-routing.local.json");
}

// ---------------------------------------------------------------------------
// Config validation
// ---------------------------------------------------------------------------

/**
 * Validate a parsed model-routing config object.
 * @returns {{hostId: string, routes: Record<string, {paseoProvider: string, model: string, thinking: string}>}}
 * @throws {RoutingError} CONFIG_INVALID
 */
export function validateRoutingConfig(data) {
	const fail = (message, details = {}) =>
		new RoutingError("CONFIG_INVALID", message, details);
	if (typeof data !== "object" || data === null || Array.isArray(data)) {
		throw fail("routing config must be a JSON object");
	}
	if (data.version !== 1) {
		throw fail("routing config version must be 1", { version: data.version });
	}
	if (typeof data.hostId !== "string" || data.hostId.trim() === "") {
		throw fail("routing config requires a non-empty hostId");
	}
	const routes = data.routes;
	if (typeof routes !== "object" || routes === null || Array.isArray(routes)) {
		throw fail("routing config requires a routes object");
	}
	for (const modelClass of MODEL_CLASSES) {
		if (!(modelClass in routes)) {
			throw fail(`routes is missing required class ${modelClass}`, {
				modelClass,
			});
		}
	}
	const validated = {};
	for (const [modelClass, route] of Object.entries(routes)) {
		if (!MODEL_CLASSES.includes(modelClass)) {
			throw fail(`unknown MODEL_CLASS "${modelClass}"`, { modelClass });
		}
		if (typeof route !== "object" || route === null) {
			throw fail(`route for ${modelClass} must be an object`);
		}
		const { paseoProvider, model, thinking } = route;
		if (!ROLE_PROVIDERS.includes(paseoProvider)) {
			throw fail(
				`route ${modelClass}: paseoProvider "${paseoProvider}" is not one of the durable role profiles (${ROLE_PROVIDERS.join(", ")})`,
				{ modelClass, paseoProvider },
			);
		}
		if (typeof model !== "string" || model.trim() === "") {
			throw fail(`route ${modelClass}: model must be a non-empty string`);
		}
		const trimmedModel = model.trim();
		if (!trimmedModel.includes("/")) {
			throw fail(
				`route ${modelClass}: model "${trimmedModel}" must be in <pi-provider>/<model-id> form`,
				{ modelClass, model: trimmedModel },
			);
		}
		if (!THINKING_LEVELS.includes(thinking)) {
			throw fail(
				`route ${modelClass}: thinking "${thinking}" is not a pi thinking level (${THINKING_LEVELS.join(", ")})`,
				{ modelClass, thinking },
			);
		}
		const { provider } = splitProviderModel(`${paseoProvider}/${trimmedModel}`);
		if (provider !== paseoProvider) {
			throw fail(`route ${modelClass}: model splits to wrong provider`, {
				modelClass,
			});
		}
		validated[modelClass] = {
			paseoProvider,
			model: trimmedModel,
			thinking,
		};
	}
	return { hostId: data.hostId.trim(), routes: validated };
}

/**
 * Load + validate a host-local routing config from disk.
 * @throws {RoutingError} CONFIG_INVALID on missing/invalid file
 */
export function loadRoutingConfig(path = defaultRoutingConfigPath()) {
	let raw;
	try {
		raw = readFileSync(path, "utf8");
	} catch (error) {
		throw new RoutingError(
			"CONFIG_INVALID",
			`cannot read routing config at ${path}`,
			{
				path,
				cause: String(error?.message ?? error),
			},
		);
	}
	let data;
	try {
		data = JSON.parse(raw);
	} catch (error) {
		throw new RoutingError(
			"CONFIG_INVALID",
			`routing config at ${path} is not valid JSON`,
			{
				path,
				cause: String(error?.message ?? error),
			},
		);
	}
	return validateRoutingConfig(data);
}

// ---------------------------------------------------------------------------
// Composition — mirrors Paseo resolveRequiredProviderModel (split FIRST "/")
// ---------------------------------------------------------------------------

/**
 * Split a `<provider>/<model>` value at the FIRST slash, exactly like Paseo
 * (server/agent/mcp-shared.js resolveRequiredProviderModel). Model IDs may
 * contain further slashes (e.g. openrouter/vendor/model-name).
 */
export function splitProviderModel(value) {
	const input = String(value).trim();
	const slashIndex = input.indexOf("/");
	if (slashIndex <= 0 || slashIndex === input.length - 1) {
		throw new RoutingError(
			"CONFIG_INVALID",
			`"${value}" must be <provider>/<model>`,
			{ value },
		);
	}
	return {
		provider: input.slice(0, slashIndex).trim(),
		model: input.slice(slashIndex + 1).trim(),
	};
}

/**
 * Compose the exact value for create_agent.provider.
 * "pi-peer" + "openrouter/vendor/model-name" → "pi-peer/openrouter/vendor/model-name"
 * @throws {RoutingError} CONFIG_INVALID if paseoProvider/model are malformed
 */
export function composeProviderModel(paseoProvider, model) {
	if (!ROLE_PROVIDERS.includes(paseoProvider)) {
		throw new RoutingError(
			"CONFIG_INVALID",
			`paseoProvider "${paseoProvider}" is not a durable role profile`,
			{ paseoProvider },
		);
	}
	const trimmed = String(model).trim();
	if (trimmed === "" || !trimmed.includes("/")) {
		throw new RoutingError(
			"CONFIG_INVALID",
			`model "${model}" must be in <pi-provider>/<model-id> form`,
			{ model },
		);
	}
	return `${paseoProvider}/${trimmed}`;
}

// ---------------------------------------------------------------------------
// Route resolution against a real inventory
// ---------------------------------------------------------------------------

function normalizeModelEntry(entry) {
	if (typeof entry !== "object" || entry === null) return null;
	const id = entry.id ?? entry.model;
	if (typeof id !== "string" || id.trim() === "") return null;
	// Accept both shapes: Paseo MCP list_models (thinkingOptions: [{id}...])
	// and Paseo CLI --json (thinkingOptionIds: ["off",...]).
	let thinkingOptionIds = null;
	if (Array.isArray(entry.thinkingOptionIds)) {
		thinkingOptionIds = entry.thinkingOptionIds.filter(
			(v) => typeof v === "string",
		);
	} else if (Array.isArray(entry.thinkingOptions)) {
		thinkingOptionIds = entry.thinkingOptions
			.map((option) => (typeof option === "string" ? option : option?.id))
			.filter((v) => typeof v === "string");
	}
	return { id: id.trim(), thinkingOptionIds };
}

function normalizeProviderEntry(entry) {
	if (typeof entry !== "object" || entry === null) return null;
	const id = entry.id ?? entry.provider;
	if (typeof id !== "string" || id.trim() === "") return null;
	// MCP list_providers: { id, enabled: boolean, status? }
	// CLI provider ls --json: { provider, status: "available", enabled: "Enabled" }
	const enabled =
		typeof entry.enabled === "boolean"
			? entry.enabled
			: typeof entry.enabled === "string"
				? entry.enabled.toLowerCase() === "enabled"
				: true;
	return { id: id.trim(), enabled };
}

/**
 * Resolve one MODEL_CLASS against the routing config and real host inventory.
 *
 * @param {object} config validated routing config
 * @param {string} modelClass one of MODEL_CLASSES
 * @param {object} inventory { providers: [...], models: [...] } as returned by
 *   list_providers / list_models (Paseo MCP or CLI --json shapes)
 * @returns {{paseoProvider: string, model: string, thinking: string,
 *            createAgentProvider: string, thinkingValidated: "exact"|"unverifiable"}}
 * @throws {RoutingError} ROLE_PROVIDER_UNAVAILABLE | MODEL_UNAVAILABLE |
 *   THINKING_OPTION_UNAVAILABLE | HOST_ROUTE_UNAVAILABLE
 */
export function resolveRoute(config, modelClass, inventory) {
	if (!MODEL_CLASSES.includes(modelClass)) {
		throw new RoutingError(
			"HOST_ROUTE_UNAVAILABLE",
			`unknown MODEL_CLASS "${modelClass}"`,
			{ modelClass },
		);
	}
	const route = config.routes[modelClass];
	if (!route) {
		throw new RoutingError(
			"HOST_ROUTE_UNAVAILABLE",
			`routing config for host ${config.hostId} has no route for ${modelClass}`,
			{ hostId: config.hostId, modelClass },
		);
	}

	const providers = (inventory?.providers ?? [])
		.map(normalizeProviderEntry)
		.filter(Boolean);
	const provider = providers.find((p) => p.id === route.paseoProvider);
	if (!provider || !provider.enabled) {
		throw new RoutingError(
			"ROLE_PROVIDER_UNAVAILABLE",
			`role provider "${route.paseoProvider}" is ${provider ? "disabled" : "not registered"} on this daemon`,
			{ paseoProvider: route.paseoProvider, modelClass },
		);
	}

	const models = (inventory?.models ?? [])
		.map(normalizeModelEntry)
		.filter(Boolean);
	const modelEntry = models.find((m) => m.id === route.model);
	if (!modelEntry) {
		throw new RoutingError(
			"MODEL_UNAVAILABLE",
			`model "${route.model}" is not in the inventory of provider "${route.paseoProvider}" (${models.length} models listed)`,
			{ paseoProvider: route.paseoProvider, model: route.model, modelClass },
		);
	}

	let thinkingValidated = "exact";
	if (modelEntry.thinkingOptionIds === null) {
		// Non-reasoning models may carry no option list; only the default is safe.
		thinkingValidated = "unverifiable";
	} else if (!modelEntry.thinkingOptionIds.includes(route.thinking)) {
		throw new RoutingError(
			"THINKING_OPTION_UNAVAILABLE",
			`thinking "${route.thinking}" is not offered by model "${route.model}" (offered: ${modelEntry.thinkingOptionIds.join(", ")})`,
			{
				model: route.model,
				thinking: route.thinking,
				offered: modelEntry.thinkingOptionIds,
			},
		);
	}

	return {
		paseoProvider: route.paseoProvider,
		model: route.model,
		thinking: route.thinking,
		createAgentProvider: composeProviderModel(route.paseoProvider, route.model),
		thinkingValidated,
	};
}

// ---------------------------------------------------------------------------
// Observed-value verification (fail-closed)
// ---------------------------------------------------------------------------

/**
 * Verify an agent's observed runtime info against what was requested.
 * Source: get_agent_status → snapshot.runtimeInfo {model, thinkingOptionId}.
 *
 * @param {{paseoProvider: string, model: string, thinking: string}} requested
 * @param {{provider?: string, model?: string|null, thinkingOptionId?: string|null}|null|undefined} runtimeInfo
 * @returns {{ok: true, requested: object, observed: object}}
 * @throws {RoutingError} MODEL_RESOLUTION_MISMATCH — also when runtimeInfo is
 *   missing/unverifiable (fail-closed: unverifiable is NOT a pass).
 */
export function verifyObserved(requested, runtimeInfo) {
	const mismatch = (message, observed) =>
		new RoutingError("MODEL_RESOLUTION_MISMATCH", message, {
			requested: {
				paseoProvider: requested.paseoProvider,
				model: requested.model,
				thinking: requested.thinking,
			},
			observed,
		});

	if (runtimeInfo === null || runtimeInfo === undefined) {
		throw mismatch(
			"runtimeInfo is unavailable — observed model cannot be verified (unverifiable is not a pass)",
			null,
		);
	}
	const observed = {
		provider: runtimeInfo.provider ?? null,
		model: runtimeInfo.model ?? null,
		thinking: runtimeInfo.thinkingOptionId ?? null,
	};
	if (observed.model === null) {
		throw mismatch(
			"runtimeInfo.model is missing — cannot verify observed model",
			observed,
		);
	}
	if (observed.thinking === null) {
		throw mismatch(
			"runtimeInfo.thinkingOptionId is missing — cannot verify observed thinking level",
			observed,
		);
	}
	if (observed.model !== requested.model) {
		throw mismatch(
			`observed model "${observed.model}" != requested "${requested.model}"`,
			observed,
		);
	}
	if (observed.thinking !== requested.thinking) {
		throw mismatch(
			`observed thinking "${observed.thinking}" != requested "${requested.thinking}" (an unsupported level may have been clamped by pi — check the model's thinkingLevelMap)`,
			observed,
		);
	}
	if (
		observed.provider !== null &&
		observed.provider !== requested.paseoProvider
	) {
		throw mismatch(
			`observed provider "${observed.provider}" != requested role profile "${requested.paseoProvider}"`,
			observed,
		);
	}
	return { ok: true, requested, observed };
}

// ---------------------------------------------------------------------------
// Minimal CLI — so a Lead (or human) can resolve/validate without reading
// JSON by hand. Usage:
//   node scripts/model-routing.mjs validate [--routes <path>]
//   node scripts/model-routing.mjs resolve --class <MODEL_CLASS> [--routes <path>] [--json]
// Exit code 0 ok, 1 config error, 2 route unavailable (structured stdout).
// ---------------------------------------------------------------------------

function isMain() {
	const entry = process.argv[1];
	if (!entry) return false;
	try {
		return import.meta.url === pathToFileURL(entry).href;
	} catch {
		return false;
	}
}

if (isMain()) {
	const argv = process.argv.slice(2);
	const command = argv[0];
	const optArg = (name) => {
		const i = argv.indexOf(name);
		return i >= 0 && argv[i + 1] ? argv[i + 1] : undefined;
	};
	const asJson = argv.includes("--json");
	const emit = (payload, code) => {
		console.log(JSON.stringify(payload, null, 2));
		process.exit(code);
	};
	const failOut = (error, code) => {
		const payload =
			error instanceof RoutingError
				? {
						ok: false,
						code: error.code,
						message: error.message,
						details: error.details,
					}
				: {
						ok: false,
						code: "ERROR",
						message: String(error?.message ?? error),
					};
		if (asJson) emit(payload, code);
		console.error(payload.message);
		process.exit(code);
	};
	try {
		const config = loadRoutingConfig(optArg("--routes"));
		if (command === "validate") {
			emit(
				{
					ok: true,
					hostId: config.hostId,
					classes: Object.keys(config.routes),
				},
				0,
			);
		} else if (command === "resolve") {
			const modelClass = optArg("--class");
			if (!modelClass)
				failOut(new Error("resolve requires --class <MODEL_CLASS>"), 2);
			// Inventory must come from the caller (list_models). Without it we can
			// only emit the configured request; correctness verification stays
			// with the Lead's list_models comparison + verifyObserved.
			const route = config.routes[modelClass];
			if (!route) {
				failOut(
					new RoutingError(
						"HOST_ROUTE_UNAVAILABLE",
						`no route for ${modelClass} on host ${config.hostId}`,
					),
					2,
				);
			}
			emit(
				{
					ok: true,
					hostId: config.hostId,
					modelClass,
					paseoProvider: route.paseoProvider,
					model: route.model,
					thinking: route.thinking,
					createAgentProvider: composeProviderModel(
						route.paseoProvider,
						route.model,
					),
					note: "Verify against list_models + get_agent_status runtimeInfo before/during create_agent.",
				},
				0,
			);
		} else {
			console.error(
				"usage: model-routing.mjs validate|resolve --class <MODEL_CLASS> [--routes <path>] [--json]",
			);
			process.exit(64);
		}
	} catch (error) {
		failOut(
			error,
			error instanceof RoutingError && error.code !== "CONFIG_INVALID" ? 2 : 1,
		);
	}
}

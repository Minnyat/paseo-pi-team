#!/usr/bin/env node
/**
 * paseo-team.mjs — the CLI that owns every paseo-pi-team config path.
 *
 * Everything paseo-pi-team configures is read/written here and only here; the
 * WebUI extension is a *client* that spawns this binary with a subcommand and
 * renders the JSON it returns. It never touches the filesystem itself.
 *
 * The preview CLI contract:
 *
 *   paseo-team status                  -> machine-readable snapshot of paths + presence
 *   paseo-team preflight    [--strict|--json|--skip-models|--runtime pi|claude|both|--host-id <id>|--cluster <p>|--routes <p>]
 *   paseo-team claude-setup [--install|--verify|--uninstall|--print-providers] [--json]
 *   paseo-team config read  <section>  -> full JSON of that section (stdout)
 *   paseo-team config write <section>  -> full JSON of that section from stdin, atomic+backup
 *   paseo-team prompts read <role>     -> markdown body (JSON-wrapped)
 *   paseo-team prompts write <role>    -> markdown body from stdin, atomic+backup
 *   paseo-team skills list             -> [{ name, path, pack }]
 *   paseo-team skills read <name>      -> SKILL.md body (JSON-wrapped)
 *   paseo-team skills write <name>     -> SKILL.md body from stdin
 *   paseo-team env list                -> documented env knobs + process values + target file
 *   paseo-team install [--attach-cdp-port <port>] -> delegate to the bundled installer
 *
 * Every command emits a single JSON object (or JSON for read bodies). Non-JSON
 * errors go to stderr and the process exits non-zero.
 */

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, appendFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import * as cw from "./lib/config-walker.mjs";
import { schemaForSection, withModelInventory, ROUTING_SECTIONS } from "./lib/config-schema.mjs";
import { runPaseoJson, PaseoError } from "./lib/paseo-bridge.mjs";
import {
	ROLE_PROVIDERS,
	RUNTIME_FAMILIES,
	PROVIDER_OK_STATUSES,
	buildProviderInventory,
	normalizeModelEntry,
	providerFamily,
} from "../scripts/model-routing.mjs";
import * as graphCache from "./lib/graph-cache.mjs";
import { collectGraph, inferRole, normalizePermits } from "./lib/graph.mjs";
import { readAgentStates, isAgentId } from "./lib/agent-state.mjs";
import * as su from "./lib/self-update.mjs";
import * as un from "./lib/uninstall.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

function fail(msg, code = 1) {
	process.stderr.write(`[paseo-team] ${msg}\n`);
	process.exit(code);
}

function json(obj) {
	process.stdout.write(JSON.stringify(obj, null, 2) + "\n");
}

function readStdin() {
	try {
		return readFileSync(0, "utf8");
	} catch (e) {
		fail(`failed to read stdin: ${e.message}`);
	}
	return "";
}

// ---------------------------------------------------------------------------
// status
// ---------------------------------------------------------------------------

function cmdStatus() {
	const paseoCfg = cw.readJsonOrNull(cw.paseoConfigPath());
	const providers = paseoCfg?.agents?.providers ?? {};
	json({
		repoRoot: ROOT,
		version: su.currentVersion(),
		pi: { home: cw.piHome(), agentDir: cw.agentDir() },
		paths: {
			paseoConfig: cw.paseoConfigPath(),
			mcpConfig: cw.mcpConfigPath(),
			promptsDir: cw.promptsDir(),
			skillsDir: cw.skillsDir(),
			policyExtension: cw.policyExtensionPath(),
			routing: join(cw.teamConfigDir(), "model-routing.local.json"),
			cluster: join(cw.teamConfigDir(), "cluster-routing.local.json"),
		},
		presence: {
			paseoConfig: cw.readJsonOrNull(cw.paseoConfigPath()) !== null,
			mcpConfig: cw.readJsonOrNull(cw.mcpConfigPath()) !== null,
			policyExtension: existsSync(cw.policyExtensionPath()),
			routing: existsSync(join(cw.teamConfigDir(), "model-routing.local.json")),
			cluster: existsSync(join(cw.teamConfigDir(), "cluster-routing.local.json")),
			prompts: Object.fromEntries(
				cw.ROLE_PROMPTS.map((r) => [r, existsSync(cw.rolePromptPath(r))])
			),
		},
		// The pack owns exactly ROLE_PROVIDERS. Filtering by `extends === "pi"`
		// hid every claude-* role profile even when the daemon had it registered,
		// which made a mixed-runtime install look like a pi-only one.
		roleProfiles: ROLE_PROVIDERS.filter((name) => providers[name] !== undefined),
		docs: "docs/webui-architecture.md",
	});
}

// ---------------------------------------------------------------------------
// preflight (delegate to the bundled script)
// ---------------------------------------------------------------------------

function cmdPreflight(argv) {
	// Strip a no-op --json (script accepts it) and pass the rest through.
	const res = spawnSync(process.execPath, [join(ROOT, "scripts", "preflight.mjs"), ...argv], {
		encoding: "utf8",
		stdio: ["ignore", "pipe", "pipe"],
	});
	if (res.error) fail(`preflight failed to start: ${res.error.message}`);
	if (res.stderr) process.stderr.write(res.stderr);
	if (res.stdout) process.stdout.write(res.stdout);
	process.exit(res.status ?? 1);
}

// ---------------------------------------------------------------------------
// live model inventory (feeds the routing/cluster forms and `pteam models`)
// ---------------------------------------------------------------------------

/**
 * The Paseo CLI reports some daemon failures as a *successful* JSON body
 * `{ "error": { code, message } }` rather than a non-zero exit, so
 * runPaseoJson resolves instead of rejecting. Every inventory read goes
 * through here: an error envelope that reached a caller as data would be
 * counted as "zero models available", which is a silent wrong answer.
 */
function paseoErrorEnvelope(payload) {
	if (Array.isArray(payload) || payload === null || typeof payload !== "object") {
		return null;
	}
	const error = payload.error;
	if (error === undefined || error === null) return null;
	if (typeof error === "string") return { code: "CLI_ERROR", message: error };
	return {
		code: typeof error.code === "string" ? error.code : "CLI_ERROR",
		message: String(error.message ?? "paseo reported an error"),
	};
}

/** Model ids of one role provider, or a structured fault. Never throws. */
async function listProviderModels(roleProvider, timeoutMs) {
	try {
		const payload = await runPaseoJson(["provider", "models", roleProvider], { timeoutMs });
		const envelope = paseoErrorEnvelope(payload);
		if (envelope) return { ok: false, provider: roleProvider, ...envelope };
		const models = (Array.isArray(payload) ? payload : [])
			.map(normalizeModelEntry)
			.filter(Boolean);
		return { ok: true, provider: roleProvider, models };
	} catch (error) {
		return {
			ok: false,
			provider: roleProvider,
			code: error instanceof PaseoError ? error.code : "PASEO_FAILED",
			message: String(error?.message ?? error),
		};
	}
}

/**
 * Discover which models each role provider can actually be routed to.
 *
 * Cost discipline (see paseo-bridge.mjs): one `paseo` invocation costs ~3s of
 * process startup, so this issues at most 1 + RUNTIME_FAMILIES.length calls —
 * `provider ls` once, then `provider models` once per family, using the first
 * REGISTERED, ENABLED and HEALTHY role provider of that family as the
 * representative. The three role profiles of a family extend the same base
 * runtime, so their model lists agree; where they might not, the per-provider
 * truth is still enforced later by preflight's resolveRoute, which fails
 * closed. These lists are a typing aid, never an authority.
 *
 * Never throws and never blocks a form: a daemon that is down yields an empty
 * map plus a `degraded` entry, and the model field stays the free-text box it
 * has always been.
 */
async function discoverModels(options = {}) {
	const timeoutMs = options.timeoutMs ?? 8000;
	const degraded = [];
	let listed;
	try {
		listed = await runPaseoJson(["provider", "ls"], { timeoutMs });
	} catch (error) {
		return {
			byProvider: {},
			degraded: [{
				step: "provider ls",
				code: error instanceof PaseoError ? error.code : "PASEO_FAILED",
				message: String(error?.message ?? error),
			}],
		};
	}
	const envelope = paseoErrorEnvelope(listed);
	if (envelope) return { byProvider: {}, degraded: [{ step: "provider ls", ...envelope }] };

	// Same health predicate as the route resolver: enabled AND, when a status is
	// reported, a healthy one. Suggesting models from a provider that preflight
	// will reject is worse than suggesting nothing.
	const healthy = new Set(
		buildProviderInventory(Array.isArray(listed) ? listed : [])
			.filter((p) => p.enabled && (p.status === undefined || PROVIDER_OK_STATUSES.has(p.status)))
			.map((p) => p.id),
	);

	const byProvider = {};
	for (const family of RUNTIME_FAMILIES) {
		const members = ROLE_PROVIDERS.filter((name) => providerFamily(name) === family);
		const representative = members.find((name) => healthy.has(name));
		if (representative === undefined) {
			degraded.push({
				step: `family ${family}`,
				code: "NO_HEALTHY_ROLE_PROVIDER",
				message: `no enabled role provider for family "${family}" (looked for ${members.join(", ")}) — run 'pteam preflight' or 'pteam claude-setup --install'`,
			});
			continue;
		}
		const result = await listProviderModels(representative, timeoutMs);
		if (!result.ok) {
			degraded.push({ step: `provider models ${representative}`, code: result.code, message: result.message });
			continue;
		}
		const ids = [...new Set(result.models.map((m) => m.id))].sort();
		for (const member of members) byProvider[member] = ids;
	}
	return { byProvider, degraded };
}

async function cmdModels(argv) {
	rejectUnknownFlags(argv, ["--provider"]);
	const provider = flagValue(argv, "--provider");
	if (provider !== undefined) {
		if (!ROLE_PROVIDERS.includes(provider)) {
			fail(`models: --provider must be one of ${ROLE_PROVIDERS.join(", ")} (got '${provider}')`);
		}
		// One named provider is the authoritative read: full entries, including
		// the thinking options a route must match.
		const result = await listProviderModels(provider, 20000);
		if (!result.ok) {
			json({ ok: false, code: result.code, command: "models", provider, message: result.message });
			process.exit(3);
		}
		json({ ok: true, provider, family: providerFamily(provider), count: result.models.length, models: result.models });
		return;
	}
	const { byProvider, degraded } = await discoverModels({ timeoutMs: 20000 });
	json({
		ok: true,
		providers: byProvider,
		count: Object.fromEntries(Object.entries(byProvider).map(([k, v]) => [k, v.length])),
		degraded,
	});
}

// ---------------------------------------------------------------------------
// config read/write
// ---------------------------------------------------------------------------

const CONFIG_SECTIONS = {
	providers: () => cw.paseoConfigPath(),
	routing: () => join(cw.teamConfigDir(), "model-routing.local.json"),
	cluster: () => join(cw.teamConfigDir(), "cluster-routing.local.json"),
	mcp: () => cw.mcpConfigPath(),
	paseo: () => cw.paseoConfigPath(),
	"pi-settings": () => cw.piSettingsPath(),
};

function resolveSection(section) {
	if (typeof section !== "string" || !(section in CONFIG_SECTIONS)) {
		fail(`unknown config section '${section}' (expected: ${Object.keys(CONFIG_SECTIONS).join(", ")})`);
	}
	return CONFIG_SECTIONS[section]();
}

async function cmdConfigRead(section, rest = []) {
	rejectUnknownFlags(rest, ["--no-discovery"]);
	const path = resolveSection(section);
	const data = cw.readJsonOrNull(path);
	// The form schema rides along with the data: the WebUI renders fields the
	// CLI described and nothing else, so a form is reproducible from a terminal.
	let schema = schemaForSection(section);
	// Routing forms get the live model inventory folded into that same schema,
	// so the browser still renders only what the CLI described. --no-discovery
	// skips the daemon round trip for scripted reads and for a machine whose
	// daemon is known to be down (the read otherwise costs one `provider ls`).
	let inventory = null;
	if (schema && ROUTING_SECTIONS.includes(section) && !flag(rest, "--no-discovery")) {
		inventory = await discoverModels();
		schema = withModelInventory(schema, inventory.byProvider);
	}
	const extras = {
		...(schema ? { schema } : {}),
		...(inventory ? { inventory: { providers: Object.keys(inventory.byProvider), degraded: inventory.degraded } } : {}),
	};
	if (data === null) {
		json({ exists: false, path, data: {}, ...extras });
		return;
	}
	json({ exists: true, path, data, ...extras });
}

function cmdConfigWrite(section) {
	const path = resolveSection(section);
	const content = readStdin();
	try {
		cw.atomicWriteJson(path, content);
	} catch (e) {
		fail(`invalid JSON or write failed for ${path}: ${e.message}`);
	}
	json({ ok: true, wrote: true, path });
}

// ---------------------------------------------------------------------------
// prompts read/write
// ---------------------------------------------------------------------------

function cmdPromptsRead(role) {
	const path = cw.rolePromptPath(role);
	if (!existsSync(path)) {
		fail(`prompt not installed for role '${role}' at ${path} — run 'paseo-team install'`);
	}
	json({ role, path, content: cw.readText(path) });
}

function cmdPromptsWrite(role) {
	const path = cw.rolePromptPath(role);
	const content = readStdin();
	cw.atomicWrite(path, content);
	json({ ok: true, wrote: true, role, path });
}

// ---------------------------------------------------------------------------
// skills list/read/write
// ---------------------------------------------------------------------------

function listSkills() {
	if (!existsSync(cw.skillsDir())) return [];
	return readdirSync(cw.skillsDir(), { withFileTypes: true })
		.filter((d) => d.isDirectory())
		.map((d) => d.name);
}

function cmdSkillsList() {
	json({
		skills: listSkills().map((name) => ({
			name,
			path: join(cw.skillsDir(), name),
			pack: cw.PACK_SKILLS.includes(name),
		})),
	});
}

function cmdSkillsRead(name) {
	const n = cw.safeName(name);
	const p = cw.skillPromptPath(n);
	if (!existsSync(p)) fail(`skill '${name}' has no SKILL.md at ${p}`);
	json({ name, path: p, content: cw.readText(p) });
}

function cmdSkillsWrite(name) {
	const n = cw.safeName(name);
	const p = cw.skillPromptPath(n);
	const content = readStdin();
	cw.atomicWrite(p, content);
	json({ ok: true, wrote: true, name, path: p });
}

// ---------------------------------------------------------------------------
// env list (read-only view of documented knobs)
// ---------------------------------------------------------------------------

const DOC_ENV = [
	{ key: "PASEO_PI_ROLE", scope: "per-provider", where: "Paseo config agents.providers.<name>.env", purpose: "role selection (supervisor|lead|peer)" },
	{ key: "PASEO_TEAM_LEAD_WRITE", scope: "host", where: "machine env", purpose: "grant Lead write/edit tools ('1' to enable)" },
	{ key: "PASEO_TEAM_EXTRA_TOOLS", scope: "host", where: "machine env", purpose: "comma-separated extra tools per profile" },
	{ key: "PASEO_TEAM_PROMPTS_DIR", scope: "host", where: "machine env", purpose: "override prompts directory" },
	{ key: "PASEO_TEAM_SCRIPTS_DIR", scope: "host", where: "machine env", purpose: "override support-scripts directory" },
	{ key: "PASEO_TEAM_TOPOLOGY", scope: "per-agent", where: "paseo run --env / provider env", purpose: "single (default) | multi — 'multi' turns on the several-Supervisor governance rules: DOMAIN on supervisor blocks, recovery_for inside the supervisor's own domain, and the send_agent_prompt ownership wall. Any unrecognized value resolves to 'multi' (the side that only denies)" },
	{ key: "PASEO_TEAM_DOMAIN", scope: "per-agent", where: "paseo run --env / provider env", purpose: "jurisdiction of this seat; also set it as the team.domain label so `ls --label` and team_chat 'domain:<name>' broadcasts can find it. Required on every Lead and Supervisor under PASEO_TEAM_TOPOLOGY=multi" },
	{ key: "PASEO_TEAM_ROOMS", scope: "per-agent", where: "paseo run --env / provider env", purpose: "comma-separated chat-room allowlist for team_chat; unset = any room (chat rooms have no ACL of their own)" },
	{ key: "PASEO_HOME", scope: "host", where: "machine env", purpose: "Paseo's own home; the CLI reads agent state from $PASEO_HOME/agents (defaults to ~/.paseo)" },
];

function cmdEnvList() {
	json({
		env: DOC_ENV.map((e) => ({ ...e, current: process.env[e.key] ?? null })),
	});
}

// ---------------------------------------------------------------------------
// install (delegate)
// ---------------------------------------------------------------------------

function cmdInstall(argv) {
	const isWin = process.platform === "win32";
	if (isWin) {
		const res = spawnSync("powershell", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", join(ROOT, "scripts", "install.ps1"), ...argv], { stdio: "inherit" });
		process.exit(res.status ?? 0);
	} else {
		const res = spawnSync("bash", [join(ROOT, "scripts", "install.sh"), ...argv], { stdio: "inherit" });
		process.exit(res.status ?? 0);
	}
}

// ---------------------------------------------------------------------------
// claude-setup — the Claude Code half of the role pack
//
// Pi gets its policy from an extension; Claude gets it from user-level hooks
// plus an MCP server. This subcommand is the single place that installs,
// verifies or removes that half, and prints the matching provider block.
// ---------------------------------------------------------------------------

function cmdClaudeSetup(argv) {
	const known = ["--install", "--verify", "--uninstall", "--print-providers"];
	const passthrough = ["--json"];
	// --attach-cdp-port takes a value, so it is filtered as a pair rather than
	// as a bare flag: the port must not fall through to the unknown-flag check.
	const valued = ["--attach-cdp-port"];
	// Fail closed on anything unrecognised: silently degrading a mistyped
	// --instal into a read-only --verify would report success for work that
	// never happened, and the rest of this CLI rejects unknown flags outright.
	const valuedArgs = [];
	const bareFlags = [];
	for (let i = 0; i < argv.length; i++) {
		if (!valued.includes(argv[i])) {
			bareFlags.push(argv[i]);
			continue;
		}
		if (argv[i + 1] === undefined) fail(`claude-setup: ${argv[i]} needs a value`);
		valuedArgs.push(argv[i], argv[++i]);
	}
	const unknown = bareFlags.filter(
		(arg) => !known.includes(arg) && !passthrough.includes(arg),
	);
	if (unknown.length > 0) {
		fail(
			`claude-setup: unknown flag '${unknown[0]}' (allowed: ${[...known, ...passthrough, ...valued].join(", ")})`,
		);
	}
	const modes = bareFlags.filter((arg) => known.includes(arg));
	if (modes.length > 1) fail(`claude-setup: pick one of ${known.join(", ")}`);
	const mode = modes[0] ?? "--verify";
	if (valuedArgs.length > 0 && mode !== "--install") {
		fail(`claude-setup: ${valuedArgs[0]} is only valid with --install`);
	}
	const rest = [...bareFlags.filter((arg) => passthrough.includes(arg)), ...valuedArgs];
	const res = spawnSync(
		process.execPath,
		[join(ROOT, "scripts", "claude-setup.mjs"), mode, ...rest],
		{ encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
	);
	if (res.error) fail(`claude-setup failed to start: ${res.error.message}`);
	if (res.stderr) process.stderr.write(res.stderr);
	if (res.stdout) process.stdout.write(res.stdout);
	process.exit(res.status ?? 1);
}

// ---------------------------------------------------------------------------
// Live plane: agents, permits, chat, graph
//
// Everything below talks to the Paseo daemon through cli/lib/paseo-bridge.mjs
// and nowhere else. Each paseo invocation costs ~3s of process startup, so
// commands here are batch-shaped by design: one command, one snapshot.
// ---------------------------------------------------------------------------

/** Agent ids and short-id prefixes only — never a free-form string in argv. */
const AGENT_REF = /^[0-9a-fA-F][0-9a-fA-F-]{5,63}$/;
/** Chat rooms are addressed by name or id; keep it to a single safe token. */
const ROOM_REF = /^[A-Za-z0-9._:-]{1,128}$/;

function safeRef(ref, kind = "agent") {
	if (typeof ref !== "string" || !AGENT_REF.test(ref)) {
		fail(`invalid ${kind} reference '${ref}' (expected a Paseo id or short-id prefix)`);
	}
	return ref;
}

function safeRoom(room) {
	if (typeof room !== "string" || !ROOM_REF.test(room)) {
		fail(`invalid room '${room}' (expected [A-Za-z0-9._:-], max 128 chars)`);
	}
	return room;
}

function flag(argv, name) {
	return argv.includes(name);
}

function flagValue(argv, name) {
	const index = argv.indexOf(name);
	if (index < 0) return undefined;
	const value = argv[index + 1];
	if (value === undefined || value.startsWith("--")) fail(`${name} requires a value`);
	return value;
}

/** Fail closed on typos: an unknown flag must never be silently ignored. */
function rejectUnknownFlags(argv, allowed) {
	for (const part of argv) {
		if (part.startsWith("--") && !allowed.includes(part)) {
			fail(`unknown flag '${part}' (allowed: ${allowed.join(", ")})`);
		}
	}
}

async function live(args, label) {
	try {
		return await runPaseoJson(args);
	} catch (error) {
		const code = error instanceof PaseoError ? error.code : "PASEO_FAILED";
		process.stdout.write(JSON.stringify({ ok: false, code, command: label, message: String(error?.message ?? error) }, null, 2) + "\n");
		process.exit(3);
	}
}

async function cmdAgents(argv) {
	rejectUnknownFlags(argv, ["--all", "--domain"]);
	const domainFilter = flagValue(argv, "--domain");
	const listed = await live(flag(argv, "--all") ? ["ls", "-g", "-a"] : ["ls", "-g"], "agents");
	const rows = Array.isArray(listed) ? listed : [];
	// `paseo ls` carries neither labels nor the parent link; Paseo's own state
	// files carry both, and reading them costs no daemon round trip.
	const ids = rows.map((agent) => agent?.id).filter(isAgentId);
	const { states, degraded } = readAgentStates(ids);
	const agents = rows.map((agent) => {
		const state = states[agent?.id] ?? null;
		return {
			...agent,
			role: inferRole(agent?.provider),
			domain: state?.domain ?? null,
			parentId: state?.parentAgentId ?? null,
			resolvedModel: state?.model ?? null,
			modelDrift: state?.modelDrift ?? false,
			sessionId: state?.sessionId ?? null,
		};
	});
	const filtered = domainFilter === undefined ? agents : agents.filter((a) => a.domain === domainFilter);
	json({
		ok: true,
		count: filtered.length,
		domain: domainFilter ?? null,
		agents: filtered,
		degraded: degraded.filter((fault) => fault.reason !== "AGENT_STATE_MISSING"),
	});
}

async function cmdAgentInspect(ref) {
	const detail = await live(["inspect", safeRef(ref)], "agent inspect");
	json({ ok: true, role: inferRole(detail?.Provider ?? detail?.provider), agent: detail });
}

/**
 * Send a prompt read from stdin. The body goes through a temp file rather than
 * argv: on Windows the whole command line is one bounded string, and
 * remote-paseo.mjs already learned that lesson the hard way (PROMPT_TOO_LONG).
 */
async function cmdAgentSend(ref) {
	const agent = safeRef(ref);
	const body = readStdin().trim();
	if (!body) fail("agent send: empty prompt on stdin");
	cw.ensureDir(cw.teamConfigDir());
	const tmp = join(cw.teamConfigDir(), `send-${process.pid}-${Date.now()}.txt`);
	writeFileSync(tmp, body, "utf8");
	// Cleanup on 'exit' rather than in a finally: `live()` reports a failed
	// delegate by calling process.exit, which skips finally blocks entirely and
	// would leave a prompt file behind on every failure.
	process.on("exit", () => {
		try { unlinkSync(tmp); } catch { /* already gone, or the send still holds it — not worth failing over */ }
	});
	const sent = await live(["send", agent, "--prompt-file", tmp, "--no-wait"], "agent send");
	json({ ok: true, agentId: agent, bytes: Buffer.byteLength(body, "utf8"), response: sent });
}

// --- permissions -----------------------------------------------------------

export function permitAuditPath() {
	return join(cw.teamConfigDir(), "permit-audit.jsonl");
}

/**
 * Approving a tool call is an authority act, so it leaves a record before the
 * daemon is asked — a decision that was made must be visible even if the
 * delegate call then fails.
 */
function auditPermit(entry) {
	cw.ensureDir(cw.teamConfigDir());
	appendFileSync(permitAuditPath(), JSON.stringify(entry) + "\n", "utf8");
}

async function cmdPermitsList() {
	const listed = await live(["permit", "ls"], "permits list");
	const { permits, unclassified } = normalizePermits(listed);
	json({
		ok: true,
		count: permits.length + unclassified.length,
		permits: permits.map(({ ok, ...rest }) => rest),
		// Surfaced, not swallowed: a row we cannot name is still a request
		// somebody is blocked on, but it must not get a one-click approve.
		unclassified,
	});
}

async function cmdPermitDecision(action, argv) {
	const [agentRef, requestId] = argv;
	const agent = safeRef(agentRef);
	if (typeof requestId !== "string" || !ROOM_REF.test(requestId)) {
		fail(`permits ${action}: missing or invalid request id`);
	}
	const decidedAt = new Date().toISOString();
	auditPermit({ decidedAt, action, agentId: agent, requestId, actor: process.env.USERNAME ?? process.env.USER ?? null });
	const result = await live(["permit", action, agent, requestId], `permits ${action}`);
	json({ ok: true, action, agentId: agent, requestId, decidedAt, response: result });
}

// --- chat ------------------------------------------------------------------

async function cmdChatList() {
	const rooms = await live(["chat", "ls"], "chat list");
	json({ ok: true, rooms: Array.isArray(rooms) ? rooms : [] });
}

async function cmdChatRead(room, argv) {
	rejectUnknownFlags(argv, ["--limit"]);
	const limit = flagValue(argv, "--limit");
	const args = ["chat", "read", safeRoom(room)];
	if (limit !== undefined) {
		if (!/^\d{1,4}$/.test(limit)) fail("--limit must be a number (max 4 digits)");
		args.push("--limit", limit);
	}
	const messages = await live(args, "chat read");
	json({ ok: true, room, messages });
}

async function cmdChatPost(room) {
	const body = readStdin().trim();
	if (!body) fail("chat post: empty message on stdin");
	if (body.length > 8000) fail(`chat post: message is ${body.length} chars (max 8000)`);
	const posted = await live(["chat", "post", safeRoom(room), body], "chat post");
	json({ ok: true, room, response: posted });
}

// --- graph -----------------------------------------------------------------

async function cmdGraph(argv) {
	rejectUnknownFlags(argv, ["--all", "--max-inspect", "--refresh", "--with-chat"]);
	if (flag(argv, "--refresh")) graphCache.clearParentCache();
	const maxInspect = flagValue(argv, "--max-inspect");
	if (maxInspect !== undefined && !/^\d{1,3}$/.test(maxInspect)) {
		fail("--max-inspect must be a number (max 3 digits)");
	}
	// Opt-in: each room costs one round trip, and only the coordination view
	// needs them. Rooms are validated here so a typo never reaches argv.
	const withChat = flagValue(argv, "--with-chat");
	const chatRooms = withChat === undefined ? [] : withChat.split(",").map((room) => safeRoom(room.trim()));
	json(
		await collectGraph({
			all: flag(argv, "--all"),
			maxInspect: maxInspect === undefined ? undefined : Number(maxInspect),
			chatRooms,
		}),
	);
}

async function cmdWatchdog(argv) {
	rejectUnknownFlags(argv, ["--stale-after"]);
	const staleAfter = flagValue(argv, "--stale-after");
	if (staleAfter !== undefined && !/^\d{1,9}$/.test(staleAfter)) fail("--stale-after must be milliseconds");
	const { collectWatchdogSnapshot } = await import("../scripts/watchdog.mjs");
	json(await collectWatchdogSnapshot(staleAfter === undefined ? {} : { staleAfterMs: Number(staleAfter) }));
}

// --- uninstall --------------------------------------------------------------

function cmdUninstall(argv) {
	rejectUnknownFlags(argv, ["--purge"]);
	const report = un.uninstall({ purge: flag(argv, "--purge") });
	const mode = su.detectInstallMode();
	json({
		...report,
		mode,
		binary: mode === "global"
			? "this CLI was installed globally by npm — run `npm rm -g paseo-pi-team` to remove the `pteam`/`paseo-team` binary itself"
			: "this CLI runs from a git checkout — remove the checkout to delete the binary",
	});
}

// --- update ----------------------------------------------------------------

async function cmdUpdate(argv) {
	rejectUnknownFlags(argv, ["--check"]);
	const info = await su.checkForUpdate();
	if (flag(argv, "--check")) {
		json(info);
		return;
	}
	if (info.degraded.length > 0) {
		fail(`could not check for updates (${info.degraded[0].reason}): ${info.degraded[0].error ?? "no detail"}`);
	}
	if (!info.updateAvailable) {
		json({ ...info, action: "none", message: `already up to date (${info.current})` });
		return;
	}
	// Never `git pull` inside a checkout the user owns, and never npm-install
	// over one — the two install modes need opposite update paths.
	const mode = su.detectInstallMode();
	if (mode === "checkout") {
		json({
			...info,
			action: "manual",
			mode,
			message: "running from a git checkout — pull the latest yourself (`git pull`), then restart the CLI",
		});
		return;
	}
	process.stderr.write(`[paseo-team] installing ${info.latest} (npm install -g github:${info.slug}#${info.latest})…\n`);
	const res = su.runNpmUpdate(info.slug, info.latest);
	if (res.error || res.status !== 0) {
		fail(`npm update failed (exit ${res.status ?? "?"}${res.error ? `: ${res.error.message}` : ""})`);
	}
	json({ ...info, action: "updated", mode, message: `updated ${info.current} -> ${info.latest}` });
}

// --- web -------------------------------------------------------------------

async function cmdWeb(argv) {
	rejectUnknownFlags(argv, ["--port", "--open", "--no-token"]);
	const port = flagValue(argv, "--port");
	if (port !== undefined && !/^\d{1,5}$/.test(port)) fail("--port must be a number");
	const { startServer } = await import("../webui/server.mjs");
	try {
		await startServer({
			port: port === undefined ? undefined : Number(port),
			// No --port means the default is ours to move: fall forward to the
			// next free port instead of dying on a stale instance. A pinned
			// --port is the user's decision — fail with actionable text.
			autoPort: port === undefined,
			open: flag(argv, "--open"),
			// --no-token is for a throwaway demo on a machine you already trust.
			// It is opt-in and loud, because this UI approves permission requests.
			requireToken: !flag(argv, "--no-token"),
		});
	} catch (error) {
		fail(String(error?.message ?? error), 1);
	}
}

// ---------------------------------------------------------------------------
// Help + dispatch
// ---------------------------------------------------------------------------

function help() {
	process.stdout.write(`pteam ${su.currentVersion()} — role pack CLI (Paseo + Pi)   (alias: paseo-team)

usage:
  pteam status
  pteam preflight [--strict] [--json] [--skip-models] [--runtime pi|claude|both] [--host-id <id>] [--cluster <path>] [--routes <path>]
  pteam claude-setup [--install|--verify|--uninstall|--print-providers] [--json]
                     [--attach-cdp-port <port>]   (with --install)
  pteam config read  <section> [--no-discovery]
  pteam config write <section>             (JSON body on stdin)
  pteam prompts read <role>                (supervisor|lead|peer)
  pteam prompts write <role>               (markdown body on stdin)
  pteam skills list
  pteam skills read <name>
  pteam skills write <name>                (markdown body on stdin)
  pteam env list
  pteam install [--attach-cdp-port <port>]
  pteam uninstall [--purge]                (remove what install wrote; --purge also deletes ~/.paseo-pi-team)
  pteam update [--check]                    (compare with the latest GitHub release tag)

live plane (talks to the Paseo daemon):
  pteam agents [--all]
  pteam agent inspect <ref>
  pteam agent send <ref>                   (prompt on stdin)
  pteam permits list
  pteam permits allow <agent> <reqId>
  pteam permits deny  <agent> <reqId>
  pteam chat list
  pteam chat read <room> [--limit <n>]
  pteam chat post <room>                   (message on stdin)
  pteam models [--provider <role-provider>]
  pteam graph [--all] [--max-inspect <n>] [--refresh] [--with-chat <room[,room]>]
  pteam watchdog [--stale-after <ms>]
  pteam web [--port <n>] [--open] [--no-token]

sections: ${Object.keys(CONFIG_SECTIONS).join(", ")}
roles:    ${cw.ROLE_PROMPTS.join(", ")}
documentation: docs/webui-architecture.md
`);
}

async function main() {
	const [cmd, ...argv] = process.argv.slice(2);
	switch (cmd) {
		case "status": return cmdStatus();
		case "preflight": return cmdPreflight(argv);
		case "config": return dispatchTwo("config", argv, { read: cmdConfigRead, write: cmdConfigWrite });
		case "prompts": return dispatchTwo("prompts", argv, { read: cmdPromptsRead, write: cmdPromptsWrite });
		case "skills": return dispatchSkills(argv);
		case "env": return dispatchEnv(argv[0]);
		case "install": return cmdInstall(argv);
		case "claude-setup": return cmdClaudeSetup(argv);
		case "agents": return cmdAgents(argv);
		case "agent": return dispatchAgent(argv);
		case "permits": return dispatchPermits(argv);
		case "chat": return dispatchChat(argv);
		case "models": return cmdModels(argv);
		case "graph": return cmdGraph(argv);
		case "watchdog": return cmdWatchdog(argv);
		case "web": return cmdWeb(argv);
		case "update": return cmdUpdate(argv);
		case "uninstall": return cmdUninstall(argv);
		case "--version":
		case "-v":
			process.stdout.write(`pteam ${su.currentVersion()}\n`);
			return;
		case "--help":
		case "-h":
		case "help":
		case undefined:
			return help();
		default:
			fail(`unknown command '${cmd}'. Run 'pteam --help'.`, 2);
	}
}

function dispatchAgent(argv) {
	const [sub, ref] = argv;
	switch (sub) {
		case "inspect": if (!ref) fail("agent inspect: missing agent reference"); return cmdAgentInspect(ref);
		case "send": if (!ref) fail("agent send: missing agent reference"); return cmdAgentSend(ref);
		default: fail(`agent: unknown subcommand '${sub}' (expected inspect|send)`);
	}
}

function dispatchPermits(argv) {
	const [sub, ...rest] = argv;
	switch (sub) {
		case "list": return cmdPermitsList();
		case "allow":
		case "deny": return cmdPermitDecision(sub, rest);
		default: fail(`permits: unknown subcommand '${sub}' (expected list|allow|deny)`);
	}
}

function dispatchChat(argv) {
	const [sub, room, ...rest] = argv;
	switch (sub) {
		case "list": return cmdChatList();
		case "read": if (!room) fail("chat read: missing room"); return cmdChatRead(room, rest);
		case "post": if (!room) fail("chat post: missing room"); return cmdChatPost(room);
		default: fail(`chat: unknown subcommand '${sub}' (expected list|read|post)`);
	}
}

function dispatchTwo(parent, argv, handlers) {
	const [sub, arg] = argv;
	if (!sub) fail(`${parent}: missing subcommand (read|write)`);
	const fn = handlers[sub];
	if (!fn) fail(`${parent}: unknown subcommand '${sub}' (expected ${Object.keys(handlers).join("|")})`);
	if (!arg) fail(`${parent} ${sub}: missing argument`);
	// Trailing flags reach the handler; each one declares what it accepts and
	// rejects the rest, so a typo can never be silently dropped here.
	return fn(arg, argv.slice(2));
}

function dispatchSkills(argv) {
	const [sub, name] = argv;
	switch (sub) {
		case "list": return cmdSkillsList();
		case "read": if (!name) fail("skills read: missing skill name"); return cmdSkillsRead(name);
		case "write": if (!name) fail("skills write: missing skill name"); return cmdSkillsWrite(name);
		default: fail(`skills: unknown subcommand '${sub}' (expected list|read|write)`);
	}
}

function dispatchEnv(sub) {
	if (sub && sub !== "list") fail(`env: unknown subcommand '${sub}' (expected list)`);
	return cmdEnvList();
}

// An unhandled rejection must not exit 0 with an empty stdout: the WebUI
// treats a zero exit as "the CLI answered", and a silent success is the one
// failure mode a JSON-over-argv contract cannot recover from.
main().catch((error) => {
	fail(String(error?.stack ?? error?.message ?? error), 1);
});
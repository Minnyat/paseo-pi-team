#!/usr/bin/env node
// claude-setup.mjs — install / verify / remove the Claude Code side of the
// Paseo team role pack.
//
// Pi loads a policy extension. Claude Code has no extension API, so the same
// role invariants are bound through two user-level config files:
//
//   ~/.claude/settings.json  hooks: SessionStart, UserPromptSubmit, PreToolUse
//                            → scripts/claude-hook.mjs (role prompt + policy)
//   ~/.claude.json           mcpServers["paseo-team"]
//                            → scripts/claude-team-mcp.mjs (peer_ask_lead,
//                              lead_ask_supervisor, team_watchdog, …)
//                            mcpServers["agent-browser"]
//                            → the same stdio server browser-setup.mjs gives
//                              pi. The Lead may drive a browser and a granted
//                              Peer may too, but a server the runtime never
//                              registered leaves that policy unreachable.
//
// Both files belong to the user and already carry entries from other tools
// (Paseo installs its own hooks there), so every write MERGES: our entries are
// tagged with PASEO_TEAM_HOOK_TAG, and only tagged entries are replaced or
// removed. Nothing else in the file is touched.
//
// Usage:
//   node scripts/claude-setup.mjs --install [--claude-home <dir>] [--json]
//                                           [--attach-cdp-port <port>]
//   node scripts/claude-setup.mjs --verify  [--json]
//   node scripts/claude-setup.mjs --uninstall [--json]
//   node scripts/claude-setup.mjs --print-providers [--json]

import {
	existsSync,
	mkdirSync,
	copyFileSync,
	readFileSync,
	renameSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { isEntrypoint } from "./lib-common.mjs";
import {
	AGENT_BROWSER_MCP_SERVER,
	assertCdpPort,
	browserMcpConfig,
	isValidAgentBrowserMcpServer,
	resolveExistingEntryDecision,
} from "./browser-setup.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));

/** Marker that makes our hook entries recognizable for update and removal. */
export const PASEO_TEAM_HOOK_TAG = "paseo-team-role-policy";
export const TEAM_MCP_SERVER_NAME = "paseo-team";
export const HOOK_TIMEOUT_SECONDS = 30;

/** Hook event → the argv the hook script expects. */
export const HOOK_EVENTS = {
	SessionStart: "session-start",
	UserPromptSubmit: "user-prompt-submit",
	PreToolUse: "pre-tool-use",
};

export function claudeHome(env = process.env) {
	return env.CLAUDE_CONFIG_DIR?.trim() || join(homedir(), ".claude");
}

export function claudeSettingsPath(env = process.env) {
	return join(claudeHome(env), "settings.json");
}

/**
 * User-scope MCP servers live in ~/.claude.json, NOT in settings.json — a
 * different file with a different owner, so it is read and written separately.
 *
 * CLAUDE_CONFIG_DIR does NOT move this file (Claude Code keeps it in the home
 * directory), so tests and sandboxed installs get their own override instead —
 * without one, any test run would edit the developer's real MCP config.
 */
export function claudeUserConfigPath(env = process.env) {
	const override = env.PASEO_TEAM_CLAUDE_USER_CONFIG?.trim();
	return override || join(homedir(), ".claude.json");
}

/**
 * Forward slashes even on Windows: hook commands may be handed to a shell, and
 * a backslash path would be read as escapes there.
 */
export function normalizePath(path) {
	return resolve(path).replace(/\\/g, "/");
}

export function hookScriptPath(env = process.env) {
	return normalizePath(env.PASEO_TEAM_HOOK_SCRIPT?.trim() || join(HERE, "claude-hook.mjs"));
}

export function mcpScriptPath(env = process.env) {
	return normalizePath(
		env.PASEO_TEAM_MCP_SCRIPT?.trim() || join(HERE, "claude-team-mcp.mjs"),
	);
}

export function hookCommand(event, env = process.env) {
	return `"${normalizePath(process.execPath)}" "${hookScriptPath(env)}" ${event}`;
}

/**
 * One tagged matcher group per event, in the shape Claude Code expects.
 *
 * The matcher is EMPTY for every event, including PreToolUse: an empty matcher
 * matches all tools, and it is the form Paseo's own hooks in this same file
 * already use. A wrong matcher here would not error — it would silently stop
 * the policy from ever being consulted, so the conservative form wins.
 */
export function hookEntry(event, env = process.env) {
	return {
		matcher: "",
		hooks: [
			{
				type: "command",
				command: hookCommand(HOOK_EVENTS[event], env),
				timeout: HOOK_TIMEOUT_SECONDS,
			},
		],
		[PASEO_TEAM_HOOK_TAG]: true,
	};
}

function isOurEntry(entry) {
	if (typeof entry !== "object" || entry === null) return false;
	if (entry[PASEO_TEAM_HOOK_TAG] === true) return true;
	// Entries written before the tag existed, or hand-edited: recognise them by
	// the script they call so an upgrade replaces rather than duplicates them.
	return JSON.stringify(entry.hooks ?? []).includes("claude-hook.mjs");
}

/**
 * Merge our three hook groups into an existing settings object.
 * Returns a NEW object; the input is never mutated.
 */
export function mergeHooks(settings, env = process.env) {
	const next = { ...(settings ?? {}) };
	const hooks = { ...(next.hooks ?? {}) };
	for (const event of Object.keys(HOOK_EVENTS)) {
		const existing = Array.isArray(hooks[event]) ? hooks[event] : [];
		const others = existing.filter((entry) => !isOurEntry(entry));
		hooks[event] = [...others, hookEntry(event, env)];
	}
	next.hooks = hooks;
	return next;
}

export function removeHooks(settings) {
	const next = { ...(settings ?? {}) };
	if (!next.hooks) return next;
	const hooks = { ...next.hooks };
	for (const event of Object.keys(HOOK_EVENTS)) {
		if (!Array.isArray(hooks[event])) continue;
		const remaining = hooks[event].filter((entry) => !isOurEntry(entry));
		if (remaining.length > 0) hooks[event] = remaining;
		else delete hooks[event];
	}
	next.hooks = hooks;
	return next;
}

export function mcpServerEntry(env = process.env) {
	return {
		type: "stdio",
		command: normalizePath(process.execPath),
		args: [mcpScriptPath(env)],
	};
}

export function mergeMcpServer(config, env = process.env) {
	const next = { ...(config ?? {}) };
	next.mcpServers = {
		...(next.mcpServers ?? {}),
		[TEAM_MCP_SERVER_NAME]: mcpServerEntry(env),
	};
	return next;
}

export function removeMcpServer(config) {
	const next = { ...(config ?? {}) };
	if (!next.mcpServers?.[TEAM_MCP_SERVER_NAME]) return next;
	const servers = { ...next.mcpServers };
	delete servers[TEAM_MCP_SERVER_NAME];
	next.mcpServers = servers;
	return next;
}

/**
 * Add the agent-browser server only when the user has not configured it.
 *
 * The paseo-team entry above is ours and is rewritten on every install; this
 * one is not. agent-browser is a general-purpose tool a user may already run
 * with their own flags (a pinned --cdp port, a narrowed tool set), and the pi
 * installer has always treated such an entry as untouchable. Same rule here,
 * so the two runtimes cannot disagree about who owns the entry.
 */
export function mergeBrowserMcpServer(config, { cdpPort = null } = {}) {
	const next = { ...(config ?? {}) };
	const servers = { ...(next.mcpServers ?? {}) };
	if (isValidAgentBrowserMcpServer(servers[AGENT_BROWSER_MCP_SERVER])) return config ?? {};
	next.mcpServers = {
		...servers,
		[AGENT_BROWSER_MCP_SERVER]: browserMcpConfig({ cdpPort, dialect: "claude" }),
	};
	return next;
}

/**
 * Remove ONLY an entry this installer wrote.
 *
 * `mergeBrowserMcpServer` deliberately never rewrites a pre-existing entry, on
 * the grounds that agent-browser is a general-purpose tool a user may already
 * run with their own flags. Remove has to honour the same ownership rule or the
 * pair is asymmetric in the destructive direction: install would respectfully
 * leave a user's config alone and uninstall would delete it, recoverable only
 * from the .bak-* sibling by someone who thought to look. We never took
 * ownership of that entry, so we do not get to take it away.
 */
export function removeBrowserMcpServer(config) {
	const next = { ...(config ?? {}) };
	const existing = next.mcpServers?.[AGENT_BROWSER_MCP_SERVER];
	if (!existing) return next;
	if (!isOwnBrowserMcpServer(existing)) return next;
	const servers = { ...next.mcpServers };
	delete servers[AGENT_BROWSER_MCP_SERVER];
	next.mcpServers = servers;
	return next;
}

/**
 * Ours iff it is EXACTLY what `browserMcpConfig({dialect:"claude"})` writes for
 * the port the entry itself names. The port is the one field the installer
 * varies (`--attach-cdp-port`), so it is read back off the entry rather than
 * guessed; everything else — the `type`, the command, the arg order, the
 * absence of any key we never write — has to match a freshly rendered config.
 * Comparing against the real renderer, instead of a hand-listed set of fields,
 * means this cannot drift the next time that shape changes.
 */
export function isOwnBrowserMcpServer(server) {
	if (!server || typeof server !== "object" || Array.isArray(server)) return false;
	const args = Array.isArray(server.args) ? server.args : null;
	if (!args) return false;
	const at = args.indexOf("--cdp");
	let ours;
	try {
		ours = browserMcpConfig({
			cdpPort: at === -1 ? null : args[at + 1],
			dialect: "claude",
		});
	} catch {
		// An unusable port is not something this installer ever wrote.
		return false;
	}
	return stableJson(server) === stableJson(ours);
}

/** Key-order-independent structural compare, so a re-serialized file matches. */
function stableJson(value) {
	if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
	if (value && typeof value === "object") {
		return `{${Object.keys(value)
			.sort()
			.map((k) => `${JSON.stringify(k)}:${stableJson(value[k])}`)
			.join(",")}}`;
	}
	return JSON.stringify(value) ?? "null";
}

/**
 * A usable browser surface, not merely a present key: a disabled entry
 * registers no tools, so reporting it as installed would put the silence back
 * exactly where this check exists to remove it.
 */
export function browserMcpInstalled(config) {
	const server = config?.mcpServers?.[AGENT_BROWSER_MCP_SERVER];
	return isValidAgentBrowserMcpServer(server) && server.disabled !== true;
}

// ---------------------------------------------------------------------------
// File IO — merge in place, back up first, write atomically.
// ---------------------------------------------------------------------------

export function readJsonOrNull(path) {
	if (!existsSync(path)) return null;
	try {
		return JSON.parse(readFileSync(path, "utf8"));
	} catch {
		return undefined; // present but unreadable: never overwrite blindly
	}
}

export function writeJsonAtomic(path, value) {
	mkdirSync(dirname(path), { recursive: true });
	if (existsSync(path)) copyFileSync(path, `${path}.bak-${Date.now()}`);
	const temp = `${path}.${process.pid}.tmp`;
	writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, "utf8");
	try {
		renameSync(temp, path);
	} catch (error) {
		rmSync(temp, { force: true });
		throw error;
	}
}

function applyToFile(path, transform, { label, createIfMissing = true }) {
	const current = readJsonOrNull(path);
	if (current === undefined) {
		return { path, status: "failed", error: `${label} is not valid JSON — left untouched` };
	}
	// Removal must never CREATE the file it was asked to clean: a host that
	// never had the Claude side installed ends an uninstall with nothing added.
	if (current === null && !createIfMissing) {
		return { path, status: "missing" };
	}
	const next = transform(current);
	if (JSON.stringify(next) === JSON.stringify(current ?? {})) {
		return { path, status: "unchanged" };
	}
	writeJsonAtomic(path, next);
	return { path, status: current === null ? "created" : "updated" };
}

// ---------------------------------------------------------------------------
// Paseo provider snippet
// ---------------------------------------------------------------------------

/**
 * The three Claude role providers, with the static half of the tool policy
 * (disallowedTools) computed from the policy modules so config and code cannot
 * drift. The dynamic half — peer write/git/browser authority — is the hook's job.
 */
export async function buildProviderSnippet(env = process.env) {
	const claudePolicy = await import(
		pathToFileURL(
			join(
				env.PASEO_TEAM_POLICY_DIR?.trim() ||
					join(HERE, "..", "extensions", "paseo-team-core"),
				"claude-policy.ts",
			),
		).href
	);
	const labels = {
		supervisor: "Claude Governance Supervisor",
		lead: "Claude Project Lead",
		peer: "Claude Peer",
	};
	const providers = {};
	for (const role of ["supervisor", "lead", "peer"]) {
		providers[`claude-${role}`] = {
			extends: "claude",
			label: labels[role],
			env: { PASEO_PI_ROLE: role },
			disallowedTools: claudePolicy.claudeDisallowedTools(role),
		};
	}
	return { agents: { providers } };
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

/**
 * Why an existing entry can make the install FAIL rather than shrug: the merge
 * never rewrites an entry the user owns, which would otherwise turn
 * --attach-cdp-port into a knob that silently does nothing on the second run.
 * Mirrors resolveExistingEntryDecision on the pi side.
 */
function browserMcpConflict(userConfigPath, cdpPort) {
	if (cdpPort === null) return null;
	const config = readJsonOrNull(userConfigPath);
	if (!config || typeof config !== "object") return null;
	const server = config.mcpServers?.[AGENT_BROWSER_MCP_SERVER];
	if (!isValidAgentBrowserMcpServer(server)) return null;
	const decision = resolveExistingEntryDecision(
		{ path: userConfigPath, server },
		cdpPort,
	);
	return decision.action === "conflict" ? decision.message : null;
}

export async function install(env = process.env, { cdpPort = null } = {}) {
	const settingsPath = claudeSettingsPath(env);
	const userConfigPath = claudeUserConfigPath(env);
	const port = cdpPort === null || cdpPort === undefined ? null : assertCdpPort(cdpPort);
	const conflict = browserMcpConflict(userConfigPath, port);
	const results = {
		hooks: applyToFile(settingsPath, (current) => mergeHooks(current, env), {
			label: "~/.claude/settings.json",
		}),
		// Both servers go through ONE transform: two passes over the same file
		// would mean two backups and two writes for a single install.
		//
		// A browser conflict must NOT take the team server down with it. The two
		// entries are independent — `agent-browser` is a general-purpose tool the
		// user may already run on their own port, `paseo-team` is ours and is the
		// only way a Lead or Peer reaches team_chat, team_lease, lead_ask_supervisor
		// or peer_ask_lead.
		// Skipping both left hooks ALREADY written (mergeHooks runs first) beside
		// a fleet with no team tools at all: the seats come up governed and
		// mute. So the conflict skips exactly the entry it is about.
		mcp: applyToFile(
			userConfigPath,
			(current) => {
				const withTeam = mergeMcpServer(current, env);
				return conflict ? withTeam : mergeBrowserMcpServer(withTeam, { cdpPort: port });
			},
			{ label: "~/.claude.json" },
		),
		// Reported separately so the conflict is still visible and still fails
		// the install — the user has to resolve the port before the browser
		// surface works — without pretending the team server failed too.
		browserMcp: conflict
			? { path: userConfigPath, status: "skipped", error: conflict }
			: { path: userConfigPath, status: "ok" },
	};
	return {
		action: "install",
		hookScript: hookScriptPath(env),
		mcpScript: mcpScriptPath(env),
		...results,
		providers: await buildProviderSnippet(env),
		ok:
			results.hooks.status !== "failed" &&
			results.mcp.status !== "failed" &&
			results.browserMcp.status !== "skipped",
	};
}

/**
 * Synchronous on purpose: uninstall is called from cli/lib/uninstall.mjs, which
 * composes a plain result object. An async return there would be reported as a
 * failed removal rather than awaited.
 */
export function uninstall(env = process.env) {
	const results = {
		hooks: applyToFile(claudeSettingsPath(env), removeHooks, {
			label: "~/.claude/settings.json",
			createIfMissing: false,
		}),
		mcp: applyToFile(
			claudeUserConfigPath(env),
			(current) => removeBrowserMcpServer(removeMcpServer(current)),
			{ label: "~/.claude.json", createIfMissing: false },
		),
	};
	return {
		action: "uninstall",
		...results,
		ok: results.hooks.status !== "failed" && results.mcp.status !== "failed",
	};
}

/**
 * Every hook script path recorded in the settings file, taken from our own
 * tagged entries. The command is `"<node>" "<script>" <event>`, so the second
 * quoted token is the script.
 *
 * All three are collected, not just the first: an install that was partially
 * re-pointed (one event still calling a moved checkout) is precisely the
 * stale-install failure this command exists to catch.
 */
export function installedHookScripts(settings) {
	const scripts = new Set();
	for (const event of Object.keys(HOOK_EVENTS)) {
		const entries = Array.isArray(settings?.hooks?.[event])
			? settings.hooks[event]
			: [];
		for (const entry of entries) {
			if (!isOurEntry(entry)) continue;
			for (const hook of entry.hooks ?? []) {
				const quoted = String(hook?.command ?? "").match(/"([^"]+)"\s+"([^"]+)"/);
				if (quoted?.[2]) scripts.add(quoted[2]);
			}
		}
	}
	return [...scripts];
}

export function verify(env = process.env) {
	const settings = readJsonOrNull(claudeSettingsPath(env));
	const userConfig = readJsonOrNull(claudeUserConfigPath(env));
	const hookState = {};
	for (const event of Object.keys(HOOK_EVENTS)) {
		const entries = Array.isArray(settings?.hooks?.[event])
			? settings.hooks[event]
			: [];
		hookState[event] = entries.some(isOurEntry);
	}
	// Check the script the INSTALLED hook actually calls, not the one this
	// checkout would install. They differ whenever the pack was installed from
	// somewhere else, and a hook pointing at a moved or deleted checkout is
	// exactly the stale-install failure this command exists to catch.
	const registeredScripts = installedHookScripts(settings);
	const checkedScripts = registeredScripts.length > 0 ? registeredScripts : [hookScriptPath(env)];
	const missingScripts = checkedScripts.filter((script) => !existsSync(script));
	const scriptPresent = missingScripts.length === 0;
	const mcpPresent = Boolean(userConfig?.mcpServers?.[TEAM_MCP_SERVER_NAME]);
	const browserPresent = browserMcpInstalled(userConfig);
	const missing = [
		...Object.entries(hookState)
			.filter(([, installed]) => !installed)
			.map(([event]) => `hook:${event}`),
		...(mcpPresent ? [] : [`mcp:${TEAM_MCP_SERVER_NAME}`]),
		...(browserPresent ? [] : [`mcp:${AGENT_BROWSER_MCP_SERVER}`]),
		...missingScripts.map((script) => `script:${script}`),
	];
	return {
		action: "verify",
		settingsPath: claudeSettingsPath(env),
		userConfigPath: claudeUserConfigPath(env),
		hooks: hookState,
		mcpServer: mcpPresent,
		browserMcpServer: browserPresent,
		hookScript: scriptPresent ? checkedScripts[0] : null,
		hookScripts: checkedScripts,
		missing,
		ok: missing.length === 0,
	};
}

function usage() {
	return [
		"usage: node scripts/claude-setup.mjs <--install|--verify|--uninstall|--print-providers> [--json]",
		"",
		"  --install          merge hooks into ~/.claude/settings.json and the",
		"                     paseo-team + agent-browser MCP servers into ~/.claude.json",
		"  --attach-cdp-port  with --install: register agent-browser in attach mode",
		"                     on that CDP port instead of launch mode",
		"  --verify           report what is installed (exit 1 when incomplete)",
		"  --uninstall        remove only this pack's tagged entries",
		"  --print-providers  print the claude-* provider block for ~/.paseo/config.json",
	].join("\n");
}

export async function main(argv = process.argv.slice(2), env = process.env) {
	const json = argv.includes("--json");
	const mode = ["--install", "--verify", "--uninstall", "--print-providers"].find(
		(flag) => argv.includes(flag),
	);
	if (!mode) {
		process.stderr.write(`${usage()}\n`);
		process.exitCode = 2;
		return;
	}
	let result;
	if (mode === "--install") {
		const index = argv.indexOf("--attach-cdp-port");
		result = await install(env, {
			cdpPort: index >= 0 ? assertCdpPort(argv[index + 1]) : null,
		});
	}
	else if (mode === "--verify") result = verify(env);
	else if (mode === "--uninstall") result = uninstall(env);
	else result = { action: "print-providers", ...(await buildProviderSnippet(env)), ok: true };

	if (json) {
		process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
	} else if (mode === "--print-providers") {
		process.stdout.write(`${JSON.stringify(result.agents, null, 2)}\n`);
	} else {
		const lines = [`[paseo-team] claude ${result.action}: ${result.ok ? "ok" : "FAILED"}`];
		if (result.action === "verify") {
			// verify reports STATE (which hooks are present), not a write result:
			// printing it through the install shape yields "undefined (undefined)".
			lines.push(
				`  hooks -> ${result.settingsPath}`,
				...Object.entries(result.hooks).map(
					([event, installed]) => `    ${installed ? "✓" : "✗"} ${event}`,
				),
				`  mcp   -> ${result.mcpServer ? "✓" : "✗"} ${TEAM_MCP_SERVER_NAME} in ${result.userConfigPath}`,
				`  mcp   -> ${result.browserMcpServer ? "✓" : "✗"} ${AGENT_BROWSER_MCP_SERVER} in ${result.userConfigPath}`,
				...(result.hookScripts ?? []).map(
					(script) => `  script -> ${result.missing.includes(`script:${script}`) ? "✗ MISSING" : "✓"} ${script}`,
				),
			);
		} else {
			if (result.hooks) lines.push(`  hooks -> ${result.hooks.path} (${result.hooks.status})`);
			if (result.mcp) lines.push(`  mcp   -> ${result.mcp.path} (${result.mcp.status})`);
		}
		if (result.missing?.length) lines.push(`  missing: ${result.missing.join(", ")}`);
		if (result.action === "install") {
			lines.push(
				"  next: merge the printed provider block into ~/.paseo/config.json,",
				"        then restart the Paseo daemon:",
				"          node scripts/claude-setup.mjs --print-providers",
			);
		}
		process.stdout.write(`${lines.join("\n")}\n`);
	}
	if (!result.ok) process.exitCode = 1;
}

if (isEntrypoint(import.meta.url, process.argv[1])) {
	await main();
}

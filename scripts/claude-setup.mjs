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
//                              team_watchdog)
//
// Both files belong to the user and already carry entries from other tools
// (Paseo installs its own hooks there), so every write MERGES: our entries are
// tagged with PASEO_TEAM_HOOK_TAG, and only tagged entries are replaced or
// removed. Nothing else in the file is touched.
//
// Usage:
//   node scripts/claude-setup.mjs --install [--claude-home <dir>] [--json]
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
			join(env.PASEO_TEAM_POLICY_DIR?.trim() || join(HERE, "..", "extensions"), "claude-policy.mts"),
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

export async function install(env = process.env) {
	const settingsPath = claudeSettingsPath(env);
	const userConfigPath = claudeUserConfigPath(env);
	const results = {
		hooks: applyToFile(settingsPath, (current) => mergeHooks(current, env), {
			label: "~/.claude/settings.json",
		}),
		mcp: applyToFile(userConfigPath, (current) => mergeMcpServer(current, env), {
			label: "~/.claude.json",
		}),
	};
	return {
		action: "install",
		hookScript: hookScriptPath(env),
		mcpScript: mcpScriptPath(env),
		...results,
		providers: await buildProviderSnippet(env),
		ok: results.hooks.status !== "failed" && results.mcp.status !== "failed",
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
		mcp: applyToFile(claudeUserConfigPath(env), removeMcpServer, {
			label: "~/.claude.json",
			createIfMissing: false,
		}),
	};
	return {
		action: "uninstall",
		...results,
		ok: results.hooks.status !== "failed" && results.mcp.status !== "failed",
	};
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
	const scriptPresent = existsSync(hookScriptPath(env));
	const mcpPresent = Boolean(userConfig?.mcpServers?.[TEAM_MCP_SERVER_NAME]);
	const missing = [
		...Object.entries(hookState)
			.filter(([, installed]) => !installed)
			.map(([event]) => `hook:${event}`),
		...(mcpPresent ? [] : [`mcp:${TEAM_MCP_SERVER_NAME}`]),
		...(scriptPresent ? [] : ["script:claude-hook.mjs"]),
	];
	return {
		action: "verify",
		settingsPath: claudeSettingsPath(env),
		userConfigPath: claudeUserConfigPath(env),
		hooks: hookState,
		mcpServer: mcpPresent,
		hookScript: scriptPresent ? hookScriptPath(env) : null,
		missing,
		ok: missing.length === 0,
	};
}

function usage() {
	return [
		"usage: node scripts/claude-setup.mjs <--install|--verify|--uninstall|--print-providers> [--json]",
		"",
		"  --install          merge hooks into ~/.claude/settings.json and the",
		"                     paseo-team MCP server into ~/.claude.json",
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
	if (mode === "--install") result = await install(env);
	else if (mode === "--verify") result = verify(env);
	else if (mode === "--uninstall") result = uninstall(env);
	else result = { action: "print-providers", ...(await buildProviderSnippet(env)), ok: true };

	if (json) {
		process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
	} else if (mode === "--print-providers") {
		process.stdout.write(`${JSON.stringify(result.agents, null, 2)}\n`);
	} else {
		const lines = [`[paseo-team] claude ${result.action}: ${result.ok ? "ok" : "FAILED"}`];
		if (result.hooks) lines.push(`  hooks -> ${result.hooks.path} (${result.hooks.status})`);
		if (result.mcp) lines.push(`  mcp   -> ${result.mcp.path} (${result.mcp.status})`);
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

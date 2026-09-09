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
//
// The browser is NOT among them any more. This installer used to register an
// `agent-browser` stdio server here; both runtimes now use a browser they
// already have — Paseo Browser Control, which the daemon injects into every
// seat, and Claude in Chrome — so an install removes an agent-browser entry
// this installer previously wrote and registers none.
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
// The SAME merge `pteam seats apply` uses. Reused rather than reimplemented: a
// second merge would be a second ownership rule to keep in step with the first.
import { applySeatsToPaseoConfig } from "./seat-profiles.mjs";

/**
 * The MCP server name this installer used to write, kept only so an upgrade can
 * clean up after the version that wrote it. Nothing registers it any more.
 */
export const LEGACY_BROWSER_MCP_SERVER = "agent-browser";

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
 * Remove ONLY an agent-browser entry THIS installer wrote.
 *
 * The pack no longer ships a browser server, so an install now converges the
 * user's config to "none of ours". It still does not touch an entry the user
 * configured themselves: agent-browser is a general-purpose tool someone may
 * run with their own flags, we never took ownership of that entry, and we do
 * not get to take it away just because we stopped writing our own.
 */
export function removeBrowserMcpServer(config) {
	const next = { ...(config ?? {}) };
	const existing = next.mcpServers?.[LEGACY_BROWSER_MCP_SERVER];
	if (!existing) return next;
	if (!isOwnBrowserMcpServer(existing)) return next;
	const servers = { ...next.mcpServers };
	delete servers[LEGACY_BROWSER_MCP_SERVER];
	next.mcpServers = servers;
	return next;
}

/**
 * Ours iff it is EXACTLY one of the two shapes this installer ever wrote:
 * launch mode, or attach mode on the port the entry itself names. Anything
 * else — an extra key, a different command, a reordered arg list — is the
 * user's and stays.
 */
export function isOwnBrowserMcpServer(server) {
	if (!server || typeof server !== "object" || Array.isArray(server)) return false;
	const args = Array.isArray(server.args) ? server.args : null;
	if (!args) return false;
	const at = args.indexOf("--cdp");
	const ours =
		at === -1
			? { type: "stdio", command: "agent-browser", args: ["mcp"] }
			: {
					type: "stdio",
					command: "agent-browser",
					args: ["--cdp", String(args[at + 1] ?? ""), "mcp"],
				};
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

// ---------------------------------------------------------------------------
// File IO — merge in place, back up first, write atomically.
// ---------------------------------------------------------------------------

/**
 * Raw bytes, or `null` when absent, or `undefined` when present-but-unreadable.
 *
 * existsSync-then-readFileSync is a TOCTOU: the file can vanish between the two,
 * and a permission or IO error throws regardless. An unguarded read here would
 * escape main() as a Node stack trace — and a --json caller would get empty
 * stdout — instead of the refusal this module is careful to produce everywhere
 * else.
 */
export function readTextOrNull(path) {
	try {
		return existsSync(path) ? readFileSync(path, "utf8") : null;
	} catch {
		return undefined;
	}
}

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
/**
 * The Claude dialect of the role policy, loaded from wherever this copy of the
 * pack lives. Exported because more than one caller needs the SAME module
 * instance: the seat generator (cli/paseo-team.mjs) asks it for a deny list
 * computed under a seat's own environment, and a second import path would risk
 * answering from a different checkout than the one being installed.
 */
export async function loadClaudePolicy(env = process.env) {
	return import(
		pathToFileURL(
			join(
				env.PASEO_TEAM_POLICY_DIR?.trim() ||
					join(HERE, "..", "extensions", "paseo-team-core"),
				"claude-policy.ts",
			),
		).href
	);
}

/**
 * Claude in Chrome is off in a Paseo seat unless this variable turns it on.
 *
 * Claude Code decides the integration in a fixed order, and the seventh test is
 * `session is NOT interactive -> OFF`. A human's terminal falls through it and
 * reaches the eighth, which reads `claudeInChromeDefaultEnabled` from
 * ~/.claude.json. A Paseo seat is non-interactive by construction, so it dies at
 * the seventh and NEVER consults that config — setting the config on the host
 * does nothing for any seat.
 *
 * CLAUDE_CODE_ENABLE_CFC is evaluated FIFTH, above the non-interactive gate, so
 * it is the only documented lever a non-interactive seat can pull. The
 * alternative lever (`--chrome`, evaluated third) would mean overriding the
 * provider's `command` array, which discards the absolute binary path Paseo
 * already resolved and re-exposes the spawn to a PATH lookup.
 */
export const CLAUDE_IN_CHROME_ENV = "CLAUDE_CODE_ENABLE_CFC";

/**
 * Roles that get the browser. The Supervisor is excluded on purpose: the tool
 * policy denies it every browser surface (see the table in
 * docs/claude-runtime.md), so handing it the variable would contradict its own
 * disallowedTools — a seat advertising tools its policy rejects on every call.
 */
export const CLAUDE_IN_CHROME_ROLES = new Set(["lead", "peer"]);

export async function buildProviderSnippet(env = process.env) {
	const claudePolicy = await loadClaudePolicy(env);
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
			env: {
				PASEO_PI_ROLE: role,
				...(CLAUDE_IN_CHROME_ROLES.has(role) ? { [CLAUDE_IN_CHROME_ENV]: "1" } : {}),
			},
			disallowedTools: claudePolicy.claudeDisallowedTools(role),
		};
	}
	return { agents: { providers } };
}

// ---------------------------------------------------------------------------
// Applying the provider block to ~/.paseo/config.json
// ---------------------------------------------------------------------------

/**
 * Paseo's config. Honors PASEO_CONFIG_JSON, the same override
 * cli/lib/config-walker.mjs uses, so a test never touches the real daemon
 * config.
 */
export function paseoConfigPath(env = process.env) {
	return env.PASEO_CONFIG_JSON?.trim() || join(homedir(), ".paseo", "config.json");
}

/**
 * Our OWN ledger, deliberately NOT the seat ledger.
 *
 * `pteam seats apply` deletes any provider its ledger claims that its own
 * `generated` set no longer contains (seat-profiles.mjs). The seat document
 * never describes claude-lead/peer/supervisor, so sharing one ledger would make
 * the next unrelated `seats apply` delete all three role providers. Two files,
 * two ownership tokens, and neither command can reach the other's providers.
 */
/**
 * Parse a config that must be a JSON OBJECT. `undefined` means unusable —
 * unparseable, or valid JSON of the wrong shape (`[]`, `42`, `"x"`, `true`),
 * which would otherwise spread into an object and quietly replace the file.
 */
export function parseConfigObject(text) {
	let parsed;
	try {
		parsed = JSON.parse(text);
	} catch {
		return undefined;
	}
	if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
	return parsed;
}

export function claudeProviderLedgerPath(env = process.env) {
	const dir = env.PST_TEAM_CONFIG_DIR?.trim() || join(homedir(), ".paseo-pi-team");
	return join(dir, "claude-provider-ledger.json");
}

/**
 * What we wrote, per provider name:
 *   { mode: "created",  wrote }             — the name did not exist
 *   { mode: "replaced", wrote, previous }   — --force overwrote an operator's
 *
 * `wrote` is kept so uninstall can verify the live entry is still ours before
 * removing it, WITHOUT importing the policy (uninstall is synchronous). That is
 * the same exact-match discipline isOwnBrowserMcpServer already applies: we
 * remove what we wrote, and anything the operator reshaped afterwards is theirs.
 */
export function readProviderLedger(path) {
	const doc = readJsonOrNull(path);
	if (!doc || typeof doc !== "object" || typeof doc.providers !== "object" || doc.providers === null) {
		return {};
	}
	const out = {};
	for (const [name, entry] of Object.entries(doc.providers)) {
		if (entry && typeof entry === "object" && !Array.isArray(entry)) out[name] = entry;
	}
	return out;
}

/**
 * THE OWNERSHIP RULE. One statement of it, for both halves.
 *
 * An entry is ours iff the ledger claims it AND the live value is still byte-
 * equal to what we recorded writing. Being in the ledger is only a claim: a
 * provider we created and the operator has since hand-tuned is theirs, and
 * nothing but this comparison can tell the two apart.
 *
 * It lives in one place because this single concept has already produced three
 * separate defects in this pack — the base role providers put under the seat
 * ledger's delete-when-absent ownership, an apply that treated every ledger name
 * as ours-to-overwrite and replaced a hand-tuned provider wholesale, and a
 * skipped name losing the original an earlier --force had recorded. Different
 * code each time, one idea. `applyProviders` decides what it may write and
 * `removeProviders` decides what it may take back; both ask HERE, so they cannot
 * drift apart again the way they did when only one of them implemented it.
 */
export function providerIsOurs(live, ledgerEntry) {
	if (live === undefined || ledgerEntry === undefined) return false;
	return stableJson(live) === stableJson(ledgerEntry.wrote ?? null);
}

/**
 * Merge the claude-* provider block into ~/.paseo/config.json.
 *
 * The merge itself is delegated to applySeatsToPaseoConfig — the same function
 * `pteam seats apply` uses, already covered by test/seat-profiles.test.mjs. A
 * second merge implementation would be a second ownership rule to keep in step
 * with the first. What lives here is only the POLICY of which names to write.
 *
 * CONCURRENCY (and its limit). ~/.paseo/config.json has a second writer: the
 * daemon calls savePersistedConfig, and the app UI can mutate providers while it
 * runs. atomicWriteJson renames a temp file over the destination, which makes
 * the WRITE atomic — no reader ever sees a torn file — but it does NOTHING for
 * the read-modify-write SEQUENCE. There is no lock, no O_EXCL, no compare-and-
 * swap anywhere in this path, and adding a lockfile would buy a stale-lock
 * failure mode on a daemon host.
 *
 * So this re-reads the file immediately before writing and REFUSES if the bytes
 * changed since the read that produced `next`. That converts a silent lost
 * update into a reported one. It narrows the window to the microseconds between
 * the final read and the rename; it does not close it. A daemon write landing
 * inside that window is still lost, and that is a known, accepted race — stated
 * here rather than left for someone to discover.
 *
 * Two further known gaps, same discipline:
 *
 * - The config write and the ledger write are not atomic WITH RESPECT TO EACH
 *   OTHER, and the config goes first. If the process dies between them, the
 *   providers exist with no ownership record: a later --apply sees names it
 *   does not recognise and skips them as operator-owned, and --uninstall never
 *   removes them. Config-first is the deliberate order — the opposite failure
 *   (a ledger claiming providers that were never written) would make uninstall
 *   delete entries it did not create, which is the worse of the two.
 * - writeJsonAtomic leaves its `.tmp` sibling behind if writeFileSync throws
 *   (the rename is guarded, the write is not). Pre-existing and shared with the
 *   install path; noted, not fixed here.
 */
export async function applyProviders(env = process.env, { force = false } = {}) {
	const configPath = paseoConfigPath(env);
	const ledgerPath = claudeProviderLedgerPath(env);

	// ONE read, reused for both the parse and the conflict check below. Reading
	// twice would let `current` come from different bytes than the snapshot we
	// later compare against.
	const before = readTextOrNull(configPath);
	if (before === undefined) {
		return {
			action: "apply",
			configPath,
			status: "failed",
			error: `${configPath} exists but could not be read — left untouched`,
			ok: false,
		};
	}
	const current = before === null ? null : parseConfigObject(before);
	// `undefined` is unusable, `null` is absent — the distinction is the whole
	// point. cli/lib/config-walker.mjs's reader collapses both to null, which
	// would make a corrupt config look like a fresh one and get overwritten.
	if (current === undefined) {
		return {
			action: "apply",
			configPath,
			status: "failed",
			error: `${configPath} is not a JSON object — left untouched`,
			ok: false,
		};
	}

	const generated = (await buildProviderSnippet(env)).agents.providers;
	const ledger = readProviderLedger(ledgerPath);
	const existingProviders = current?.agents?.providers ?? {};

	// Policy: which of the generated names do we actually write?
	const toWrite = {};
	const deleted = [];
	for (const [name, entry] of Object.entries(generated)) {
		const live = existingProviders[name];
		// In our ledger but gone from the config: the operator removed it on
		// purpose after we created it. Re-adding it silently would undo a
		// deliberate act, so it takes an explicit --force. The ledger entry is
		// KEPT below, or the next run would read "unknown name" and create it.
		if (live === undefined && ledger[name] !== undefined && !force) {
			deleted.push(name);
			continue;
		}
		toWrite[name] = entry;
	}

	// See providerIsOurs. Without this the name would go into
	// applySeatsToPaseoConfig's owned set, bypass its skip guard and overwrite the
	// operator's edit wholesale — and since the generated block changed in
	// 6ac3e81, running --apply again is the upgrade path for every existing
	// install, so that is the exact run that would have discarded it.
	const liveIsOurs = (name) => providerIsOurs(existingProviders[name], ledger[name]);

	// Names we still own: ours-and-unmodified, plus ones already gone from the
	// config (kept owned so a retired provider can still be cleaned up).
	const ownedNow = Object.keys(ledger).filter(
		(name) => existingProviders[name] === undefined || liveIsOurs(name),
	);
	// --force adopts what the operator owns. The set is the UNION with the
	// ledger, not just what we are writing: a name we generated in an older
	// version and no longer generate must stay owned, or the deletion loop never
	// sees it and it is stranded in the config with no ownership record —
	// unreachable by any later --apply or --uninstall.
	const ownedForMerge = force
		? [...new Set([...Object.keys(ledger), ...Object.keys(toWrite)])]
		: ownedNow;
	const result = applySeatsToPaseoConfig(current, toWrite, ownedForMerge);

	const nextLedger = {};
	for (const name of Object.keys(toWrite)) {
		if (result.skipped.includes(name)) {
			// We did not write it, so we make no NEW claim — but an earlier
			// --force may have recorded the operator's original here, and that
			// record is the only copy of it. Dropping the entry because this run
			// skipped the name would quietly retire a guarantee this pack makes in
			// writing: that --force stores what it replaced so --uninstall can put
			// the original back.
			if (ledger[name] !== undefined) nextLedger[name] = ledger[name];
			continue;
		}
		const live = existingProviders[name];
		const wrote = toWrite[name];
		if (live === undefined || liveIsOurs(name)) {
			// Ours, or not there at all. Carry forward an operator original we
			// recorded on an earlier --force so uninstall can still restore it.
			const prior = ledger[name];
			nextLedger[name] =
				prior?.previous !== undefined
					? { mode: "replaced", wrote, previous: prior.previous }
					: { mode: "created", wrote };
		} else {
			// Theirs — never ours, or ours-then-edited. --force is replacing it,
			// so THEIR version is what uninstall has to be able to put back.
			nextLedger[name] = { mode: "replaced", wrote, previous: live };
		}
	}
	// A name the operator deleted stays claimed, so a later run still recognises
	// it as ours-but-removed rather than creating it afresh.
	for (const name of deleted) nextLedger[name] = ledger[name];

	const unchanged =
		result.created.length === 0 && result.updated.length === 0 && result.removed.length === 0;

	// See CONCURRENCY above: detect a competing write, do not try to lock. An
	// unreadable re-read counts as one too — fail closed, since the one thing we
	// must not do is write over bytes we could not check.
	//
	// This runs BEFORE the unchanged branch, not inside it. Every conclusion
	// below was drawn from `before`, and "there is nothing to do" is just as
	// stale as any other: a competing write that lands between our read and the
	// ledger read makes the three providers look deliberately deleted, so we
	// would report a confident no-op — and skip the conflict check entirely —
	// on the strength of data we already know is out of date.
	const now = readTextOrNull(configPath);
	if (now === undefined || now !== before) {
		return {
			action: "apply",
			configPath,
			status: "conflict",
			error: `${configPath} changed while this command was running (the daemon or the app also writes it) — nothing was written, re-run to pick up both changes`,
			ok: false,
		};
	}
	if (!unchanged) {
		writeJsonAtomic(configPath, result.config);
	}
	// Only when it actually differs: an unchanged apply that still rewrote the
	// ledger would leave a fresh .bak behind on every run.
	if (stableJson(readProviderLedger(ledgerPath)) !== stableJson(nextLedger)) {
		writeJsonAtomic(ledgerPath, {
			version: 1,
			updatedAt: new Date().toISOString(),
			providers: nextLedger,
		});
	}

	// What is ACTUALLY on the host now. "Nothing to do" and "the providers are
	// present" are different claims, and only this one can be checked: an
	// operator who deleted all three and re-ran would otherwise be told the work
	// was already done while the host carries none of it.
	const finalProviders = result.config?.agents?.providers ?? {};
	const absent = Object.keys(generated).filter((name) => finalProviders[name] === undefined);
	// The complement, because "some of ours are on the host" is what decides
	// whether an activation warning is owed on a run that wrote nothing.
	const present = Object.keys(generated).filter((name) => finalProviders[name] !== undefined);

	return {
		action: "apply",
		configPath,
		ledgerPath,
		status: absent.length > 0 ? "incomplete" : unchanged ? "unchanged" : current === null ? "created" : "updated",
		// Generated names that are NOT in the config after this run. Never
		// reported as success: the host is missing providers we are supposed to
		// have put there, whatever the reason.
		absent,
		present,
		created: result.created,
		updated: result.updated,
		// Names this pack once generated and no longer does, retired from the
		// config. Exposed because a caller cannot otherwise tell a retirement
		// happened, and a test asserting on it had nothing to read.
		removed: result.removed,
		// A provider the operator hand-wrote is never overwritten without --force.
		skipped: result.skipped,
		// In our ledger, deleted from the config by the operator, left deleted.
		deletedByOperator: deleted,
		providers: toWrite,
		// Not ok when a generated provider is missing from the host, even though
		// the command itself did exactly what it should have.
		ok: absent.length === 0,
	};
}

/**
 * Back out exactly what applyProviders wrote, and nothing else.
 *
 * Synchronous, like the rest of uninstall: the ledger records the entry we
 * wrote, so no policy import is needed to decide ownership.
 *   created  + still ours -> delete it
 *   replaced + still ours -> restore the operator's original
 *   reshaped by the operator since -> leave it, report it
 */
export function removeProviders(env = process.env) {
	const configPath = paseoConfigPath(env);
	const ledgerPath = claudeProviderLedgerPath(env);
	const ledger = readProviderLedger(ledgerPath);
	if (Object.keys(ledger).length === 0) {
		return { action: "remove-providers", configPath, status: "missing", ok: true };
	}
	// The SAME discriminator apply uses. A weaker check here let valid JSON of
	// the wrong shape through: nothing was removed or restored, and the ledger
	// was then deleted anyway — destroying the `previous` entries needed to put
	// a --force-replaced operator provider back. The ledger is the only record
	// of that, so it must outlive any config we did not understand.
	const raw = readTextOrNull(configPath);
	const current = raw === null ? null : raw === undefined ? undefined : parseConfigObject(raw);
	if (current === undefined) {
		return {
			action: "remove-providers",
			configPath,
			status: "failed",
			error: `${configPath} is not a readable JSON object — left untouched, and the ledger is kept`,
			ok: false,
		};
	}

	const removed = [];
	const restored = [];
	const kept = [];
	const providers = { ...(current?.agents?.providers ?? {}) };
	for (const [name, entry] of Object.entries(ledger)) {
		const live = providers[name];
		if (live === undefined) continue;
		if (!providerIsOurs(live, entry)) {
			// Changed since we wrote it: it is the operator's now.
			kept.push(name);
			continue;
		}
		if (entry.mode === "replaced" && entry.previous !== undefined) {
			providers[name] = entry.previous;
			restored.push(name);
		} else {
			delete providers[name];
			removed.push(name);
		}
	}

	if (removed.length > 0 || restored.length > 0) {
		const next = { ...(current ?? {}) };
		next.agents = { ...(next.agents ?? {}), providers };
		writeJsonAtomic(configPath, next);
	}
	rmSync(ledgerPath, { force: true });
	return {
		action: "remove-providers",
		configPath,
		removed,
		restored,
		kept,
		status: removed.length + restored.length > 0 ? "updated" : "unchanged",
		ok: true,
	};
}

/**
 * The text an operator reads after --apply.
 *
 * Printing a command is not the same as saying "this is not live yet". The bug
 * this whole change fixes was a correct setting sitting in a file doing nothing,
 * and apply ships exactly that state by design — so the inertness has to be
 * stated in words, for someone who does not know how Paseo loads providers.
 */
/** Did this run change the config at all? */
function wroteAnything(result) {
	return (
		(result.created?.length ?? 0) +
			(result.updated?.length ?? 0) +
			(result.removed?.length ?? 0) >
		0
	);
}

export function applyNextSteps(result) {
	// Providers we are supposed to have written are not on the host. Saying
	// "already applied" here would be false in the most expensive direction.
	if (result.absent?.length) {
		// A run can BOTH write and leave something absent — the operator deleted
		// one provider, and the other two need updating because the generated
		// block changed. That is the ordinary upgrade path, and returning early
		// here dropped the activation warning from the one branch that says the
		// operator most needs to read it. The note is owed whenever this run wrote
		// anything, and equally whenever some of our providers ARE on the host and
		// may simply not have been loaded yet.
		const pending = wroteAnything(result) || (result.present?.length ?? 0) > 0;
		return [
			"",
			`  MISSING FROM THIS HOST: ${result.absent.join(", ")}`,
			"  These were not written, because you deleted them after a previous",
			"  apply and a deliberate deletion is not undone silently. Until they",
			"  are restored, seats using them cannot start. Re-create them with:",
			"",
			"         node scripts/claude-setup.mjs --apply --force",
			...(pending ? ["", ...pendingStateNote()] : []),
		];
	}
	if (result.status === "unchanged") {
		return [
			"",
			result.skipped?.length
				? `  Nothing was written. ${result.skipped.join(", ")} still differ${result.skipped.length === 1 ? "s" : ""} from what this pack generates, and was left alone because you own it.`
				: "  The file already says what it should — nothing was written.",
			"  That is NOT the same as the change being live. This command cannot",
			"  tell whether the daemon has re-read the file since it was written,",
			"  and it cannot tell whether any running agent predates that. If you",
			"  have not reloaded since the first apply, see the note below.",
			"",
			...pendingStateNote(),
		];
	}
	return [
		"",
		"  THIS HAS NOT TAKEN EFFECT YET.",
		"  Writing the file changed nothing by itself. Two separate things must happen:",
		"",
		"    1. The Paseo daemon has to re-read the file:",
		"",
		"         paseo daemon reload",
		"",
		"       A reload is enough — agents.providers is reloadable, and the",
		"       provider registry is rebuilt live. You do not need to restart,",
		"       and a restart would kill every agent running on this host.",
		"",
		"    2. The agents have to be created AFTER that re-read. An agent reads",
		"       its provider once, at the moment it is spawned, and keeps those",
		"       settings for the rest of its life. Agents that are already",
		"       running will NOT pick this up — there is no way to hand them the",
		"       change short of replacing them.",
		"",
		"  In short: reload, then start a NEW agent. An agent started before now",
		"  keeps the old settings no matter how many times you reload.",
		"",
		...pendingStateNote(),
	];
}

/**
 * The pending state is not dormant.
 *
 * It is tempting to describe an unapplied config as waiting for the operator to
 * act. It is not: the daemon can be re-read by something other than the person
 * who wrote the file — an unattended restart, a supervisor, another operator,
 * a crash-recovery — at a time nobody chose. On this host a daemon restarted on
 * its own and took 9 of 16 live seats with it. So the honest framing is not
 * "run this when ready" but "this will activate at the next reload OR restart,
 * whoever causes it".
 */
export function pendingStateNote() {
	return [
		"  WHEN THIS ACTIVATES IS NOT ENTIRELY UP TO YOU.",
		"  A written-but-unloaded config is not dormant. It takes effect at the",
		"  next reload OR RESTART of the daemon,",
		"  and that may not be under your control:",
		"  an unattended restart, another operator, or a crash recovery will apply",
		"  it just as surely as you would, at a moment you did not pick.",
		"  Treat the file as live from the moment you write it — if you are not",
		"  ready for this change to take effect, do not apply it yet.",
	];
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
		// One transform over the file: registering the team server and dropping a
		// browser entry a previous version of this installer wrote. Two passes
		// would mean two backups and two writes for a single install.
		mcp: applyToFile(
			userConfigPath,
			(current) => removeBrowserMcpServer(mergeMcpServer(current, env)),
			{ label: "~/.claude.json" },
		),
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
		mcp: applyToFile(
			claudeUserConfigPath(env),
			(current) => removeBrowserMcpServer(removeMcpServer(current)),
			{ label: "~/.claude.json", createIfMissing: false },
		),
		// Symmetry with --apply: back out the providers we wrote to
		// ~/.paseo/config.json. No ledger means we never applied, and this is a
		// no-op — it never touches a config this pack did not write to.
		providers: removeProviders(env),
	};
	return {
		action: "uninstall",
		...results,
		ok:
			results.hooks.status !== "failed" &&
			results.mcp.status !== "failed" &&
			results.providers.status !== "failed",
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
	const missing = [
		...Object.entries(hookState)
			.filter(([, installed]) => !installed)
			.map(([event]) => `hook:${event}`),
		...(mcpPresent ? [] : [`mcp:${TEAM_MCP_SERVER_NAME}`]),
		...missingScripts.map((script) => `script:${script}`),
	];
	return {
		action: "verify",
		settingsPath: claudeSettingsPath(env),
		userConfigPath: claudeUserConfigPath(env),
		hooks: hookState,
		mcpServer: mcpPresent,
		hookScript: scriptPresent ? checkedScripts[0] : null,
		hookScripts: checkedScripts,
		missing,
		ok: missing.length === 0,
	};
}

function usage() {
	return [
		"usage: node scripts/claude-setup.mjs <--install|--apply|--verify|--uninstall|--print-providers> [--json] [--force]",
		"",
		"  --install          merge hooks into ~/.claude/settings.json and the",
		"                     paseo-team MCP server into ~/.claude.json",
		"                     on that CDP port instead of launch mode",
		"  --apply            merge the claude-* provider block into",
		"                     ~/.paseo/config.json (does NOT reload the daemon)",
		"  --verify           report what is installed (exit 1 when incomplete)",
		"  --uninstall        remove only this pack's tagged entries",
		"  --print-providers  print the claude-* provider block for ~/.paseo/config.json",
		"",
		"  --force            with --apply, three things. Overwrite a provider the",
		"                     operator owns; re-create one they deleted; and retire",
		"                     one this pack no longer generates EVEN IF they have",
		"                     since edited it (plain --apply leaves that one alone).",
		"                     Off by default.",
	].join("\n");
}

export async function main(argv = process.argv.slice(2), env = process.env) {
	const json = argv.includes("--json");
	const force = argv.includes("--force");
	const mode = ["--install", "--apply", "--verify", "--uninstall", "--print-providers"].find(
		(flag) => argv.includes(flag),
	);
	if (!mode) {
		process.stderr.write(`${usage()}\n`);
		process.exitCode = 2;
		return;
	}
	// --force only means anything to --apply. Accepting it silently elsewhere
	// would read as "the force took effect" for an operation that never had one.
	if (force && mode !== "--apply") {
		process.stderr.write(`--force is only valid with --apply\n${usage()}\n`);
		process.exitCode = 2;
		return;
	}
	let result;
	if (mode === "--install") result = await install(env);
	else if (mode === "--apply") result = await applyProviders(env, { force });
	else if (mode === "--verify") result = verify(env);
	else if (mode === "--uninstall") result = uninstall(env);
	else result = { action: "print-providers", ...(await buildProviderSnippet(env)), ok: true };

	if (json) {
		process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
	} else if (mode === "--print-providers") {
		process.stdout.write(`${JSON.stringify(result.agents, null, 2)}\n`);
	} else {
		// apply has more outcomes than ok/FAILED — "incomplete" is neither a
		// success nor a failure of the command, so print the status it computed.
		const headline =
			result.action === "apply" ? result.status : result.ok ? "ok" : "FAILED";
		const lines = [`[paseo-team] claude ${result.action}: ${headline}`];
		if (result.action === "verify") {
			// verify reports STATE (which hooks are present), not a write result:
			// printing it through the install shape yields "undefined (undefined)".
			lines.push(
				`  hooks -> ${result.settingsPath}`,
				...Object.entries(result.hooks).map(
					([event, installed]) => `    ${installed ? "✓" : "✗"} ${event}`,
				),
				`  mcp   -> ${result.mcpServer ? "✓" : "✗"} ${TEAM_MCP_SERVER_NAME} in ${result.userConfigPath}`,
				...(result.hookScripts ?? []).map(
					(script) => `  script -> ${result.missing.includes(`script:${script}`) ? "✗ MISSING" : "✓"} ${script}`,
				),
			);
		} else if (result.action === "apply") {
			lines.push(`  config -> ${result.configPath} (${result.status})`);
			if (result.error) lines.push(`  ${result.error}`);
			for (const [label, names] of [
				["created", result.created],
				["updated", result.updated],
				// A retirement DELETES an entry from the operator's config. Leaving
				// it off this list meant the default output said nothing about it.
				["retired (no longer generated by this pack)", result.removed],
				["skipped (yours — use --force to overwrite)", result.skipped],
				["left deleted (you removed it — use --force to re-create)", result.deletedByOperator],
			]) {
				if (names?.length) lines.push(`    ${label}: ${names.join(", ")}`);
			}
			// Printed for "incomplete" too (ok is false there): that branch is
			// precisely the one the operator most needs to read.
			if (result.status !== "failed" && result.status !== "conflict") {
				lines.push(...applyNextSteps(result));
			}
		} else {
			if (result.hooks) lines.push(`  hooks -> ${result.hooks.path} (${result.hooks.status})`);
			if (result.mcp) lines.push(`  mcp   -> ${result.mcp.path} (${result.mcp.status})`);
		}
		if (result.missing?.length) lines.push(`  missing: ${result.missing.join(", ")}`);
		if (result.action === "install") {
			lines.push(
				"  next: write the claude-* providers into ~/.paseo/config.json:",
				"          node scripts/claude-setup.mjs --apply",
				"        (--print-providers still prints the block for a manual merge)",
			);
		}
		process.stdout.write(`${lines.join("\n")}\n`);
	}
	if (!result.ok) process.exitCode = 1;
}

if (isEntrypoint(import.meta.url, process.argv[1])) {
	await main();
}

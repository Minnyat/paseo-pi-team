// claude-hook.mjs — Claude Code hook adapter for the Paseo team role pack.
//
// Claude Code has no extension API: role behaviour is bound through settings
// hooks, and every hook is a SEPARATE PROCESS. This script is that process for
// three events, selected by argv[2]:
//
//   session-start       → inject the role prompt, reset per-session state
//   user-prompt-submit  → parse the turn's V3 brief, persist it, inject the
//                         resolved authority block
//   pre-tool-use        → allow/deny the call through extensions/claude-policy.mts
//
// The per-turn brief therefore cannot live in memory the way it does in the Pi
// extension. It is written once per prompt to
// ~/.paseo-pi-team/claude-sessions/<session>.json and re-read per tool call,
// with the session transcript as a second, independent source when that file
// is missing or stale. Both paths are fail-closed: no readable brief means a
// read-only turn, exactly like an unbriefed Pi peer.
//
// PASEO_PI_ROLE unset → the hook stays passive and prints nothing, so it is
// safe to install globally for humans using Claude Code outside the team.

import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { isEntrypoint } from "./lib-common.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));

/** Brief older than this is treated as absent (a stale turn never grants write). */
export const SESSION_STATE_TTL_MS = 12 * 60 * 60 * 1000;

/**
 * The policy modules live next to the Pi extension after install
 * (`<ext>/policy-core.mts`, this script in `<ext>/paseo-team-scripts/`) and in
 * `extensions/` in a source checkout. Same two-candidate shape the Pi
 * extension uses for support scripts, resolved at runtime because the two
 * layouts differ by one directory level.
 */
export function policyModulePath(name, env = process.env) {
	const configured = env.PASEO_TEAM_POLICY_DIR?.trim();
	const candidates = configured
		? [join(configured, name)]
		: [join(HERE, "..", name), join(HERE, "..", "extensions", name)];
	const found = candidates.find((candidate) => existsSync(candidate));
	if (!found) {
		throw new Error(
			`Paseo team policy module is missing: ${name} (looked in ${candidates.join(", ")})`,
		);
	}
	return found;
}

let policyModules = null;
async function loadPolicy(env = process.env) {
	if (policyModules) return policyModules;
	const core = await import(
		pathToFileURL(policyModulePath("policy-core.mts", env)).href
	);
	const claude = await import(
		pathToFileURL(policyModulePath("claude-policy.mts", env)).href
	);
	policyModules = { core, claude };
	return policyModules;
}

export function teamHome(env = process.env) {
	return env.PASEO_TEAM_HOME?.trim() || join(homedir(), ".paseo-pi-team");
}

export function sessionStateDir(env = process.env) {
	return join(teamHome(env), "claude-sessions");
}

/**
 * Session ids come from Claude, not from us, so they are sanitized before
 * touching the filesystem: a hostile id must never escape the state directory.
 */
export function sessionStatePath(sessionId, env = process.env) {
	const safe = String(sessionId ?? "")
		.replace(/[^A-Za-z0-9._-]/g, "_")
		.slice(0, 128);
	return join(sessionStateDir(env), `${safe || "unknown"}.json`);
}

export function readSessionState(sessionId, env = process.env, now = Date.now()) {
	const path = sessionStatePath(sessionId, env);
	if (!existsSync(path)) return null;
	try {
		const parsed = JSON.parse(readFileSync(path, "utf8"));
		if (typeof parsed !== "object" || parsed === null) return null;
		const updatedAt = Date.parse(parsed.updatedAt ?? "");
		if (!Number.isFinite(updatedAt) || now - updatedAt > SESSION_STATE_TTL_MS) {
			return null;
		}
		return parsed;
	} catch {
		return null;
	}
}

export function writeSessionState(sessionId, state, env = process.env) {
	const dir = sessionStateDir(env);
	mkdirSync(dir, { recursive: true });
	const path = sessionStatePath(sessionId, env);
	const temporary = `${path}.tmp-${process.pid}`;
	writeFileSync(temporary, `${JSON.stringify(state, null, 2)}\n`, "utf8");
	// Rename, not delete-then-write: a reader landing between the two would see
	// no brief at all. That direction is safe (read-only), but it would drop
	// write mode mid-turn in a way indistinguishable from a policy bug.
	try {
		renameSync(temporary, path);
	} catch (error) {
		rmSync(temporary, { force: true });
		throw error;
	}
	return path;
}

/**
 * Last human prompt from a Claude transcript, ignoring tool results and meta
 * entries (those are user-role messages too, but they are never a task brief).
 */
export function lastUserPrompt(transcriptPath) {
	if (!transcriptPath || !existsSync(transcriptPath)) return null;
	let lines;
	try {
		lines = readFileSync(transcriptPath, "utf8").split(/\r?\n/);
	} catch {
		return null;
	}
	for (let index = lines.length - 1; index >= 0; index--) {
		const line = lines[index]?.trim();
		if (!line) continue;
		let entry;
		try {
			entry = JSON.parse(line);
		} catch {
			continue;
		}
		if (entry?.type !== "user" || entry?.isMeta === true) continue;
		const content = entry?.message?.content;
		if (typeof content === "string") return content;
		if (!Array.isArray(content)) continue;
		const text = content
			.filter((block) => block?.type === "text" && typeof block.text === "string")
			.map((block) => block.text)
			.join("\n");
		if (text.trim().length > 0) return text;
	}
	return null;
}

/**
 * The brief in force for the current tool call. State file first (written by
 * user-prompt-submit for THIS turn), transcript second (covers a session whose
 * prompt hook never ran). Neither available → null → read-only.
 */
export async function currentBrief(payload, env = process.env, now = Date.now()) {
	const { core } = await loadPolicy(env);
	const state = readSessionState(payload?.session_id, env, now);
	if (state?.brief) {
		const restored = core.deserializeBrief(state.brief);
		if (restored) return restored;
	}
	const prompt = lastUserPrompt(payload?.transcript_path);
	return prompt ? core.parseTaskBrief(prompt) : null;
}

function roleContextBlock(rolePrompt, role) {
	return [
		"## Paseo Team Role",
		"",
		`You are running as the ${role} role of the Paseo team pack. The role`,
		"contract below is binding for this session; a tool call that violates it",
		"is denied by the policy hook before it runs.",
		"",
		rolePrompt,
	].join("\n");
}

function authorityBlock(describe, role, brief) {
	return [
		"## Paseo Team Authority (this turn)",
		"",
		"```",
		describe(role, brief),
		"```",
		brief?.malformed?.length
			? `The task brief is malformed and was rejected fail-closed: ${brief.malformed.join("; ")}. Treat this turn as read-only and report AUTHORITY_MISMATCH.`
			: "",
	]
		.filter(Boolean)
		.join("\n");
}

/**
 * Handle one hook event. Returns the object to print on stdout (or null for
 * "say nothing"), never throws for policy reasons — the caller turns an
 * unexpected throw into a fail-closed deny.
 */
export async function handleEvent(event, payload, env = process.env, now = Date.now()) {
	const { core, claude } = await loadPolicy(env);
	const role = core.detectRole(env);
	if (!role) return null; // passive outside the team

	if (event === "session-start") {
		writeSessionState(
			payload?.session_id,
			{
				sessionId: payload?.session_id ?? null,
				role,
				updatedAt: new Date(now).toISOString(),
				rolePromptInjected: true,
				brief: null,
			},
			env,
		);
		const rolePrompt = core.loadRolePrompt(role);
		if (!rolePrompt) return null;
		return {
			hookSpecificOutput: {
				hookEventName: "SessionStart",
				additionalContext: roleContextBlock(rolePrompt, role),
			},
		};
	}

	if (event === "user-prompt-submit") {
		const prompt = typeof payload?.prompt === "string" ? payload.prompt : "";
		// Authority is recomputed from THIS prompt on every turn and never
		// inherited: same invariant as the Pi extension's before_agent_start.
		const brief = role === "peer" ? core.parseTaskBrief(prompt) : null;
		const previous = readSessionState(payload?.session_id, env, now);
		const injected = previous?.rolePromptInjected === true;
		writeSessionState(
			payload?.session_id,
			{
				sessionId: payload?.session_id ?? null,
				role,
				updatedAt: new Date(now).toISOString(),
				rolePromptInjected: true,
				brief: brief ? core.serializeBrief(brief) : null,
			},
			env,
		);
		const blocks = [];
		// SessionStart is not guaranteed to have run (a resumed or imported
		// session may start at the first prompt), so the role prompt is injected
		// here too when it has not been injected yet.
		if (!injected) {
			const rolePrompt = core.loadRolePrompt(role);
			if (rolePrompt) blocks.push(roleContextBlock(rolePrompt, role));
		}
		if (role === "peer") {
			blocks.push(authorityBlock(claude.describeClaudePolicy, role, brief));
		}
		if (blocks.length === 0) return null;
		return {
			hookSpecificOutput: {
				hookEventName: "UserPromptSubmit",
				additionalContext: blocks.join("\n\n"),
			},
		};
	}

	if (event === "pre-tool-use") {
		const brief = await currentBrief(payload, env, now);
		const reason = claude.claudeToolBlockReason({
			role,
			toolName: String(payload?.tool_name ?? ""),
			toolInput: payload?.tool_input,
			brief,
		});
		if (!reason) return null; // allow: say nothing, let normal permissions apply
		return {
			hookSpecificOutput: {
				hookEventName: "PreToolUse",
				permissionDecision: "deny",
				permissionDecisionReason: `[paseo-team ${role}] ${reason}`,
			},
		};
	}

	throw new Error(`unknown hook event: ${event}`);
}

export const HOOK_EVENTS = ["session-start", "user-prompt-submit", "pre-tool-use"];

async function readStdin() {
	const chunks = [];
	for await (const chunk of process.stdin) chunks.push(chunk);
	const text = Buffer.concat(chunks).toString("utf8").trim();
	if (!text) return {};
	try {
		return JSON.parse(text);
	} catch {
		return {};
	}
}

export async function main(argv = process.argv, env = process.env) {
	const event = argv[2];
	if (!HOOK_EVENTS.includes(event)) {
		process.stderr.write(
			`usage: node claude-hook.mjs <${HOOK_EVENTS.join("|")}>\n`,
		);
		process.exitCode = 2;
		return;
	}
	const payload = await readStdin();
	try {
		const output = await handleEvent(event, payload, env);
		if (output) process.stdout.write(`${JSON.stringify(output)}\n`);
	} catch (error) {
		const message = error?.message ?? String(error);
		process.stderr.write(`[paseo-team] hook error: ${message}\n`);
		// Fail closed, but only where a decision is being made: a broken policy
		// hook must not silently hand a Peer the tools it was meant to gate.
		if (event === "pre-tool-use" && env.PASEO_PI_ROLE?.trim()) {
			process.stdout.write(
				`${JSON.stringify({
					hookSpecificOutput: {
						hookEventName: "PreToolUse",
						permissionDecision: "deny",
						permissionDecisionReason: `[paseo-team] role policy hook failed (${message}) — denying fail-closed. Report BLOCKED to the Lead.`,
					},
				})}\n`,
			);
		}
	}
}

if (isEntrypoint(import.meta.url, process.argv[1])) {
	await main();
}

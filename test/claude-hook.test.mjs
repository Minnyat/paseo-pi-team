// claude-hook.test.mjs — the Claude Code hook adapter.
//
// The Pi extension keeps the turn's brief in memory. Claude runs every hook in
// its own process, so the brief travels through a state file (and, as a second
// source, the session transcript). These tests pin the parts that make that
// safe: authority is recomputed per prompt, never inherited; a missing, stale
// or corrupt state file resolves to read-only; and a hook that throws denies
// rather than silently allowing.

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
	handleEvent,
	lastUserPrompt,
	readSessionState,
	sessionStatePath,
	writeSessionState,
	SESSION_STATE_TTL_MS,
} from "../scripts/claude-hook.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const hookPath = join(root, "scripts", "claude-hook.mjs");
const home = mkdtempSync(join(tmpdir(), "paseo-claude-hook-"));
const baseEnv = { PASEO_TEAM_HOME: home };

const V3_WRITE = [
	"PASEO_TEAM_TASK_V3_BEGIN",
	"TASK_ID: T-77",
	"MODE: write",
	"EDIT_AUTHORITY: allowed",
	"PASEO_TEAM_TASK_V3_END",
	"",
	"Implement the thing.",
].join("\n");

const peerEnv = { ...baseEnv, PASEO_PI_ROLE: "peer" };

function runHook(event, payload, env = peerEnv) {
	const stdout = execFileSync(process.execPath, [hookPath, event], {
		encoding: "utf8",
		input: JSON.stringify(payload),
		env: { ...process.env, ...env },
	});
	return stdout.trim() ? JSON.parse(stdout) : null;
}

// --- passive without a role ---------------------------------------------------

assert.equal(
	await handleEvent("pre-tool-use", { session_id: "s0", tool_name: "Write" }, baseEnv),
	null,
	"no PASEO_PI_ROLE → no policy at all (safe to install globally)",
);
assert.equal(runHook("pre-tool-use", { session_id: "s0", tool_name: "Write" }, baseEnv), null);

// --- the brief is recomputed per prompt, never inherited -----------------------

{
	const env = { ...peerEnv };
	await handleEvent("user-prompt-submit", { session_id: "s1", prompt: V3_WRITE }, env);
	const allowed = await handleEvent(
		"pre-tool-use",
		{ session_id: "s1", tool_name: "Write", tool_input: { file_path: "a" } },
		env,
	);
	assert.equal(allowed, null, "write brief → Write allowed");

	// The next turn, with an unbriefed prompt, must drop write mode.
	await handleEvent("user-prompt-submit", { session_id: "s1", prompt: "just chat" }, env);
	const denied = await handleEvent(
		"pre-tool-use",
		{ session_id: "s1", tool_name: "Write", tool_input: { file_path: "a" } },
		env,
	);
	assert.match(
		denied.hookSpecificOutput.permissionDecisionReason,
		/read-only/,
		"write mode must not leak across turns",
	);
	assert.equal(denied.hookSpecificOutput.permissionDecision, "deny");
	assert.equal(denied.hookSpecificOutput.hookEventName, "PreToolUse");
}

// --- state file: fail-closed on missing, stale and corrupt --------------------

{
	const env = { ...peerEnv };
	await handleEvent("user-prompt-submit", { session_id: "s2", prompt: V3_WRITE }, env);
	const statePath = sessionStatePath("s2", env);
	assert.ok(existsSync(statePath));

	// Stale: a brief older than the TTL is not a brief any more.
	const future = Date.now() + SESSION_STATE_TTL_MS + 60_000;
	assert.equal(readSessionState("s2", env, future), null);
	const stale = await handleEvent(
		"pre-tool-use",
		{ session_id: "s2", tool_name: "Write" },
		env,
		future,
	);
	assert.match(stale.hookSpecificOutput.permissionDecisionReason, /read-only/);

	// Corrupt: unreadable state is treated as no state.
	writeFileSync(statePath, "{ not json", "utf8");
	assert.equal(readSessionState("s2", env), null);
	const corrupt = await handleEvent(
		"pre-tool-use",
		{ session_id: "s2", tool_name: "Write" },
		env,
	);
	assert.match(corrupt.hookSpecificOutput.permissionDecisionReason, /read-only/);
}

// A hostile session id must not escape the state directory. Separators are
// replaced rather than rejected, so the file always lands INSIDE the state dir
// (a literal ".." in the file NAME is harmless — traversal needs a separator).
{
	const stateDir = join(home, "claude-sessions");
	for (const hostile of ["../../evil", "..\\..\\evil", "a/b/c", "with space"]) {
		const path = sessionStatePath(hostile, baseEnv);
		assert.equal(dirname(path), stateDir, `${hostile} escaped to ${path}`);
	}
	assert.equal(dirname(sessionStatePath(undefined, baseEnv)), stateDir);
}

// --- transcript fallback ------------------------------------------------------

{
	const transcript = join(home, "transcript.jsonl");
	writeFileSync(
		transcript,
		[
			JSON.stringify({ type: "user", message: { role: "user", content: V3_WRITE } }),
			JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "ok" }] } }),
			// Tool results are user-role messages too and must NOT be read as prompts.
			JSON.stringify({
				type: "user",
				message: { content: [{ type: "tool_result", content: "MODE: write" }] },
			}),
		].join("\n"),
		"utf8",
	);
	assert.equal(lastUserPrompt(transcript), V3_WRITE);
	assert.equal(lastUserPrompt(join(home, "missing.jsonl")), null);

	// No state file for this session at all: the transcript carries the brief.
	const allowed = await handleEvent(
		"pre-tool-use",
		{ session_id: "s3-never-prompted", tool_name: "Write", transcript_path: transcript },
		peerEnv,
	);
	assert.equal(allowed, null, "transcript is an independent source for the same brief");
}

// --- role prompt injection ----------------------------------------------------

{
	const env = { ...peerEnv };
	const started = await handleEvent("session-start", { session_id: "s4" }, env);
	assert.match(started.hookSpecificOutput.additionalContext, /Paseo Team Role/);
	assert.equal(started.hookSpecificOutput.hookEventName, "SessionStart");

	// Already injected at session start → the next prompt carries only the
	// per-turn authority block, not the whole role prompt again.
	const prompted = await handleEvent(
		"user-prompt-submit",
		{ session_id: "s4", prompt: V3_WRITE },
		env,
	);
	const context = prompted.hookSpecificOutput.additionalContext;
	assert.doesNotMatch(context, /Paseo Team Role/);
	assert.match(context, /Paseo Team Authority/);
	assert.match(context, /peerMode=write/);

	// A session that never saw SessionStart still gets the role prompt once.
	const cold = await handleEvent(
		"user-prompt-submit",
		{ session_id: "s5-cold", prompt: V3_WRITE },
		env,
	);
	assert.match(cold.hookSpecificOutput.additionalContext, /Paseo Team Role/);
}

// A malformed brief is reported to the agent instead of silently downgrading.
{
	const env = { ...peerEnv };
	const malformed = await handleEvent(
		"user-prompt-submit",
		{
			session_id: "s6",
			prompt: [
				"PASEO_TEAM_TASK_V3_BEGIN",
				"TASK_ID: T-9",
				"MODE: write",
				"MODE: write",
				"PASEO_TEAM_TASK_V3_END",
			].join("\n"),
		},
		env,
	);
	assert.match(malformed.hookSpecificOutput.additionalContext, /malformed/);
	const denied = await handleEvent(
		"pre-tool-use",
		{ session_id: "s6", tool_name: "Write" },
		env,
	);
	assert.match(denied.hookSpecificOutput.permissionDecisionReason, /read-only/);
}

// --- lead and supervisor through the same hook --------------------------------

{
	const leadEnv = { ...baseEnv, PASEO_PI_ROLE: "lead" };
	const denied = runHook(
		"pre-tool-use",
		{
			session_id: "lead-1",
			tool_name: "mcp__paseo__create_workspace",
			tool_input: { isolation: "local", title: "review:T-2" },
		},
		leadEnv,
	);
	assert.match(denied.hookSpecificOutput.permissionDecisionReason, /worktree/);
	assert.equal(
		runHook(
			"pre-tool-use",
			{ session_id: "lead-1", tool_name: "mcp__paseo__list_agents", tool_input: {} },
			leadEnv,
		),
		null,
	);

	const supEnv = { ...baseEnv, PASEO_PI_ROLE: "supervisor" };
	const supDenied = runHook(
		"pre-tool-use",
		{ session_id: "sup-1", tool_name: "Bash", tool_input: { command: "ls" } },
		supEnv,
	);
	assert.match(supDenied.hookSpecificOutput.permissionDecisionReason, /supervisor role policy/);
}

// --- fail-closed when the policy modules cannot be loaded ---------------------

{
	const broken = mkdtempSync(join(tmpdir(), "paseo-claude-broken-"));
	const stdout = execFileSync(process.execPath, [hookPath, "pre-tool-use"], {
		encoding: "utf8",
		input: JSON.stringify({ session_id: "s7", tool_name: "Write" }),
		env: {
			...process.env,
			...peerEnv,
			// Points at a directory with no policy modules in it.
			PASEO_TEAM_POLICY_DIR: broken,
		},
		stdio: ["pipe", "pipe", "pipe"],
	});
	const parsed = JSON.parse(stdout);
	assert.equal(parsed.hookSpecificOutput.permissionDecision, "deny");
	assert.match(parsed.hookSpecificOutput.permissionDecisionReason, /fail-closed/);
	rmSync(broken, { recursive: true, force: true });
}

// --- state writes are whole-file, never torn ----------------------------------

{
	const env = { ...peerEnv };
	const path = writeSessionState("s8", { sessionId: "s8", role: "peer", updatedAt: new Date().toISOString(), brief: null }, env);
	const text = readFileSync(path, "utf8");
	assert.equal(JSON.parse(text).sessionId, "s8");
	assert.ok(text.endsWith("\n"));
	const dir = join(home, "claude-sessions");
	mkdirSync(dir, { recursive: true });
	assert.ok(!readFileSync(path, "utf8").includes(".tmp-"));
}

rmSync(home, { recursive: true, force: true });
console.log("claude hook tests passed");

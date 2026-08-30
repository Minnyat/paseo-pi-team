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
	clearSessionState,
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

/**
 * The hook resolves its whole policy from the environment, so the child must
 * see EXACTLY the variables a case declares — never the ones the developer
 * happens to be running under.
 *
 * This matters more here than in most suites: the audience for this pack works
 * inside Paseo agents, and every one of them carries PASEO_PI_ROLE. Inheriting
 * it turned the "passive without a role" case below into a false failure for
 * anyone running the suite from an agent session, which is exactly who runs it.
 */
function childEnv(env) {
	const inherited = { ...process.env };
	for (const key of Object.keys(inherited)) {
		if (key.startsWith("PASEO_")) delete inherited[key];
	}
	return { ...inherited, ...env };
}

function runHook(event, payload, env = peerEnv) {
	const stdout = execFileSync(process.execPath, [hookPath, event], {
		encoding: "utf8",
		input: JSON.stringify(payload),
		env: childEnv(env),
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

// The scrub is the thing under test here: an ambient role must not survive into
// the child, while the case's own variables must.
{
	const ambient = "PASEO_PI_ROLE";
	const previous = process.env[ambient];
	process.env[ambient] = "lead";
	try {
		const built = childEnv(baseEnv);
		assert.equal(built[ambient], undefined, "an ambient role never reaches the hook");
		assert.equal(built.PASEO_TEAM_HOME, home, "the case's own variables do reach it");
		assert.ok(built.PATH !== undefined || process.platform === "win32", "unrelated environment is preserved");
		assert.equal(
			runHook("pre-tool-use", { session_id: "s0b", tool_name: "Write" }, baseEnv),
			null,
			"and the passive case stays passive even when the suite runs inside a Paseo agent",
		);
	} finally {
		if (previous === undefined) delete process.env[ambient];
		else process.env[ambient] = previous;
	}
}

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

// --- a failed state write must not leave the previous turn's authority --------
{
	const env = { ...peerEnv };
	await handleEvent("user-prompt-submit", { session_id: "s9", prompt: V3_WRITE }, env);
	assert.ok(readSessionState("s9", env)?.brief, "write brief recorded");

	// Simulate the write failing on the next turn: the hook clears the state
	// rather than letting turn 1's authority stand in for turn 2.
	assert.equal(clearSessionState("s9", env), true);
	assert.equal(readSessionState("s9", env), null);
	const denied = await handleEvent(
		"pre-tool-use",
		{ session_id: "s9", tool_name: "Write" },
		env,
	);
	assert.match(denied.hookSpecificOutput.permissionDecisionReason, /read-only/);
	// Clearing a session that was never written is a no-op, not an error.
	assert.equal(clearSessionState("never-existed", env), true);
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
// --- scope lease: the hook has to fetch the ledger, not just forward a deny --
// A decision function that is never handed a ledger denies every writer. That
// fails closed, so no test of the DECISION would notice — only a test of the
// HOOK does.
{
	const LEAD = "aaaaaaaa-1111-4111-8111-111111111111";
	const leadEnv = { ...baseEnv, PASEO_PI_ROLE: "lead", PASEO_AGENT_ID: LEAD };
	const writerBrief = [
		"PASEO_TEAM_TASK_V3_BEGIN",
		"TASK_ID: T-1",
		"DISPOSITION: engineer",
		"MODE: write",
		"OWNED_SCOPE: src/auth",
		"EDIT_AUTHORITY: allowed",
		"PASEO_TEAM_TASK_V3_END",
	].join("\n");
	const createWriter = {
		session_id: "lease-1",
		tool_name: "mcp__paseo__create_agent",
		tool_input: { initialPrompt: writerBrief },
	};

	// No daemon here, so the ledger read fails — and the hook must turn that into
	// LEASE_UNVERIFIABLE rather than into silence.
	const blocked = await handleEvent("pre-tool-use", createWriter, leadEnv);
	assert.match(
		String(blocked?.hookSpecificOutput?.permissionDecisionReason),
		/LEASE_UNVERIFIABLE|SCOPE_LEASE/,
		"a Lead staffing a writer is lease-checked on the Claude runtime",
	);

	// A read-only Peer is not gated, so it must pass even with no ledger at all —
	// this is what proves the gate is scoped to writers rather than to every call.
	assert.equal(
		await handleEvent(
			"pre-tool-use",
			{ ...createWriter, tool_input: { initialPrompt: writerBrief.replace("MODE: write", "MODE: read-only") } },
			leadEnv,
		),
		null,
		"read-only creation is never lease-gated",
	);

	// And an ordinary call is untouched: no ledger read, no denial.
	assert.equal(
		await handleEvent("pre-tool-use", { session_id: "lease-2", tool_name: "Read", tool_input: { file_path: "a" } }, leadEnv),
		null,
	);
}

// --- PR-D governance: the hook has to RESOLVE ownership, not just forward it -
// claude-policy.test.mjs pins the decision when the ownership is handed in.
// Nothing there would notice a hook that never looks the target up — the guard
// would simply deny every prompt, or (worse, if the field were optional in the
// wrong direction) allow every one. Only a test of the HOOK sees the leg.
{
	const LEAD_A = "aaaaaaaa-3333-4333-8333-333333333333";
	const LEAD_B = "bbbbbbbb-4444-4444-8444-444444444444";
	const PEER_OF_B = "cccccccc-5555-4555-8555-555555555555";
	const SUP_A = "dddddddd-6666-4666-8666-666666666666";

	const govHome = mkdtempSync(join(tmpdir(), "paseo-claude-gov-"));
	const paseoHome = mkdtempSync(join(tmpdir(), "paseo-claude-gov-home-"));
	const agentsDir = join(paseoHome, "agents", "D--repo");
	mkdirSync(agentsDir, { recursive: true });
	const writeState = (id, provider, labels) =>
		writeFileSync(join(agentsDir, `${id}.json`), JSON.stringify({ id, provider, labels }), "utf8");
	writeState(PEER_OF_B, "claude-peer/claude-opus-5", { "paseo.parent-agent-id": LEAD_B });
	writeState(LEAD_B, "claude-lead/claude-opus-5", { "team.domain": "frontend" });
	writeState(SUP_A, "claude-supervisor/claude-opus-5", { "team.domain": "backend" });

	const leadEnv = {
		PASEO_TEAM_HOME: govHome,
		PASEO_PI_ROLE: "lead",
		PASEO_AGENT_ID: LEAD_A,
		PASEO_HOME: paseoHome,
		PASEO_TEAM_TOPOLOGY: "multi",
		PASEO_TEAM_DOMAIN: "backend.auth",
	};
	const prompt = (agentId, env = leadEnv) =>
		handleEvent(
			"pre-tool-use",
			{
				session_id: "gov-1",
				tool_name: "mcp__paseo__send_agent_prompt",
				tool_input: { agentId, prompt: "status?" },
			},
			env,
		);

	try {
		const foreign = await prompt(PEER_OF_B);
		assert.match(
			String(foreign?.hookSpecificOutput?.permissionDecisionReason),
			/PROMPT_TARGET_NOT_OWNED/,
			"the hook resolves the target off Paseo's own state files",
		);
		assert.equal(await prompt(LEAD_B), null, "another Lead stays reachable");
		assert.equal(await prompt(SUP_A), null, "a Supervisor stays reachable");
		assert.match(
			String((await prompt("eeeeeeee-7777-4777-8777-777777777777"))?.hookSpecificOutput?.permissionDecisionReason),
			/PROMPT_TARGET_UNKNOWN/,
		);
		assert.equal(
			await prompt(PEER_OF_B, { ...leadEnv, PASEO_TEAM_TOPOLOGY: "single" }),
			null,
			"single topology leaves a Lead's previous behaviour untouched",
		);

		// The Supervisor→Peer boundary is the Supervisor's own role rule, not a
		// jurisdiction rule, so the flag does not gate it. Same expectation as
		// the Pi adapter's — a difference here is an authority asymmetry.
		const supEnv = {
			...leadEnv,
			PASEO_PI_ROLE: "supervisor",
			PASEO_AGENT_ID: SUP_A,
			PASEO_TEAM_TOPOLOGY: "single",
		};
		assert.match(
			String((await prompt(PEER_OF_B, supEnv))?.hookSpecificOutput?.permissionDecisionReason),
			/PROMPT_TARGET_IS_PEER/,
			"a Supervisor may not task a Peer, on any topology",
		);
		assert.equal(await prompt(LEAD_B, supEnv), null, "its Lead stays reachable");
		assert.equal(
			await prompt("eeeeeeee-7777-4777-8777-777777777777", supEnv),
			null,
			"and under single an unresolvable target stays allowed (fail-open)",
		);

		// The jurisdiction verdict has to reach the Lead's turn, the same way the
		// Pi extension puts it in the system prompt.
		const decision = [
			"SUPERVISOR_OBSERVATION",
			"",
			"PROJECT_ID: shop",
			"DOMAIN: frontend",
			`FROM_AGENT_ID: ${SUP_A}`,
			"SUPERVISOR_DECISION:",
			"  DECISION: retry the failed step",
			"  REVERSIBILITY: reversible",
		].join("\n");
		const submitted = await handleEvent(
			"user-prompt-submit",
			{ session_id: "gov-2", prompt: decision },
			leadEnv,
		);
		assert.match(
			String(submitted?.hookSpecificOutput?.additionalContext),
			/JURISDICTION_MISMATCH/,
			"an out-of-jurisdiction decision is flagged to the Lead",
		);
		const inJurisdiction = await handleEvent(
			"user-prompt-submit",
			{ session_id: "gov-3", prompt: decision.replace("DOMAIN: frontend", "DOMAIN: backend") },
			leadEnv,
		);
		assert.match(String(inJurisdiction?.hookSpecificOutput?.additionalContext), /JURISDICTION_OK/);
		const plain = await handleEvent(
			"user-prompt-submit",
			{ session_id: "gov-4", prompt: "please review PR 12" },
			{ ...leadEnv, PASEO_TEAM_TOPOLOGY: "multi" },
		);
		assert.ok(
			!/supervisor message \(this turn\)/.test(
				String(plain?.hookSpecificOutput?.additionalContext ?? ""),
			),
			"an ordinary prompt gains no supervisor notice",
		);

		// --- the reported failure -------------------------------------------
		// A Lead on the DEFAULT pack (`single`, one Supervisor) used to receive a
		// SUPERVISOR_DECISION with no verdict, no attribution and no directive:
		// bare prose in a user turn. Claude Code's default posture with an
		// unverified instruction that claims delegated authority is to ask the
		// human, so the Lead asked — for a decision its own contract had already
		// delegated to it. The turn context now says so out loud.
		const singleEnv = { ...leadEnv, PASEO_TEAM_TOPOLOGY: "single" };
		const binding = await handleEvent(
			"user-prompt-submit",
			{ session_id: "gov-5", prompt: decision },
			singleEnv,
		);
		const bindingContext = String(binding?.hookSpecificOutput?.additionalContext);
		assert.match(bindingContext, /SUPERVISOR_DECISION_BINDING/);
		assert.match(bindingContext, /ACT ON IT/);
		assert.match(bindingContext, /needs NO Human round-trip/);
		assert.match(bindingContext, /Sender: verified/);
		// And the contract it is being asked to apply travels with it: the role
		// prompt goes in ONCE per session on Claude, so the turn where authority
		// decides the answer re-injects it rather than trusting a copy from turn
		// one to still be in reach.
		assert.match(bindingContext, /Paseo Team Role/);

		// The same directive must not be reachable by anything that can type the
		// header. An unsigned block is weighed on its evidence and never binds.
		const unsigned = await handleEvent(
			"user-prompt-submit",
			{ session_id: "gov-6", prompt: decision.replace(`FROM_AGENT_ID: ${SUP_A}\n`, "") },
			singleEnv,
		);
		const unsignedContext = String(unsigned?.hookSpecificOutput?.additionalContext);
		assert.match(unsignedContext, /SUPERVISOR_SENDER_UNVERIFIED/);
		assert.ok(
			!/ACT ON IT/.test(unsignedContext),
			"an unverified sender never gets the binding directive",
		);

		// An ordinary Lead turn, mid-session: no supervisor block, so no notice
		// and no second copy of the role prompt — but the standing authority line
		// stays, because Claude never rebuilds the system prompt the way the Pi
		// extension does on every turn.
		const ordinary = await handleEvent(
			"user-prompt-submit",
			{ session_id: "gov-5", prompt: "status on T-1?" },
			singleEnv,
		);
		const ordinaryContext = String(ordinary?.hookSpecificOutput?.additionalContext);
		assert.match(ordinaryContext, /Paseo Team Authority \(standing\)/);
		assert.ok(!/supervisor message \(this turn\)/.test(ordinaryContext));
		assert.ok(
			!/Paseo Team Role/.test(ordinaryContext),
			"the full role prompt is not re-sent on every turn",
		);

		// A Peer is untouched by all of this: no standing block, no notice, even
		// if its prompt quotes a supervisor block verbatim.
		const peerTurn = await handleEvent(
			"user-prompt-submit",
			{ session_id: "gov-7", prompt: decision },
			{ ...singleEnv, PASEO_PI_ROLE: "peer" },
		);
		const peerContext = String(peerTurn?.hookSpecificOutput?.additionalContext);
		assert.ok(!/ACT ON IT/.test(peerContext));
		assert.ok(!/Paseo Team Authority \(standing\)/.test(peerContext));
	} finally {
		rmSync(govHome, { recursive: true, force: true });
		rmSync(paseoHome, { recursive: true, force: true });
	}
}

// --- the cluster gate must be reachable THROUGH the adapter ------------------
//
// The core rule is unit-tested in cluster.test.mts, but a core rule is only as
// live as the adapter that feeds it. This case exists because it was NOT: the
// hook resolved a send_agent_prompt target only under `multi`, so on the
// DEFAULT `single` pack the core was handed a null target and
// sendAgentPromptBlockReason cannot refuse a target it cannot see. Every
// core-level test still passed, because each supplied the target by hand.
{
	const clusterHome = mkdtempSync(join(tmpdir(), "paseo-cluster-hook-"));
	const paseoHome = mkdtempSync(join(tmpdir(), "paseo-cluster-state-"));
	try {
		const SELF_LEAD = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
		const FOREIGN_LEAD = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
		const HOME_LEAD = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
		const dir = join(paseoHome, "agents", "slug");
		mkdirSync(dir, { recursive: true });
		writeFileSync(join(dir, `${SELF_LEAD}.json`), JSON.stringify({
			id: SELF_LEAD, provider: "claude-lead/claude-opus-5", cwd: "D:/Code/shop",
		}));
		writeFileSync(join(dir, `${FOREIGN_LEAD}.json`), JSON.stringify({
			id: FOREIGN_LEAD, provider: "claude-lead/claude-opus-5", cwd: "D:/Code/blog",
		}));
		writeFileSync(join(dir, `${HOME_LEAD}.json`), JSON.stringify({
			id: HOME_LEAD, provider: "claude-lead/claude-opus-5", cwd: "D:/Code/shop",
		}));

		const leadEnv = {
			PASEO_TEAM_HOME: clusterHome,
			PASEO_PI_ROLE: "lead",
			PASEO_HOME: paseoHome,
			PASEO_AGENT_ID: SELF_LEAD,
		};
		const prompt = (agentId) => ({
			session_id: "cluster-1",
			tool_name: "mcp__paseo__send_agent_prompt",
			tool_input: { agentId, prompt: "status?" },
		});

		// The topology flag must not gate this: `single` is the pack most likely
		// to have two projects sharing one host.
		for (const topology of [undefined, "multi"]) {
			const env = topology ? { ...leadEnv, PASEO_TEAM_TOPOLOGY: topology } : leadEnv;
			const denied = await handleEvent("pre-tool-use", prompt(FOREIGN_LEAD), env);
			assert.match(
				String(denied?.hookSpecificOutput?.permissionDecisionReason),
				/PROMPT_TARGET_OUT_OF_CLUSTER/,
				`a Lead must not prompt another workspace's Lead (topology=${topology ?? "single"})`,
			);
			assert.equal(
				denied?.hookSpecificOutput?.permissionDecision,
				"deny",
				"the verdict has to be an actual deny, not just a message",
			);
		}

		// ...and coordinator traffic inside the cluster is untouched.
		assert.equal(
			await handleEvent("pre-tool-use", prompt(HOME_LEAD), leadEnv),
			null,
			"a Lead in the same cluster is still reachable",
		);
	} finally {
		rmSync(clusterHome, { recursive: true, force: true });
		rmSync(paseoHome, { recursive: true, force: true });
	}
}

console.log("claude hook tests passed");

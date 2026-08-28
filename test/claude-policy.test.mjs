// claude-policy.test.mjs — the Claude dialect of the role policy.
//
// The invariants are the same ones policy.test.mts pins for Pi; what is tested
// here is that they survive the TRANSLATION: different tool names, a different
// MCP shape (mcp__paseo__<tool> with args as the tool input), and a static
// disallowedTools layer that must not overlap with the per-turn decisions.

import assert from "node:assert/strict";
import {
	claudeBaseTools,
	claudeDisallowedTools,
	claudeToolBlockReason,
	classifyClaudeTool,
	describeClaudePolicy,
	teamToolName,
	CLAUDE_PASEO_TOOL_NAMES,
} from "../extensions/paseo-team-core/claude-policy.ts";
import { parseTaskBrief } from "../extensions/paseo-team-core/policy-core.ts";

const brief = (lines) => parseTaskBrief(lines.join("\n"));

const writeBrief = brief([
	"PASEO_TEAM_TASK_V3_BEGIN",
	"TASK_ID: T-100",
	"MODE: write",
	"EDIT_AUTHORITY: allowed",
	"COMMIT_AUTHORITY: allowed",
	"PUSH_TASK_BRANCH_AUTHORITY: allowed",
	"PASEO_TEAM_TASK_V3_END",
	"",
	"Body text.",
]);
const readOnlyBrief = brief([
	"PASEO_TEAM_TASK_V3_BEGIN",
	"TASK_ID: T-101",
	"MODE: read-only",
	"PASEO_TEAM_TASK_V3_END",
]);
const browserBrief = brief([
	"PASEO_TEAM_TASK_V3_BEGIN",
	"TASK_ID: T-102",
	"MODE: read-only",
	"BROWSER_MCP_AUTHORITY: allowed",
	"PASEO_TEAM_TASK_V3_END",
]);
// MODE says write, EDIT_AUTHORITY says no: the narrower one wins.
const authorityMismatchBrief = brief([
	"PASEO_TEAM_TASK_V3_BEGIN",
	"TASK_ID: T-103",
	"MODE: write",
	"EDIT_AUTHORITY: denied",
	"PASEO_TEAM_TASK_V3_END",
]);

const decide = (role, toolName, toolInput, taskBrief = null) =>
	claudeToolBlockReason({ role, toolName, toolInput, brief: taskBrief });

// --- classification -----------------------------------------------------------

assert.deepEqual(classifyClaudeTool("Read"), { kind: "read" });
assert.deepEqual(classifyClaudeTool("Write"), { kind: "write" });
assert.deepEqual(classifyClaudeTool("NotebookEdit"), { kind: "edit" });
assert.deepEqual(classifyClaudeTool("Bash"), { kind: "bash" });
assert.deepEqual(classifyClaudeTool("Task"), { kind: "subagent" });
assert.deepEqual(classifyClaudeTool("mcp__paseo__create_agent"), {
	kind: "paseo-mcp",
	target: "create_agent",
});
assert.deepEqual(classifyClaudeTool("mcp__paseo-team__peer_ask_lead"), {
	kind: "team",
	target: "peer_ask_lead",
});
assert.equal(classifyClaudeTool("mcp__agent-browser__open").kind, "browser-mcp");
assert.equal(classifyClaudeTool("mcp__something-else__do").kind, "other-mcp");
// An unknown bare tool is "other" — and "other" is denied unless allowlisted.
assert.deepEqual(classifyClaudeTool("SomeFutureTool"), { kind: "other" });
assert.equal(teamToolName("mcp__paseo-team__team_watchdog"), "team_watchdog");
assert.equal(teamToolName("Read"), "Read");
assert.ok(CLAUDE_PASEO_TOOL_NAMES.includes("mcp__paseo__create_agent"));

// --- peer: write authority is per-turn ----------------------------------------

assert.equal(decide("peer", "Write", { file_path: "a" }, writeBrief), null);
assert.equal(decide("peer", "Edit", {}, writeBrief), null);
assert.match(
	decide("peer", "Write", {}, readOnlyBrief) ?? "",
	/read-only/,
	"read-only brief blocks writes",
);
assert.match(
	decide("peer", "Write", {}, null) ?? "",
	/read-only/,
	"no brief at all is read-only, never write",
);
assert.match(
	decide("peer", "Write", {}, authorityMismatchBrief) ?? "",
	/AUTHORITY_MISMATCH/,
	"MODE: write without EDIT_AUTHORITY still blocks",
);
// A legacy V1/V2 brief can never grant write on Claude either.
assert.match(
	decide(
		"peer",
		"Write",
		{},
		brief(["PASEO_TEAM_TASK_V2", "TASK_ID: T-9", "MODE: write", "EDIT_AUTHORITY: allowed"]),
	) ?? "",
	/read-only/,
);

// --- peer: bash guards --------------------------------------------------------

assert.equal(decide("peer", "Bash", { command: "npm test" }, writeBrief), null);
assert.match(
	decide("peer", "Bash", { command: "paseo run --provider claude-peer 'x'" }, writeBrief) ?? "",
	/Paseo CLI/,
);
assert.match(
	decide("peer", "Bash", { command: "agent-browser open https://x" }, browserBrief) ?? "",
	/agent-browser CLI/,
);
assert.equal(
	decide("peer", "Bash", { command: "git push -u origin HEAD:refs/heads/agent/T-100" }, writeBrief),
	null,
	"exact branch-scoped push is the one allowed form",
);
assert.match(
	decide("peer", "Bash", { command: "git push -u origin HEAD:refs/heads/main" }, writeBrief) ?? "",
	/branch-scoped/,
);
assert.match(
	decide("peer", "Bash", { command: "git push --force origin HEAD:refs/heads/agent/T-100" }, writeBrief) ?? "",
	/FORCE_PUSH_AUTHORITY/,
);
assert.match(
	decide("peer", "Bash", { command: "git commit -m x" }, readOnlyBrief) ?? "",
	/COMMIT_AUTHORITY/,
);
// A non-string command must not slip past the guard as an empty string.
assert.equal(decide("peer", "Bash", { command: 42 }, writeBrief), null);

// --- peer: MCP surface --------------------------------------------------------

assert.match(
	decide("peer", "mcp__paseo__create_agent", {}, writeBrief) ?? "",
	/DEPENDENCY_REQUEST/,
	"peers never orchestrate, whatever the brief says",
);
assert.match(
	decide("peer", "mcp__paseo__list_agents", {}, writeBrief) ?? "",
	/DEPENDENCY_REQUEST/,
);
assert.match(
	decide("peer", "mcp__agent-browser__open", {}, writeBrief) ?? "",
	/BROWSER_MCP_AUTHORITY/,
);
assert.equal(decide("peer", "mcp__agent-browser__open", {}, browserBrief), null);
assert.match(
	decide("peer", "mcp__unrelated__do", {}, browserBrief) ?? "",
	/outside the peer role surface/,
);
assert.match(
	decide("peer", "Task", { prompt: "x" }, writeBrief) ?? "",
	/subagents are denied/,
	"a peer must not fan out outside Paseo",
);
assert.match(decide("peer", "SomeFutureTool", {}, writeBrief) ?? "", /blocked by the peer role/);
// Schema lookup for deferred tools is allowed for every role: it reveals no
// capability on its own, and every resulting call still passes this policy.
// (Denying it was found in live verification to strand a Lead that was
// reaching for Paseo tools it WAS allowed to call.)
for (const role of ["supervisor", "lead", "peer"]) {
	assert.equal(decide(role, "ToolSearch", { query: "select:Read" }, writeBrief), null);
	assert.ok(!claudeDisallowedTools(role).includes("ToolSearch"));
}

// --- peer: team tools ---------------------------------------------------------

assert.equal(decide("peer", "mcp__paseo-team__peer_ask_lead", {}, writeBrief), null);
assert.match(
	decide("peer", "mcp__paseo-team__peer_ask_lead", {}, null) ?? "",
	/valid current V3 task brief/,
	"asking the Lead requires a real brief to attribute the message to",
);
assert.match(
	decide("peer", "mcp__paseo-team__team_watchdog", {}, writeBrief) ?? "",
	/Lead and Supervisor/,
);

// --- supervisor ---------------------------------------------------------------

assert.equal(decide("supervisor", "Read", {}), null);
assert.equal(decide("supervisor", "mcp__paseo__list_agents", {}), null);
assert.equal(decide("supervisor", "mcp__paseo__send_agent_prompt", {}), null);
assert.match(decide("supervisor", "Write", {}) ?? "", /cannot modify product code/);
assert.match(decide("supervisor", "Bash", { command: "ls" }) ?? "", /blocked by the supervisor role/);
assert.match(decide("supervisor", "mcp__paseo__create_workspace", {}) ?? "", /monitoring tools/);
assert.match(decide("supervisor", "mcp__agent-browser__open", {}) ?? "", /no browser authority/);
// create_agent is the one gated orchestration action, and the ARGS are the gate.
// On Claude the arguments ARE the tool input, so a missing input is the
// unclassifiable case that must fail closed.
assert.match(
	decide("supervisor", "mcp__paseo__create_agent", undefined) ?? "",
	/args object/,
);
assert.match(decide("supervisor", "mcp__paseo__create_agent", {}) ?? "", /lead-recovery only/);
assert.match(
	decide("supervisor", "mcp__paseo__create_agent", {
		provider: "claude-peer/claude-opus-5",
		labels: { purpose: "recovery", recovery_for: "p" },
		settings: { thinkingOptionId: "high" },
	}) ?? "",
	/lead-recovery only/,
	"a peer provider is not a lead recovery",
);
assert.match(
	decide("supervisor", "mcp__paseo__create_agent", {
		provider: "claude-lead",
		labels: { purpose: "recovery", recovery_for: "p" },
		settings: { thinkingOptionId: "high" },
	}) ?? "",
	/lead-recovery only/,
	"a lead provider without a model would take a daemon default",
);
assert.equal(
	decide("supervisor", "mcp__paseo__create_agent", {
		provider: "claude-lead/claude-opus-5",
		labels: { purpose: "recovery", recovery_for: "content-analysis" },
		settings: { thinkingOptionId: "high" },
	}),
	null,
	"a Claude lead recovery passes the same gate as a pi one",
);
assert.equal(
	decide("supervisor", "mcp__paseo__create_agent", {
		provider: "pi-lead/Minnyat/gpt-5.6-sol",
		labels: { purpose: "bootstrap", recovery_for: "pod" },
		settings: { thinkingOptionId: "high" },
	}),
	null,
);
assert.match(
	decide("supervisor", "mcp__paseo__create_agent", {
		provider: "claude-lead/claude-opus-5",
		labels: { purpose: "recovery", recovery_for: "p" },
	}) ?? "",
	/thinkingOptionId/,
	"no daemon-default model",
);

// --- lead ---------------------------------------------------------------------

assert.equal(decide("lead", "mcp__paseo__create_agent", { provider: "x" }), null);
assert.equal(decide("lead", "mcp__paseo__respond_to_permission", {}), null);
assert.equal(decide("lead", "Bash", { command: "git status" }), null);
assert.equal(decide("lead", "mcp__agent-browser__open", {}), null);
assert.match(decide("lead", "Write", {}) ?? "", /blocked by the lead role/);
assert.match(decide("lead", "mcp__paseo__create_terminal", {}) ?? "", /not in the lead MCP allowlist/);
// Reviewer isolation, layer 1: a review workspace must be a worktree.
assert.match(
	decide("lead", "mcp__paseo__create_workspace", { isolation: "local", title: "review:T-1" }) ?? "",
	/must use isolation "worktree"/,
);
assert.equal(
	decide("lead", "mcp__paseo__create_workspace", { isolation: "worktree", title: "review:T-1" }),
	null,
);
assert.match(
	decide("lead", "mcp__paseo__create_workspace", { title: "anything" }) ?? "",
	/explicit isolation/,
	"never rely on a daemon default",
);

// --- env-driven surfaces ------------------------------------------------------

{
	const previous = process.env.PASEO_TEAM_LEAD_WRITE;
	process.env.PASEO_TEAM_LEAD_WRITE = "1";
	assert.equal(decide("lead", "Write", {}), null, "documented opt-in grants lead write");
	assert.ok(!claudeDisallowedTools("lead").includes("Write"));
	if (previous === undefined) delete process.env.PASEO_TEAM_LEAD_WRITE;
	else process.env.PASEO_TEAM_LEAD_WRITE = previous;
}
{
	const previous = process.env.PASEO_TEAM_EXTRA_TOOLS;
	process.env.PASEO_TEAM_EXTRA_TOOLS = "WebFetch,mcp__unrelated__do";
	assert.equal(decide("peer", "WebFetch", {}, writeBrief), null);
	assert.equal(decide("peer", "mcp__unrelated__do", {}, writeBrief), null);
	assert.ok(!claudeDisallowedTools("peer").includes("WebFetch"));
	if (previous === undefined) delete process.env.PASEO_TEAM_EXTRA_TOOLS;
	else process.env.PASEO_TEAM_EXTRA_TOOLS = previous;
}

// --- static layer: provider disallowedTools -----------------------------------
//
// The static list must remove what the role can NEVER use, and must NOT remove
// what the per-turn decision needs to be able to grant (peer write/edit).
for (const role of ["supervisor", "lead", "peer"]) {
	const denied = new Set(claudeDisallowedTools(role));
	const allowed = new Set(claudeBaseTools(role));
	for (const tool of allowed) {
		assert.ok(!denied.has(tool), `${role}: ${tool} is both allowed and disallowed`);
	}
	assert.ok(denied.has("Task"), `${role}: Claude subagents must be stripped statically`);
}
assert.ok(claudeDisallowedTools("supervisor").includes("Bash"));
assert.ok(claudeDisallowedTools("supervisor").includes("Write"));
assert.ok(!claudeDisallowedTools("peer").includes("Write"), "a write peer needs the tool present");
assert.ok(!claudeDisallowedTools("peer").includes("Bash"));

// --- diagnostics --------------------------------------------------------------

const described = describeClaudePolicy("peer", writeBrief);
assert.match(described, /role=peer/);
assert.match(described, /peerMode=write/);
assert.match(described, /edit=true/);
assert.match(describeClaudePolicy("peer", null), /brief=none/);
assert.match(describeClaudePolicy("lead", null), /paseoMcp=\[/);

// --- chat CLI guard: runtime parity ------------------------------------------
// The coordination channel is a typed tool on BOTH runtimes. If the redirect
// lived only in the Pi adapter, picking a `claude-lead` provider would be a
// one-line bypass of the envelope, the room allowlist and the size ceiling —
// which is exactly the failure mode policy-core exists to prevent.
{
	const bash = (role, command) =>
		claudeToolBlockReason({ role, toolName: "Bash", toolInput: { command }, brief: null });

	assert.match(String(bash("lead", "paseo chat ls")), /team_chat/);
	assert.match(String(bash("lead", "paseo chat post coord hi")), /team_chat/);
	assert.match(String(bash("lead", "paseo.cmd chat read coord")), /team_chat/);
	assert.match(String(bash("lead", "echo hi && paseo chat post r x")), /team_chat/);

	// Narrow on purpose: this is a chat redirect, not a new CLI ban.
	assert.equal(bash("lead", "paseo ls -g"), null);
	assert.equal(bash("lead", "node scripts/remote-paseo.mjs health --host-id mac"), null);
	assert.equal(bash("lead", "git status"), null);

	// A Peer never had chat and still does not — via the blanket Paseo CLI block.
	assert.match(String(bash("peer", "paseo chat ls")), /Paseo CLI from bash/);

	// And the tool itself is Lead/Supervisor only on this runtime too.
	assert.equal(
		claudeToolBlockReason({ role: "peer", toolName: "mcp__paseo-team__team_chat", toolInput: {}, brief: null }),
		"team_chat is restricted to Lead and Supervisor agents.",
	);
	assert.equal(
		claudeToolBlockReason({ role: "lead", toolName: "mcp__paseo-team__team_chat", toolInput: {}, brief: null }),
		null,
	);
}

// --- OCR-001 parity: the support-script side door is shut on Claude too ----
{
	const bash = (role, command) =>
		claudeToolBlockReason({ role, toolName: "Bash", toolInput: { command }, brief: null });

	assert.match(String(bash("peer", "node /x/paseo-team-scripts/team-chat.mjs post {}")), /support script/i);
	assert.match(String(bash("peer", "node /x/paseo-team-scripts/remote-paseo.mjs run")), /support script/i);
	// The Reviewer Peer runs this one by design.
	assert.equal(bash("peer", "node /x/paseo-team-scripts/ocr-review.mjs --repo r"), null);
	assert.equal(bash("peer", "node /x/paseo-team-scripts/team-communication.mjs ask-lead {}"), null);
}

// --- scope lease: the same rule reaches the Claude runtime -------------------
// The rule itself is pinned in scope-lease.test.mts. What is pinned HERE is that
// the Claude adapter actually consults it — the leg that, for the chat guard,
// was missing on this runtime and would have made `claude-lead` a one-provider
// bypass.
{
	const { resolveLeases } = await import("../extensions/paseo-team-core/policy-core.ts");
	const LEAD_A = "aaaaaaaa-1111-4111-8111-111111111111";
	const LEAD_B = "bbbbbbbb-2222-4222-8222-222222222222";
	const now = 10_000_000;
	const claim = (author, scope) => ({
		author,
		createdAt: new Date(now - 1000).toISOString(),
		body: `LEASE_V1\nACTION: claim\nSCOPE: ${scope}\nTTL_MS: 3600000`,
	});
	const writerBrief = [
		"PASEO_TEAM_TASK_V3_BEGIN",
		"TASK_ID: T-1",
		"DISPOSITION: engineer",
		"MODE: write",
		"OWNED_SCOPE: src/auth",
		"EDIT_AUTHORITY: allowed",
		"PASEO_TEAM_TASK_V3_END",
	].join("\n");
	const createAgent = (leases, selfAgentId, prompt = writerBrief) =>
		claudeToolBlockReason({
			role: "lead",
			toolName: "mcp__paseo__create_agent",
			toolInput: { initialPrompt: prompt },
			brief: null,
			leases,
			selfAgentId,
		});

	assert.equal(
		createAgent(resolveLeases([claim(LEAD_A, "src/auth")], { now }), LEAD_A),
		null,
		"the holder may staff its own scope",
	);
	assert.match(
		String(createAgent(resolveLeases([claim(LEAD_B, "src/auth")], { now }), LEAD_A)),
		/SCOPE_LEASE_HELD/,
		"another Lead's scope is refused on this runtime too",
	);
	assert.match(
		String(createAgent(resolveLeases([], { now }), LEAD_A)),
		/SCOPE_LEASE_MISSING/,
		"and staffing an unclaimed scope is refused",
	);
	// The hook could not read the ledger. Fail closed: a Lead that cannot create
	// a writer is a visible incident, two writers on one scope is a silent one.
	assert.match(String(createAgent(null, LEAD_A)), /LEASE_UNVERIFIABLE/);
	assert.match(String(createAgent(undefined, LEAD_A)), /LEASE_UNVERIFIABLE/, "a caller that forgot to fetch is not a free pass");

	// OCR-002: the brief arms a Peer whether it arrives at creation or in a later
	// turn, so send_agent_prompt is gated exactly like create_agent. Otherwise the
	// two-step — create something benign, then send the write brief — walks past
	// the lease untouched.
	assert.match(
		String(
			claudeToolBlockReason({
				role: "lead",
				toolName: "mcp__paseo__send_agent_prompt",
				toolInput: { agentId: "x", prompt: writerBrief },
				brief: null,
				leases: resolveLeases([claim(LEAD_B, "src/auth")], { now }),
				selfAgentId: LEAD_A,
			}),
			/SCOPE_LEASE_HELD/,
		),
		/SCOPE_LEASE_HELD/,
	);

	// OCR-007: the Supervisor may read the lease board but not move it, on this
	// runtime as well — an authority that exists on one adapter only is the exact
	// asymmetry the shared core exists to prevent.
	const leaseTool = (role, action) =>
		claudeToolBlockReason({
			role,
			toolName: "mcp__paseo-team__team_lease",
			toolInput: { action, scope: "src/auth" },
			brief: null,
		});
	assert.equal(leaseTool("supervisor", "status"), null, "reading the board is governance");
	assert.match(String(leaseTool("supervisor", "claim")), /not claim, renew or release/);
	assert.match(String(leaseTool("supervisor", "release")), /not claim, renew or release/);
	assert.equal(leaseTool("lead", "claim"), null);

	// A read-only peer shares the tree by design and is never gated.
	assert.equal(
		createAgent(resolveLeases([claim(LEAD_B, "src/auth")], { now }), LEAD_A, writerBrief.replace("MODE: write", "MODE: read-only")),
		null,
	);
}

console.log("claude policy tests passed");

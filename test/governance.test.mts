/**
 * governance.test.mts — PR-D: multi-supervisor governance (pure rules).
 *
 * Everything here is fixture-driven: no daemon, no agent, no clock of its own.
 * The rules under test decide who may govern whom, and a rule that can only be
 * checked against a live daemon is a rule nobody checks.
 */

import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
	agentOwnership,
	domainConflicts,
	domainCovers,
	normalizeDomain,
	parseSupervisorBlock,
	sendAgentPromptBlockReason,
	sendAgentPromptTargetId,
	supervisorCreateAgentArgsBlockReason,
	supervisorJurisdictionVerdict,
	teamTopology,
} from "../extensions/paseo-team-core/policy-core.ts";

const SUP_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const SUP_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const LEAD_A = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const PEER_B = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";

// ---------------------------------------------------------------------------
// Topology flag
// ---------------------------------------------------------------------------

test("topology defaults to single and only 'single' turns the multi rules off", () => {
	assert.equal(teamTopology({}), "single");
	assert.equal(teamTopology({ PASEO_TEAM_TOPOLOGY: "" }), "single");
	assert.equal(teamTopology({ PASEO_TEAM_TOPOLOGY: " Single " }), "single");
	assert.equal(teamTopology({ PASEO_TEAM_TOPOLOGY: "multi" }), "multi");
	// A typo must not silently disable governance: the unknown value resolves to
	// the side that only ever DENIES.
	assert.equal(teamTopology({ PASEO_TEAM_TOPOLOGY: "mult" }), "multi");
	assert.equal(teamTopology({ PASEO_TEAM_TOPOLOGY: "many" }), "multi");
});

// ---------------------------------------------------------------------------
// Domain grammar
// ---------------------------------------------------------------------------

test("domains normalize to one spelling", () => {
	assert.equal(normalizeDomain("Backend"), "backend");
	assert.equal(normalizeDomain(" backend/auth "), "backend.auth");
	assert.equal(normalizeDomain("backend..auth"), "backend.auth");
	assert.equal(normalizeDomain("backend.auth."), "backend.auth");
	assert.equal(normalizeDomain("*"), "*");
	assert.equal(normalizeDomain(""), null);
	assert.equal(normalizeDomain("back end"), null);
	assert.equal(normalizeDomain("back$end"), null);
	assert.equal(normalizeDomain(".."), null);
	assert.equal(normalizeDomain(42), null);
	assert.equal(normalizeDomain("a".repeat(200)), null);
});

test("domain containment is segment-wise, and '*' is the root", () => {
	assert.equal(domainCovers("backend", "backend.auth"), true);
	assert.equal(domainCovers("backend", "backend"), true);
	assert.equal(domainCovers("backend.auth", "backend"), false);
	// prefix, not substring: `backend` must not swallow `backendops`
	assert.equal(domainCovers("backend", "backendops"), false);
	assert.equal(domainCovers("*", "anything.at.all"), true);
	assert.equal(domainCovers("backend", "*"), false);
	assert.equal(domainConflicts("backend.auth", "backend"), true);
	assert.equal(domainConflicts("backend", "frontend"), false);
	assert.equal(domainConflicts("*", "frontend"), true);
	assert.equal(domainCovers("backend", null), false);
});

// ---------------------------------------------------------------------------
// SUPERVISOR_OBSERVATION / SUPERVISOR_DECISION parsing
// ---------------------------------------------------------------------------

const observation = (extra = "") =>
	[
		"SUPERVISOR_OBSERVATION",
		"",
		"PROJECT_ID: shop",
		"DOMAIN: backend.auth",
		"TASK_ID: T-1",
		"OBSERVATION: the reviewer shares the engineer's worktree",
		"HUMAN_DECISION_REQUIRED: no",
		extra,
	].join("\n");

test("an observation block parses its declared domain", () => {
	const block = parseSupervisorBlock(observation());
	assert.ok(block);
	assert.equal(block.kind, "observation");
	assert.equal(block.domain, "backend.auth");
	assert.deepEqual(block.malformed, []);
	assert.equal(block.fields.get("PROJECT_ID"), "shop");
});

test("a filled SUPERVISOR_DECISION sub-block makes the message a decision", () => {
	const block = parseSupervisorBlock(
		observation(
			[
				"",
				"SUPERVISOR_DECISION:",
				"  DECISION: retry the failed step",
				"  REVERSIBILITY: reversible",
			].join("\n"),
		),
	);
	assert.ok(block);
	assert.equal(block.kind, "decision");
	assert.equal(block.domain, "backend.auth");
});

test("an empty SUPERVISOR_DECISION heading stays an observation", () => {
	const block = parseSupervisorBlock(observation("\nSUPERVISOR_DECISION:\n"));
	assert.ok(block);
	assert.equal(block.kind, "observation");
});

test("a decision that marks itself irreversible is malformed", () => {
	const block = parseSupervisorBlock(
		observation(
			["", "SUPERVISOR_DECISION:", "  DECISION: push the branch", "  REVERSIBILITY: irreversible"].join("\n"),
		),
	);
	assert.ok(block);
	assert.ok(block.malformed.some((entry) => entry.includes("irreversible")));
});

test("an unparseable or duplicated DOMAIN is malformed, never ignored", () => {
	const bad = parseSupervisorBlock(observation().replace("DOMAIN: backend.auth", "DOMAIN: back end"));
	assert.ok(bad);
	assert.equal(bad.domain, null);
	assert.ok(bad.malformed.some((entry) => entry.includes("DOMAIN")));

	const duplicated = parseSupervisorBlock(
		observation().replace("TASK_ID: T-1", "DOMAIN: frontend\nTASK_ID: T-1"),
	);
	assert.ok(duplicated);
	assert.ok(duplicated.malformed.some((entry) => entry.includes("duplicate")));
});

test("text without a supervisor header is not a supervisor block", () => {
	assert.equal(parseSupervisorBlock("just a normal follow-up prompt"), null);
	assert.equal(parseSupervisorBlock(""), null);
	// The words in prose must not be mistaken for the block header.
	assert.equal(parseSupervisorBlock("please read the SUPERVISOR_OBSERVATION I sent earlier"), null);
});

// ---------------------------------------------------------------------------
// Jurisdiction verdict
// ---------------------------------------------------------------------------

const verdict = (over: Record<string, unknown> = {}) =>
	supervisorJurisdictionVerdict({
		block: parseSupervisorBlock(observation("\nSUPERVISOR_DECISION:\n  DECISION: retry\n  REVERSIBILITY: reversible")),
		leadDomain: "backend.auth",
		supervisors: [{ agentId: SUP_A, domain: "backend" }],
		fromAgentId: SUP_A,
		topology: "multi",
		...over,
	} as never);

test("single topology leaves every governance rule off", () => {
	assert.equal(verdict({ topology: "single" }), null);
});

test("a decision from the governing supervisor is accepted", () => {
	const result = verdict();
	assert.ok(result);
	assert.equal(result.ok, true);
	assert.equal(result.severity, "accept");
});

test("a decision for another domain is refused", () => {
	const result = verdict({ leadDomain: "frontend" });
	assert.ok(result);
	assert.equal(result.ok, false);
	assert.equal(result.severity, "refuse");
	assert.equal(result.code, "JURISDICTION_MISMATCH");
});

test("the same mismatch on a plain observation only warns", () => {
	const result = supervisorJurisdictionVerdict({
		block: parseSupervisorBlock(observation()),
		leadDomain: "frontend",
		supervisors: [{ agentId: SUP_A, domain: "backend" }],
		fromAgentId: SUP_A,
		topology: "multi",
	});
	assert.ok(result);
	assert.equal(result.severity, "warn");
	assert.equal(result.code, "JURISDICTION_MISMATCH");
});

test("a decision with no declared DOMAIN is refused", () => {
	const result = supervisorJurisdictionVerdict({
		block: parseSupervisorBlock(
			observation("\nSUPERVISOR_DECISION:\n  DECISION: retry\n  REVERSIBILITY: reversible").replace(
				"DOMAIN: backend.auth\n",
				"",
			),
		),
		leadDomain: "backend.auth",
		supervisors: [{ agentId: SUP_A, domain: "backend" }],
		fromAgentId: SUP_A,
		topology: "multi",
	});
	assert.ok(result);
	assert.equal(result.code, "JURISDICTION_UNDECLARED");
	assert.equal(result.severity, "refuse");
});

test("a Lead that does not know its own domain cannot verify jurisdiction", () => {
	const result = verdict({ leadDomain: null });
	assert.ok(result);
	assert.equal(result.code, "JURISDICTION_UNVERIFIABLE");
	assert.equal(result.severity, "refuse");
});

test("two supervisors whose jurisdictions both cover this Lead fail closed", () => {
	const result = verdict({
		supervisors: [
			{ agentId: SUP_A, domain: "backend" },
			{ agentId: SUP_B, domain: "backend.auth" },
		],
	});
	assert.ok(result);
	assert.equal(result.code, "JURISDICTION_OVERLAP");
	assert.equal(result.severity, "refuse");
	assert.ok(/human/i.test(result.reason), "an overlap is escalated to the Human");
	assert.ok(result.reason.includes(SUP_B));
});

test("an unattributed block is not an overlap when only one supervisor covers the Lead", () => {
	// FROM_AGENT_ID missing. With one covering Supervisor there is nobody to
	// contend with, whoever wrote it — refusing here would fire on every
	// ordinary single-Supervisor domain and teach the Lead to ignore the alarm.
	const single = verdict({ fromAgentId: null });
	assert.ok(single);
	assert.equal(single.ok, true);

	const ambiguous = verdict({
		fromAgentId: null,
		supervisors: [
			{ agentId: SUP_A, domain: "backend" },
			{ agentId: SUP_B, domain: "backend.auth" },
		],
	});
	assert.ok(ambiguous);
	assert.equal(ambiguous.code, "JURISDICTION_OVERLAP");
	assert.ok(!ambiguous.reason.includes("<unknown>"), "and does not invent a sender to name");
});

test("a second supervisor over a different domain is not an overlap", () => {
	const result = verdict({
		supervisors: [
			{ agentId: SUP_A, domain: "backend" },
			{ agentId: SUP_B, domain: "frontend" },
		],
	});
	assert.ok(result);
	assert.equal(result.ok, true);
});

test("a supervisor with no declared domain cannot create an overlap out of nothing", () => {
	const result = verdict({
		supervisors: [
			{ agentId: SUP_A, domain: "backend" },
			{ agentId: SUP_B, domain: null },
		],
	});
	assert.ok(result);
	assert.equal(result.ok, true);
});

test("a malformed supervisor block is refused before jurisdiction is even read", () => {
	const result = supervisorJurisdictionVerdict({
		block: parseSupervisorBlock(
			observation("\nSUPERVISOR_DECISION:\n  DECISION: push\n  REVERSIBILITY: irreversible"),
		),
		leadDomain: "backend.auth",
		supervisors: [{ agentId: SUP_A, domain: "backend" }],
		fromAgentId: SUP_A,
		topology: "multi",
	});
	assert.ok(result);
	assert.equal(result.code, "SUPERVISOR_BLOCK_MALFORMED");
	assert.equal(result.severity, "refuse");
});

// ---------------------------------------------------------------------------
// recovery_for must stay inside the supervisor's own jurisdiction
// ---------------------------------------------------------------------------

const recoveryArgs = (recoveryFor: string) => ({
	provider: "pi-lead/anthropic/claude-opus-5",
	labels: { purpose: "recovery", recovery_for: recoveryFor },
	settings: { thinkingOptionId: "high" },
});

test("single topology keeps the pre-existing recovery gate exactly as it was", () => {
	assert.equal(supervisorCreateAgentArgsBlockReason(recoveryArgs("shop")), null);
	assert.equal(
		supervisorCreateAgentArgsBlockReason(recoveryArgs("shop"), { topology: "single", selfDomain: "frontend" }),
		null,
	);
});

test("recovery inside the supervisor's own domain is allowed under multi", () => {
	assert.equal(
		supervisorCreateAgentArgsBlockReason(recoveryArgs("backend.auth"), {
			topology: "multi",
			selfDomain: "backend",
		}),
		null,
	);
});

test("recovery outside the supervisor's own domain is blocked", () => {
	const reason = supervisorCreateAgentArgsBlockReason(recoveryArgs("frontend.shell"), {
		topology: "multi",
		selfDomain: "backend",
	});
	assert.ok(reason);
	assert.ok(reason.includes("RECOVERY_OUT_OF_JURISDICTION"), reason);
});

test("a supervisor with no declared domain may not recover anything under multi", () => {
	const reason = supervisorCreateAgentArgsBlockReason(recoveryArgs("backend.auth"), {
		topology: "multi",
		selfDomain: null,
	});
	assert.ok(reason);
	assert.ok(reason.includes("JURISDICTION_UNDECLARED"), reason);
});

test("a recovery_for that is not a domain at all is blocked under multi", () => {
	const reason = supervisorCreateAgentArgsBlockReason(recoveryArgs("shop project #1"), {
		topology: "multi",
		selfDomain: "backend",
	});
	assert.ok(reason);
	assert.ok(reason.includes("RECOVERY_OUT_OF_JURISDICTION"), reason);
});

// ---------------------------------------------------------------------------
// send_agent_prompt may not reach into another Lead's team
// ---------------------------------------------------------------------------

test("the target id is read from the same field Paseo documents", () => {
	assert.equal(sendAgentPromptTargetId({ agentId: LEAD_A, prompt: "hi" }), LEAD_A);
	assert.equal(sendAgentPromptTargetId({ args: { agentId: LEAD_A } }), LEAD_A);
	assert.equal(sendAgentPromptTargetId({ args: JSON.stringify({ agentId: LEAD_A }) }), LEAD_A);
	assert.equal(sendAgentPromptTargetId({ prompt: "hi" }), null);
	assert.equal(sendAgentPromptTargetId(null), null);
});

const ownership = (over: Record<string, unknown> = {}) =>
	sendAgentPromptBlockReason({
		role: "lead",
		selfAgentId: LEAD_A,
		targetId: PEER_B,
		target: { agentId: PEER_B, parentAgentId: SUP_B, provider: "pi-peer/anthropic/x", role: "peer", domain: null },
		topology: "multi",
		...over,
	} as never);

test("single topology leaves send_agent_prompt exactly as it was", () => {
	assert.equal(ownership({ topology: "single" }), null);
});

test("a Peer belonging to another Lead cannot be prompted", () => {
	const reason = ownership();
	assert.ok(reason);
	assert.ok(reason.includes("PROMPT_TARGET_NOT_OWNED"), reason);
	assert.ok(reason.includes(SUP_B), "the message names the owner to talk to");
});

test("a Peer this Lead created is fine", () => {
	assert.equal(
		ownership({
			target: { agentId: PEER_B, parentAgentId: LEAD_A, provider: "pi-peer/x/y", role: "peer", domain: null },
		}),
		null,
	);
});

test("another Lead or Supervisor is always reachable — that is the coordination path", () => {
	assert.equal(
		ownership({
			target: { agentId: SUP_B, parentAgentId: null, provider: "claude-lead/claude-opus-5", role: "lead", domain: null },
		}),
		null,
	);
	assert.equal(
		ownership({
			target: { agentId: SUP_B, parentAgentId: null, provider: "pi-supervisor/x/y", role: "supervisor", domain: null },
		}),
		null,
	);
});

test("an unresolvable target is blocked, not assumed friendly", () => {
	const reason = ownership({ target: null });
	assert.ok(reason);
	assert.ok(reason.includes("PROMPT_TARGET_UNKNOWN"), reason);
});

test("a missing target id is blocked", () => {
	const reason = ownership({ targetId: null, target: null });
	assert.ok(reason);
	assert.ok(reason.includes("PROMPT_TARGET_MISSING"), reason);
});

test("an agent whose provider is not a role provider is treated as unowned work", () => {
	const reason = ownership({
		target: { agentId: PEER_B, parentAgentId: SUP_B, provider: "codex/gpt-5", role: null, domain: null },
	});
	assert.ok(reason);
	assert.ok(reason.includes("PROMPT_TARGET_NOT_OWNED"), reason);
});

// ---------------------------------------------------------------------------
// Ownership comes off Paseo's own state files (§1.4), not from a registry
// ---------------------------------------------------------------------------

test("agentOwnership reads provider, parent and domain from the state file", () => {
	const home = mkdtempSync(join(tmpdir(), "pteam-gov-"));
	try {
		const dir = join(home, "agents", "D--Code-shop");
		mkdirSync(dir, { recursive: true });
		writeFileSync(
			join(dir, `${PEER_B}.json`),
			JSON.stringify({
				id: PEER_B,
				provider: "pi-peer/anthropic/claude-sonnet-5",
				labels: { "paseo.parent-agent-id": LEAD_A, "team.domain": "backend.auth" },
			}),
		);

		const found = agentOwnership(PEER_B, { PASEO_HOME: home });
		assert.ok(found);
		assert.equal(found.parentAgentId, LEAD_A);
		assert.equal(found.role, "peer");
		assert.equal(found.domain, "backend.auth");

		// A missing state file is "unknown", which the guard treats as fatal —
		// never as "no parent, therefore free to prompt".
		assert.equal(agentOwnership(SUP_A, { PASEO_HOME: home }), null);
		assert.equal(agentOwnership("not-a-uuid", { PASEO_HOME: home }), null);
	} finally {
		rmSync(home, { recursive: true, force: true });
	}
});

console.log("governance tests passed");

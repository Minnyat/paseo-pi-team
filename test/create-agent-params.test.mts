/**
 * create-agent-params.test.mts — one job, one workspace; and only the
 * parameters Paseo actually reads.
 *
 * The spam these tests pin: a Lead or Supervisor that passed any placement
 * parameter to `create_agent` (`workspace`, `relationship`, `cwd`,
 * `worktreeName`, ...) made Paseo mint a NEW workspace for the new agent, and a
 * Lead that called `create_workspace` for its Writer and its Reviewer left two
 * more behind. Nothing in the pack refused any of it.
 *
 * The contract the gate holds the call to is read from Paseo's own tool
 * definition (@getpaseo/server 0.10.x, agent/tools/paseo-tools.js): in an
 * agent-scoped session `create_agent` takes
 * `{ title, provider, initialPrompt, labels?, settings?, workspaceId?,
 * notifyOnFinish? }`, and an omitted `workspaceId` means the CALLER's workspace.
 */

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
	CREATE_AGENT_PARAMS,
	CREATE_AGENT_PLACEMENT_PARAMS,
	createAgentParamsBlockReason,
	leadWorkspaceMutationBlockReason,
	mcpBlockReason,
	selfWorkspaceId,
} from "../extensions/paseo-team-core/policy-core.ts";

const OWN = "ws_job_1";

const good = {
	title: "Scout the repo",
	provider: "pi-peer/Minnyat/gpt-5.4",
	initialPrompt: "Look around and tell me what you find.",
	settings: { thinkingOptionId: "high" },
};

const lead = (args: unknown, selfWorkspaceId: string | null = OWN) =>
	createAgentParamsBlockReason({ role: "lead", args, selfWorkspaceId });

test("a complete call that names no placement passes, for a Lead and a Supervisor", () => {
	assert.equal(lead(good), null);
	assert.equal(createAgentParamsBlockReason({ role: "supervisor", args: good, selfWorkspaceId: OWN }), null);
	assert.equal(
		lead({ ...good, labels: { "team.cluster": "shop" }, notifyOnFinish: false, settings: { thinkingOptionId: "off", modeId: "auto" } }),
		null,
		"labels, notifyOnFinish and the full settings object are all things Paseo reads",
	);
});

test("a Peer is not this gate's business", () => {
	assert.equal(createAgentParamsBlockReason({ role: "peer", args: {}, selfWorkspaceId: OWN }), null);
});

test("every placement parameter is refused by name, with what Paseo would have done", () => {
	const samples: Record<string, unknown> = {
		relationship: { kind: "detached" },
		workspace: { kind: "create", source: { kind: "worktree", target: { kind: "branch-off" } } },
		cwd: "/somewhere/else",
		worktreeName: "feature-x",
		branchName: "agent/T-1",
		baseBranch: "main",
		refName: "main",
		githubPrNumber: 12,
	};
	assert.deepEqual(Object.keys(samples).sort(), [...CREATE_AGENT_PLACEMENT_PARAMS].sort(), "the table and the samples agree");
	for (const [key, value] of Object.entries(samples)) {
		const reason = lead({ ...good, [key]: value }) ?? "";
		assert.match(reason, new RegExp(`"${key}"`), `${key} is named`);
		assert.match(reason, /new workspace|detach/, `${key}: the refusal says what Paseo would do with it`);
		assert.match(reason, /lands in YOUR workspace/, `${key}: and what to do instead`);
	}
	assert.match(lead({ ...good, cwd: "/x", workspace: { kind: "current" } }) ?? "", /"workspace", "cwd" are placement parameters/);
});

test("an explicit workspaceId is allowed only when it IS the creator's own", () => {
	assert.equal(lead({ ...good, workspaceId: OWN }), null, "naming your own workspace is redundant, not wrong");
	assert.equal(lead({ ...good, workspaceId: ` ${OWN} ` }), null, "whitespace does not make it a different workspace");
	assert.match(lead({ ...good, workspaceId: "ws_other" }) ?? "", /"workspaceId" is "ws_other", but this seat's workspace is "ws_job_1"/);
	assert.match(lead({ ...good, workspaceId: "" }) ?? "", /"workspaceId" is empty/);
	// The creator's own workspace unreadable: "the same workspace" is unprovable,
	// and omitting the field is always provable, so the explicit form is refused.
	assert.match(lead({ ...good, workspaceId: OWN }, null) ?? "", /cannot be shown to be your own workspace/);
	assert.equal(lead(good, null), null, "…while leaving it out never needs the lookup");
});

test("parameters Paseo does not read are refused, and told where they belong", () => {
	const reason = lead({ ...good, mode: "auto", thinking: "high", model: "gpt-5.4", background: true, color: "red" }) ?? "";
	assert.match(reason, /"mode" \(belongs in settings\.modeId\)/);
	assert.match(reason, /"thinking" \(belongs in settings\.thinkingOptionId\)/);
	assert.match(reason, /"model" \(belongs in the model segment of "provider"/);
	assert.match(reason, /"background" \(belongs in nothing/);
	assert.match(reason, /"color" \(belongs in nowhere: Paseo ignores it\)/);
	assert.match(reason, new RegExp(`create_agent reads only: ${CREATE_AGENT_PARAMS.join(", ")}`));
});

test("a missing required parameter is named, and so is every other defect, in ONE refusal", () => {
	assert.match(lead({ ...good, title: undefined }) ?? "", /"title" is required/);
	assert.match(lead({ ...good, title: "x".repeat(61) }) ?? "", /"title" is 61 characters; Paseo allows at most 60/);
	assert.match(lead({ ...good, initialPrompt: "  " }) ?? "", /"initialPrompt" is required/);
	assert.match(lead({ ...good, provider: undefined }) ?? "", /"provider" must be "<role-provider>\/<model-id>"/);
	assert.match(lead({ ...good, provider: "pi-peer" }) ?? "", /with the model in it/, "a role provider with no model segment");
	assert.match(lead({ ...good, settings: undefined }) ?? "", /settings\.thinkingOptionId" is required/);
	assert.match(lead({ ...good, settings: { modeId: "auto" } }) ?? "", /settings\.thinkingOptionId" is required/);

	const many = lead({ provider: "pi-peer", workspace: { kind: "create" }, mode: "plan" }) ?? "";
	for (const needle of ['"workspace"', '"mode"', '"title" is required', '"initialPrompt" is required', "thinkingOptionId", "with the model in it"]) {
		assert.ok(many.includes(needle), `one message carries ${needle}: ${many}`);
	}
	assert.equal(many.split("Refusing create_agent").length, 2, "and it is a single refusal");
});

test("settings is strict, like Paseo's: a model in settings is the classic mistake", () => {
	const reason = lead({ ...good, settings: { thinkingOptionId: "high", model: "gpt-5.4" } }) ?? "";
	assert.match(reason, /settings\.model is not a create-time setting/);
	assert.match(reason, /a model belongs in "provider"/);
	assert.match(lead({ ...good, settings: "high" }) ?? "", /"settings" must be an object/);
});

test("labels must be strings, and notifyOnFinish a boolean", () => {
	assert.match(lead({ ...good, labels: { "team.cluster": 3 } }) ?? "", /labels\.team\.cluster must be string values/);
	assert.match(lead({ ...good, labels: ["x"] }) ?? "", /labels must be string values/);
	assert.match(lead({ ...good, notifyOnFinish: "yes" }) ?? "", /"notifyOnFinish" must be true or false/);
});

test("no arguments object at all is refused with the contract", () => {
	for (const args of [null, undefined, "x", ["a"]]) {
		assert.match(lead(args) ?? "", /no arguments object/);
	}
});

test("wired into mcpBlockReason: after the mode gate, and fed the creator's workspace", () => {
	// The route gate (which follows this one and has no "could not tell" pass) is
	// switched off here: this test is about placement, and the route gate has its
	// own suite (route-gate.test.mts).
	const ROUTE_GATE_OFF = { PASEO_TEAM_ROUTE_ENFORCE: "off" };
	const call = (args: unknown, ctx = {}) =>
		mcpBlockReason("lead", { tool: "create_agent", args }, { env: ROUTE_GATE_OFF, ...ctx });
	assert.equal(call(good, { selfWorkspaceId: OWN }), null);
	assert.match(call({ ...good, workspace: { kind: "create" } }, { selfWorkspaceId: OWN }) ?? "", /placement parameter/);
	assert.match(call({ ...good, workspaceId: "ws_other" }, { selfWorkspaceId: OWN }) ?? "", /Everything in one job shares the creator's workspace/);
	// Earlier gates still speak first: a missing cluster label is reported as that.
	assert.match(call({ ...good, workspace: { kind: "create" } }, { cluster: "shop", selfWorkspaceId: OWN }) ?? "", /team\.cluster/);
	// And a Supervisor creating a Peer hears about the role, not the placement.
	assert.match(
		mcpBlockReason("supervisor", { tool: "create_agent", args: { ...good, cwd: "/x" } }) ?? "",
		/lead-recovery only/,
	);
});

test("a Lead cannot create or archive a workspace; the refusal names the route", () => {
	for (const tool of ["create_workspace", "paseo_create_workspace", "mcp__paseo__create_workspace", "archive_workspace"]) {
		const reason = leadWorkspaceMutationBlockReason(tool) ?? "";
		assert.match(reason, /does not create or archive workspaces/, tool);
		assert.match(reason, /git worktree add/, `${tool}: the Reviewer's own route is named`);
	}
	assert.equal(leadWorkspaceMutationBlockReason("list_workspaces"), null);
	assert.equal(leadWorkspaceMutationBlockReason("create_agent"), null);
});

test("selfWorkspaceId reads the creator's workspace from its own Paseo state, and only a positive read is kept", () => {
	const id = "aaaaaaaa-1111-4111-8111-111111111111";
	const home = mkdtempSync(join(tmpdir(), "pteam-selfws-"));
	const env = { PASEO_HOME: home, PASEO_AGENT_ID: id };
	try {
		assert.equal(selfWorkspaceId(env), null, "no state file yet: unknown, not 'no workspace'");
		const dir = join(home, "agents", "slug-a");
		mkdirSync(dir, { recursive: true });
		writeFileSync(join(dir, `${id}.json`), JSON.stringify({ id, workspaceId: OWN, cwd: "/repo" }));
		assert.equal(selfWorkspaceId(env), OWN, "…and the missing read was not cached");
		assert.equal(selfWorkspaceId({ PASEO_HOME: home }), null, "no agent id: nothing to read");
		assert.equal(selfWorkspaceId({ PASEO_HOME: home, PASEO_AGENT_ID: "not-an-id" }), null);
	} finally {
		rmSync(home, { recursive: true, force: true });
	}
});

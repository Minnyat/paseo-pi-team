// policy.test.mts — unit tests for the role policy pure functions and the
// per-turn lifecycle of the extension.
// Run: node test/policy.test.mts   (node >= 23.6 runs .ts natively)

import assert from "node:assert/strict";
import {
	ALL_PASEO_TOOLS,
	callsPaseoCli,
	classifyMcpInput,
	denyReason,
	gitAuthorityBlockReason,
	isSupervisorAllowedMcpTarget,
	mcpBlockReason,
	mcpScriptBlockReason,
	parsePeerMode,
	parseTaskBrief,
	peerGitAuthority,
	policyFor,
	policyWithAuthority,
	resolvePeerMode,
} from "../extensions/paseo-team-policy.ts";

// --- parseTaskBrief ----------------------------------------------------------

const v2WriteBrief = [
	"PASEO_TEAM_TASK_V2",
	"",
	"TASK_ID: T-001",
	"DISPOSITION: engineer",
	"MODE: write",
	"",
	"OBJECTIVE: x",
	"EDIT_AUTHORITY: allowed",
	"COMMIT_AUTHORITY: allowed",
	"PUSH_TASK_BRANCH_AUTHORITY: allowed",
].join("\n");

{
	const brief = parseTaskBrief(v2WriteBrief);
	assert.ok(brief, "V2 brief parses");
	assert.equal(brief.version, 2);
	assert.equal(brief.mode, "write");
	assert.deepEqual(brief.malformed, []);
	assert.equal(brief.fields.get("COMMIT_AUTHORITY"), "allowed");
}

{
	const brief = parseTaskBrief(
		"PASEO_TEAM_TASK_V1\n\nMODE: write\n\nOBJECTIVE: x",
	);
	assert.ok(brief, "V1 brief parses");
	assert.equal(brief.version, 1);
	assert.equal(brief.mode, "write");
	assert.deepEqual(brief.malformed, []);
}

// Header must be the first non-empty line.
assert.equal(
	parseTaskBrief("MODE: write\nmore content"),
	null,
	"no header → null",
);
assert.equal(parseTaskBrief("X PASEO_TEAM_TASK_V2\nMODE: write"), null);
assert.equal(
	parseTaskBrief("PASEO_TEAM_TASK_V3\nMODE: write"),
	null,
	"unknown version",
);
assert.equal(
	parseTaskBrief("PASEO_TEAM_TASK_V\nMODE: write"),
	null,
	"truncated header",
);
assert.equal(parseTaskBrief("random prompt"), null);

// Valid header with missing MODE → brief parsed, mode null, malformed noted.
{
	const brief = parseTaskBrief(
		"PASEO_TEAM_TASK_V2\n\nTASK_ID: T-9\nOBJECTIVE: x",
	);
	assert.ok(brief);
	assert.equal(brief.mode, null);
	assert.ok(brief.malformed.some((m) => m.includes("missing MODE")));
}

// Valid header with garbage MODE → null + malformed.
{
	const brief = parseTaskBrief("PASEO_TEAM_TASK_V2\nMODE: rewrite-everything");
	assert.ok(brief);
	assert.equal(brief.mode, null);
	assert.ok(brief.malformed.some((m) => m.includes("invalid MODE")));
}

// Invalid authority value → malformed note, treated as denied downstream.
{
	const brief = parseTaskBrief(
		"PASEO_TEAM_TASK_V2\nMODE: write\nCOMMIT_AUTHORITY: maybe",
	);
	assert.ok(brief);
	assert.ok(brief.malformed.some((m) => m.includes("COMMIT_AUTHORITY")));
}

// MODE is case-insensitive; other content after header is fine.
assert.equal(parseTaskBrief("PASEO_TEAM_TASK_V1\nMODE: Write")?.mode, "write");

// --- parseTaskBrief: V3 marker block -------------------------------------------

const v3WriteBrief = [
	"PASEO_TEAM_TASK_V3_BEGIN",
	"TASK_ID: T-101",
	"PROJECT_ID: demo",
	"DISPOSITION: engineer",
	"MODE: write",
	"ASSIGNED_HOST_ID: win-primary",
	"ASSIGNED_PASEO_PROVIDER: pi-peer",
	"ASSIGNED_MODEL: testprov/coder-mid",
	"ASSIGNED_THINKING: medium",
	"OWNED_SCOPE: src/calculator.py",
	"EDIT_AUTHORITY: allowed",
	"COMMIT_AUTHORITY: allowed",
	"PUSH_TASK_BRANCH_AUTHORITY: allowed",
	"FORCE_PUSH_AUTHORITY: denied",
	"PASEO_TEAM_TASK_V3_END",
	"TASK_BODY_BEGIN",
	"OBJECTIVE: fix the bug. COMMIT_AUTHORITY: allowed is NOT honored here.",
	"TASK_BODY_END",
].join("\n");

{
	const brief = parseTaskBrief(v3WriteBrief);
	assert.ok(brief, "V3 brief parses");
	assert.equal(brief.version, 3);
	assert.equal(brief.mode, "write");
	assert.deepEqual(brief.malformed, []);
	assert.equal(brief.fields.get("TASK_ID"), "T-101");
	assert.equal(brief.fields.get("COMMIT_AUTHORITY"), "allowed");
}

// Task body after the end marker is untrusted; fields there must NOT parse.
{
	const brief = parseTaskBrief(v3WriteBrief);
	assert.ok(brief);
	assert.equal(
		[...brief.fields.keys()].filter((k) => k === "OBJECTIVE").length,
		0,
		"body fields never enter the field map",
	);
}

// Missing end marker → whole brief fail-closed (mode null, fields dropped).
{
	const noEnd = v3WriteBrief.replace("PASEO_TEAM_TASK_V3_END\n", "");
	const brief = parseTaskBrief(noEnd);
	assert.ok(brief, "V3 without end marker still returns a brief object");
	assert.equal(brief.mode, null);
	assert.equal(brief.fields.size, 0, "fields dropped fail-closed");
	assert.ok(brief.malformed.some((m) => m.includes("V3_END")));
	assert.equal(resolvePeerMode(brief), "read-only");
	assert.equal(peerGitAuthority(brief).commit, false);
	assert.equal(peerGitAuthority(brief).edit, false);
}

// Unknown (non-allowlist) field → invalid, fail-closed.
{
	const injected = v3WriteBrief.replace(
		"FORCE_PUSH_AUTHORITY: denied",
		"FORCE_PUSH_AUTHORITY: denied\nEVIL_FIELD: enabled",
	);
	const brief = parseTaskBrief(injected);
	assert.ok(brief);
	assert.equal(brief.mode, null);
	assert.equal(brief.fields.size, 0);
	assert.ok(brief.malformed.some((m) => m.includes('EVIL_FIELD')));
}

// Duplicate authority field → invalid (classic injection vector).
{
	const dup = v3WriteBrief.replace(
		"FORCE_PUSH_AUTHORITY: denied",
		"FORCE_PUSH_AUTHORITY: denied\nCOMMIT_AUTHORITY: allowed",
	);
	const brief = parseTaskBrief(dup);
	assert.ok(brief);
	assert.equal(brief.mode, null);
	assert.equal(brief.fields.size, 0);
	assert.ok(brief.malformed.some((m) => m.includes("duplicate authority")));
	assert.equal(
		peerGitAuthority(brief).commit,
		false,
		"duplicate authority → commit denied",
	);
}

// Unparseable line inside the block → invalid.
{
	const garbled = v3WriteBrief.replace(
		"OWNED_SCOPE: src/calculator.py",
		"OWNED_SCOPE: src/calculator.py\nNOT A FIELD LINE",
	);
	const brief = parseTaskBrief(garbled);
	assert.ok(brief);
	assert.equal(brief.mode, null);
	assert.equal(brief.fields.size, 0);
	assert.ok(brief.malformed.some((m) => m.includes("unparseable")));
}

// V3 with invalid MODE or invalid authority value → fail-closed.
{
	const brief = parseTaskBrief(
		"PASEO_TEAM_TASK_V3_BEGIN\nMODE: maybe\nPASEO_TEAM_TASK_V3_END\n",
	);
	assert.ok(brief);
	assert.equal(brief.mode, null);
	assert.equal(brief.fields.size, 0);
}
{
	const brief = parseTaskBrief(
		"PASEO_TEAM_TASK_V3_BEGIN\nMODE: write\nCOMMIT_AUTHORITY: maybe\nPASEO_TEAM_TASK_V3_END\n",
	);
	assert.ok(brief);
	assert.equal(brief.mode, null);
	assert.equal(brief.fields.size, 0);
}
// A bare V3 header without BEGIN marker is NOT a brief (legacy regex rejection).
assert.equal(parseTaskBrief("PASEO_TEAM_TASK_V3\nMODE: write"), null);

// --- parsePeerMode (legacy, strict-brief based) -------------------------------

assert.equal(
	parsePeerMode("PASEO_TEAM_TASK_V1\n\nMODE: write\n\nOBJECTIVE: x"),
	"write",
);
assert.equal(parsePeerMode("PASEO_TEAM_TASK_V2\nMODE: read-only"), "read-only");
assert.equal(
	parsePeerMode("MODE: write\nmore content"),
	null,
	"no header → null",
);
assert.equal(parsePeerMode("no mode here"), null);
assert.equal(
	parsePeerMode("X MODE: write"),
	null,
	"MODE must be line-anchored",
);

// --- resolvePeerMode (fail-closed) --------------------------------------------

assert.equal(resolvePeerMode(null), "read-only", "no brief → read-only");
assert.equal(
	resolvePeerMode(parseTaskBrief("PASEO_TEAM_TASK_V2\nMODE: write")),
	"write",
);
assert.equal(
	resolvePeerMode(parseTaskBrief("PASEO_TEAM_TASK_V2")),
	"read-only",
	"brief without MODE → read-only",
);
assert.equal(
	resolvePeerMode(parseTaskBrief("PASEO_TEAM_TASK_V2\nMODE: bogus")),
	"read-only",
	"brief with invalid MODE → read-only",
);

// --- peerGitAuthority ----------------------------------------------------------

{
	// V1 / no brief: edit follows mode; commit/push denied.
	const auth = peerGitAuthority(
		parseTaskBrief("PASEO_TEAM_TASK_V1\nMODE: write"),
	);
	assert.deepEqual(auth, {
		edit: true,
		commit: false,
		pushTaskBranch: false,
		forcePush: false,
		merge: false,
		deploy: false,
	});
}
{
	const auth = peerGitAuthority(null);
	assert.deepEqual(auth, {
		edit: false,
		commit: false,
		pushTaskBranch: false,
		forcePush: false,
		merge: false,
		deploy: false,
	});
}
{
	// V2 explicit allow wins over mode default; explicit deny wins over mode.
	const allow = peerGitAuthority(
		parseTaskBrief(
			"PASEO_TEAM_TASK_V2\nMODE: write\nCOMMIT_AUTHORITY: allowed\nPUSH_TASK_BRANCH_AUTHORITY: allowed",
		),
	);
	assert.equal(allow.commit, true);
	assert.equal(allow.pushTaskBranch, true);
	assert.equal(allow.forcePush, false, "force-push never allowed");
	assert.equal(allow.merge, false, "merge never allowed");

	const denyEdit = peerGitAuthority(
		parseTaskBrief("PASEO_TEAM_TASK_V2\nMODE: write\nEDIT_AUTHORITY: denied"),
	);
	assert.equal(denyEdit.edit, false, "explicit deny overrides MODE: write");
}
{
	// A brief claiming force-push/merge is still denied.
	const auth = peerGitAuthority(
		parseTaskBrief(
			"PASEO_TEAM_TASK_V2\nMODE: write\nFORCE_PUSH_AUTHORITY: allowed\nMERGE_AUTHORITY: allowed",
		),
	);
	assert.equal(auth.forcePush, false);
	assert.equal(auth.merge, false);
}

// --- gitAuthorityBlockReason ---------------------------------------------------

const fullAuth = peerGitAuthority(
	parseTaskBrief(
		"PASEO_TEAM_TASK_V2\nMODE: write\nCOMMIT_AUTHORITY: allowed\nPUSH_TASK_BRANCH_AUTHORITY: allowed",
	),
);
const noAuth = peerGitAuthority(null);

assert.equal(gitAuthorityBlockReason("npm test", fullAuth), null);
assert.equal(gitAuthorityBlockReason("git commit -m x", fullAuth), null);
assert.equal(
	gitAuthorityBlockReason("git push origin task/t-1", fullAuth),
	null,
);
assert.match(
	gitAuthorityBlockReason("git push -f origin task/t-1", fullAuth) ?? "",
	/FORCE_PUSH/,
	"force-push blocked even with push authority",
);
assert.match(
	gitAuthorityBlockReason("git push --force-with-lease origin b", fullAuth) ??
		"",
	/FORCE_PUSH/,
);
assert.match(
	gitAuthorityBlockReason("git push origin task/t-1 --force", fullAuth) ?? "",
	/FORCE_PUSH/,
	"trailing --force blocked",
);
assert.match(
	gitAuthorityBlockReason("git push origin task/t-1 -f", fullAuth) ?? "",
	/FORCE_PUSH/,
	"trailing -f blocked",
);
assert.match(
	gitAuthorityBlockReason(
		"git fetch origin && git push --force-with-lease=task/t-1 origin task/t-1",
		fullAuth,
	) ?? "",
	/FORCE_PUSH/,
	"--force-with-lease=<ref> chained command blocked",
);
assert.match(
	gitAuthorityBlockReason("git commit -m x", noAuth) ?? "",
	/COMMIT_AUTHORITY/,
	"commit blocked without authority",
);
assert.match(
	gitAuthorityBlockReason("git push origin task/t-1", noAuth) ?? "",
	/PUSH_TASK_BRANCH_AUTHORITY/,
);
assert.match(
	gitAuthorityBlockReason("git merge main", fullAuth) ?? "",
	/MERGE_AUTHORITY/,
	"merge always blocked",
);
assert.equal(
	gitAuthorityBlockReason("git status && git diff", noAuth),
	null,
	"read-only git plumbing is fine",
);
assert.match(
	gitAuthorityBlockReason("echo 'use git commit in the message'", noAuth) ?? "",
	/COMMIT_AUTHORITY/,
	"heuristic over-matches quoted mentions — fail-closed is intentional",
);

// --- classifyMcpInput -----------------------------------------------------------

assert.deepEqual(classifyMcpInput({ connect: "paseo" }), { kind: "meta" });
assert.deepEqual(classifyMcpInput({ search: "create_agent" }), {
	kind: "meta",
});
assert.deepEqual(classifyMcpInput({ describe: "list_agents" }), {
	kind: "meta",
});
assert.deepEqual(classifyMcpInput({ instructions: "x" }), { kind: "meta" });
assert.deepEqual(classifyMcpInput({ server: "paseo" }), { kind: "meta" });
assert.deepEqual(classifyMcpInput({}), { kind: "meta" }, "status call");
assert.deepEqual(classifyMcpInput({ action: "ui-messages" }), { kind: "meta" });
assert.deepEqual(classifyMcpInput({ tool: "list_agents", args: {} }), {
	kind: "target",
	target: "list_agents",
});
assert.deepEqual(classifyMcpInput({ tool: "paseo_create_agent" }), {
	kind: "target",
	target: "paseo_create_agent",
});
assert.equal(
	classifyMcpInput({ tool: 123 }).kind,
	"unknown",
	"non-string tool",
);
assert.equal(classifyMcpInput({ tool: "" }).kind, "unknown", "empty tool");
assert.equal(
	classifyMcpInput("list_agents").kind,
	"unknown",
	"non-object input",
);
assert.equal(classifyMcpInput(null).kind, "unknown");
assert.equal(classifyMcpInput({ action: "auth-start" }).kind, "unknown");
assert.equal(
	classifyMcpInput({ unexpected: "shape" }).kind,
	"unknown",
	"no determinable target",
);

// --- isSupervisorAllowedMcpTarget -------------------------------------------

assert.equal(isSupervisorAllowedMcpTarget("list_agents"), true);
assert.equal(isSupervisorAllowedMcpTarget("paseo_list_agents"), true);
assert.equal(isSupervisorAllowedMcpTarget("get_agent_status"), true);
assert.equal(isSupervisorAllowedMcpTarget("send_agent_prompt"), true);
assert.equal(isSupervisorAllowedMcpTarget("create_agent"), false);
assert.equal(
	isSupervisorAllowedMcpTarget("paseo_create_agent"),
	false,
	"prefixed form",
);
assert.equal(
	isSupervisorAllowedMcpTarget("create_terminal"),
	false,
	"no terminal access",
);
assert.equal(isSupervisorAllowedMcpTarget("paseo_create_terminal"), false);
assert.equal(isSupervisorAllowedMcpTarget("start_workspace_script"), false);
assert.equal(isSupervisorAllowedMcpTarget("create_schedule"), false);
assert.equal(
	isSupervisorAllowedMcpTarget("list_providers"),
	false,
	"no discovery",
);
assert.equal(
	isSupervisorAllowedMcpTarget("unknown_tool"),
	false,
	"fail-closed on unknown",
);

// --- mcpBlockReason (supervisor + lead, fail-closed) --------------------------

// Supervisor meta ops pass.
assert.equal(mcpBlockReason("supervisor", { connect: "paseo" }), null);
assert.equal(mcpBlockReason("supervisor", { search: "agents" }), null);
assert.equal(mcpBlockReason("supervisor", {}), null);
// Supervisor allowed targets pass (prefixed and bare).
assert.equal(mcpBlockReason("supervisor", { tool: "list_agents" }), null);
assert.equal(
	mcpBlockReason("supervisor", { tool: "paseo_get_agent_status" }),
	null,
);
// Supervisor blocked targets.
assert.match(
	mcpBlockReason("supervisor", { tool: "create_terminal" }) ?? "",
	/monitoring tools/,
);
assert.match(
	mcpBlockReason("supervisor", { tool: "paseo_create_agent" }) ?? "",
	/blocked/,
);
// Fail-closed on unclassifiable input.
assert.ok(
	mcpBlockReason("supervisor", { tool: undefined }) !== null,
	"missing tool value → block",
);
assert.ok(
	mcpBlockReason("supervisor", { weird: true }) !== null,
	"unknown shape → block",
);
assert.ok(mcpBlockReason("supervisor", { action: "auth-start" }) !== null);

// Lead target allowlist: discovery/workspace/monitoring/orchestration/permissions.
assert.equal(mcpBlockReason("lead", { connect: "paseo" }), null);
assert.equal(mcpBlockReason("lead", { tool: "create_agent" }), null);
assert.equal(mcpBlockReason("lead", { tool: "respond_to_permission" }), null);
assert.match(
	mcpBlockReason("lead", { tool: "create_terminal" }) ?? "",
	/allowlist/,
	"lead cannot drive terminals via MCP",
);
assert.match(
	mcpBlockReason("lead", { tool: "create_schedule" }) ?? "",
	/allowlist/,
	"lead cannot create schedules",
);
assert.ok(
	mcpBlockReason("lead", { tool: "future_paseo_tool" }) !== null,
	"unknown future target → fail-closed",
);
assert.ok(mcpBlockReason("lead", { tool: {} }) !== null);

// Peer is fully blocked (handled by caller always blocking mcp for peer).

// --- mcpScriptBlockReason (lead heuristic backstop) ---------------------------

assert.equal(
	mcpScriptBlockReason("lead", "const r = await tools.paseo_list_agents();"),
	null,
);
assert.equal(
	mcpScriptBlockReason(
		"lead",
		'await tools.call("paseo_create_agent", { provider: "pi-peer/x" });',
	),
	null,
);
assert.match(
	mcpScriptBlockReason("lead", "await tools.paseo_create_terminal();") ?? "",
	/allowlist/,
);
assert.equal(
	mcpScriptBlockReason("lead", 'await tools.search({ query: "agents" })'),
	null,
	"adapter helper calls are not targets",
);
assert.equal(
	mcpScriptBlockReason("lead", 'await tools["paseo_list_agents"]();'),
	null,
	"bracket-access direct call of an allowed target passes",
);
assert.match(
	mcpScriptBlockReason("lead", 'await tools["paseo_create_terminal"]();') ??
		"",
	/allowlist/,
	"bracket-access direct call of a blocked target is caught",
);
// Supervisor: monitoring allowlist enforced for mcp_script too.
assert.equal(
	mcpScriptBlockReason("supervisor", "await tools.paseo_list_agents();"),
	null,
);
assert.match(
	mcpScriptBlockReason("supervisor", "await tools.paseo_create_agent({});") ??
		"",
	/allowlist/,
	"supervisor mcp_script cannot create agents",
);

// --- policyFor --------------------------------------------------------------

const peerRO = policyFor("peer", "read-only");
assert.deepEqual(peerRO.allow, ["read", "bash"]);
assert.ok(peerRO.deny.includes("write") && peerRO.deny.includes("edit"));
assert.ok(
	peerRO.deny.includes("mcp") && peerRO.deny.includes("mcp_script"),
	"peer denies the MCP proxy tools",
);
assert.ok(
	ALL_PASEO_TOOLS.every((t) => peerRO.deny.includes(t)),
	"peer read-only denies all paseo tools",
);

const peerW = policyFor("peer", "write");
assert.deepEqual(peerW.allow, ["read", "write", "edit", "bash"]);
assert.ok(
	ALL_PASEO_TOOLS.every((t) => peerW.deny.includes(t)),
	"peer write still denies all paseo tools",
);
assert.ok(
	peerW.deny.includes("mcp") && peerW.deny.includes("mcp_script"),
	"peer write still denies the MCP proxy tools",
);

const prevLeadWrite = process.env.PASEO_TEAM_LEAD_WRITE;
delete process.env.PASEO_TEAM_LEAD_WRITE;
const lead = policyFor("lead", "read-only");
assert.ok(
	ALL_PASEO_TOOLS.every((t) => lead.allow.includes(t)),
	"lead allows all paseo tools",
);
assert.ok(
	lead.allow.includes("respond_to_permission"),
	"lead can triage peer permission requests",
);
assert.ok(
	lead.allow.includes("mcp") && lead.allow.includes("mcp_script"),
	"lead keeps the MCP proxy tools",
);
assert.ok(
	!lead.allow.includes("write") && !lead.allow.includes("edit"),
	"lead is read-only by default (PASEO_TEAM_LEAD_WRITE opts in)",
);
process.env.PASEO_TEAM_LEAD_WRITE = "1";
const leadWrite = policyFor("lead", "read-only");
assert.ok(
	leadWrite.allow.includes("write") && leadWrite.allow.includes("edit"),
	"PASEO_TEAM_LEAD_WRITE=1 grants write/edit",
);
if (prevLeadWrite === undefined) delete process.env.PASEO_TEAM_LEAD_WRITE;
else process.env.PASEO_TEAM_LEAD_WRITE = prevLeadWrite;
assert.deepEqual(lead.deny, []);

const sup = policyFor("supervisor", "read-only");
assert.ok(
	!sup.allow.includes("write") && !sup.allow.includes("edit"),
	"supervisor has no write tools",
);
assert.ok(
	!sup.allow.includes("create_agent") &&
		!sup.allow.includes("create_workspace"),
);
assert.ok(
	sup.allow.includes("list_agents") && sup.allow.includes("send_agent_prompt"),
);
assert.ok(sup.allow.includes("mcp"), "supervisor needs the mcp proxy");
assert.ok(!sup.allow.includes("mcp_script"));

// --- policyWithAuthority (edit denial enforcement) ---------------------------

{
	// MODE: write + EDIT_AUTHORITY: denied → write/edit stripped even though
	// MODE granted them. Tool allowlist AND backstop both fail-closed.
	const brief = parseTaskBrief(
		"PASEO_TEAM_TASK_V3_BEGIN\nMODE: write\nEDIT_AUTHORITY: denied\nCOMMIT_AUTHORITY: allowed\nPASEO_TEAM_TASK_V3_END\n",
	);
	assert.ok(brief);
	assert.equal(brief.mode, "write");
	const p = policyWithAuthority("peer", "write", brief);
	assert.ok(!p.allow.includes("write") && !p.allow.includes("edit"));
	assert.ok(p.deny.includes("write") && p.deny.includes("edit"));
	assert.equal(
		peerGitAuthority(brief).commit,
		true,
		"commit authority unaffected by edit denial",
	);
}
{
	// Normal write brief keeps write tools.
	const brief = parseTaskBrief(v3WriteBrief);
	const p = policyWithAuthority("peer", "write", brief);
	assert.ok(p.allow.includes("write") && p.allow.includes("edit"));
}
{
	// Fail-closed V3 (malformed) → no write tools at all.
	const brief = parseTaskBrief(
		"PASEO_TEAM_TASK_V3_BEGIN\nMODE: write\nCOMMIT_AUTHORITY: allowed",
	);
	const p = policyWithAuthority("peer", "read-only", brief);
	assert.ok(!p.allow.includes("write"));
	assert.ok(p.deny.includes("write") && p.deny.includes("edit"));
}

// --- denyReason -------------------------------------------------------------

assert.match(
	denyReason("peer", "read-only", "create_agent"),
	/DEPENDENCY_REQUEST/,
);
assert.match(denyReason("peer", "read-only", "write"), /read-only/);
assert.match(
	denyReason("peer", "write", "send_agent_prompt"),
	/DEPENDENCY_REQUEST/,
);
assert.match(
	denyReason("supervisor", "read-only", "write"),
	/Supervisor cannot modify product code/,
);
assert.match(
	denyReason("supervisor", "read-only", "create_agent"),
	/observation/,
);
assert.match(denyReason("peer", "read-only", "mcp"), /MCP proxy/);
assert.match(denyReason("peer", "write", "mcp_script"), /MCP proxy/);

// --- callsPaseoCli ----------------------------------------------------------

assert.equal(callsPaseoCli("paseo run --provider pi-lead 'do x'"), true);
assert.equal(callsPaseoCli("paseo.cmd send abc123 follow up"), true);
assert.equal(callsPaseoCli("npx paseo ls"), true);
assert.equal(
	callsPaseoCli("grep -r paseo ."),
	false,
	"bare mention must not block",
);
assert.equal(callsPaseoCli("echo paseo"), false);
assert.equal(callsPaseoCli("npm test"), false);

// --- Extension lifecycle helpers ----------------------------------------------

type StubEvent = {
	prompt?: string;
	systemPrompt?: string;
	toolName?: string;
	input?: unknown;
};
type StubHandler = (
	event: StubEvent,
) => Promise<{ block?: boolean; reason?: string } | undefined>;
type StubHandlers = Record<string, StubHandler[]>;

interface PiStub {
	on: (name: string, fn: StubHandler) => void;
	getAllTools: () => { name: string }[];
	setActiveTools: (names: string[]) => void;
	getActiveTools: () => string[];
	registerCommand: () => void;
}

function makePiStub(
	toolNames: string[],
	sink: string[] = [],
): {
	piStub: PiStub;
	handlers: StubHandlers;
} {
	const handlers: StubHandlers = {};
	const register: (
		handlers: StubHandlers,
		name: string,
		fn: StubHandler,
	) => void = (h, name, fn) => {
		(h[name] ??= []).push(fn);
	};
	const piStub: PiStub = {
		on: (name: string, fn: StubHandler) => register(handlers, name, fn),
		getAllTools: () => toolNames.map((name) => ({ name })),
		setActiveTools: (names: string[]) => {
			sink.length = 0;
			sink.push(...names);
		},
		getActiveTools: () => sink,
		registerCommand: () => {},
	};
	return { piStub, handlers };
}

async function loadFreshExtension(tag: string): Promise<(pi: PiStub) => void> {
	const specifier = `../extensions/paseo-team-policy.ts?${tag}`;
	const mod: { default: (pi: PiStub) => void } = await import(specifier);
	return mod.default;
}

function requireHandler(handlers: StubHandlers, name: string): StubHandler {
	const fn = handlers[name]?.[0];
	if (!fn) throw new Error(`handler "${name}" was not registered`);
	return fn;
}

// --- Extension lifecycle: peerMode must not leak across turns -----------------

{
	const activeTools: string[] = [];
	const { piStub, handlers } = makePiStub(
		["read", "write", "edit", "bash", "mcp", "mcp_script"],
		activeTools,
	);

	const prevRole = process.env.PASEO_PI_ROLE;
	process.env.PASEO_PI_ROLE = "peer";
	const createExtension = await loadFreshExtension("lifecycle=1");
	createExtension(piStub);
	assert.ok(handlers.before_agent_start?.length, "handler registered");

	const fire = async (prompt: string): Promise<string[]> => {
		for (const fn of handlers.before_agent_start ?? []) {
			await fn({ prompt, systemPrompt: "base" });
		}
		return [...activeTools];
	};

	// turn 1: valid write brief → write tools active.
	let tools = await fire("PASEO_TEAM_TASK_V2\nMODE: write\nOBJECTIVE: x");
	assert.ok(tools.includes("write"), "write mode grants write");

	// turn 2: follow-up prompt with no brief → read-only (no leak).
	tools = await fire("Looks good, keep going.");
	assert.ok(
		!tools.includes("write"),
		"missing brief → read-only, no mode leak",
	);

	// turn 3: valid write again.
	tools = await fire("PASEO_TEAM_TASK_V2\nMODE: write\nOBJECTIVE: y");
	assert.ok(tools.includes("write"), "write restored by fresh valid brief");

	// turn 4: malformed header + MODE write → read-only.
	tools = await fire("PASEO_TEAM_TASK_V\nMODE: write\nOBJECTIVE: z");
	assert.ok(!tools.includes("write"), "malformed header → read-only");

	// turn 5: valid header, MODE absent → read-only.
	tools = await fire("PASEO_TEAM_TASK_V1\nOBJECTIVE: z2");
	assert.ok(!tools.includes("write"), "missing MODE → read-only");

	// turn 6: legacy V1 write brief still works.
	tools = await fire("PASEO_TEAM_TASK_V1\nMODE: write\nOBJECTIVE: z3");
	assert.ok(tools.includes("write"), "V1 brief still grants write");

	if (prevRole === undefined) delete process.env.PASEO_PI_ROLE;
	else process.env.PASEO_PI_ROLE = prevRole;
}

// --- Extension lifecycle: peer tool_call backstop uses current-turn brief -----

{
	const { piStub, handlers } = makePiStub(["bash", "write", "edit", "read"]);

	const prevRole = process.env.PASEO_PI_ROLE;
	process.env.PASEO_PI_ROLE = "peer";
	const createExtension = await loadFreshExtension("lifecycle=2");
	createExtension(piStub);

	const before = requireHandler(handlers, "before_agent_start");
	const toolCall = requireHandler(handlers, "tool_call");
	const bash = async (command: string) =>
		toolCall({ toolName: "bash", input: { command } });

	// V1 brief (no authority fields) → commit/push blocked from bash.
	await before({
		prompt: "PASEO_TEAM_TASK_V1\nMODE: write",
		systemPrompt: "base",
	});
	assert.match(
		(await bash("git commit -m x"))?.reason ?? "",
		/COMMIT_AUTHORITY/,
		"V1 brief does not grant commit authority",
	);
	assert.match(
		(await bash("git push origin b"))?.reason ?? "",
		/PUSH_TASK_BRANCH_AUTHORITY/,
	);
	assert.equal(await bash("git status"), undefined, "git status passes");

	// V2 brief with authorities → commit/push pass, force-push/merge blocked.
	await before({
		prompt:
			"PASEO_TEAM_TASK_V2\nMODE: write\nCOMMIT_AUTHORITY: allowed\nPUSH_TASK_BRANCH_AUTHORITY: allowed",
		systemPrompt: "base",
	});
	assert.equal(await bash("git commit -m x"), undefined);
	assert.equal(await bash("git push origin task/t-1"), undefined);
	assert.match(
		(await bash("git push --force origin task/t-1"))?.reason ?? "",
		/FORCE_PUSH/,
	);
	assert.match((await bash("git merge main"))?.reason ?? "", /MERGE_AUTHORITY/);

	// Next unbriefed turn → authorities reset (fail-closed).
	await before({ prompt: "thanks, one more thing", systemPrompt: "base" });
	assert.match(
		(await bash("git commit -m x"))?.reason ?? "",
		/COMMIT_AUTHORITY/,
		"authority does not leak to the next unbriefed turn",
	);

	// Correction via real Paseo send (peer receives prompt without header):
	// mcp proxy always blocked for peers.
	assert.match(
		(await toolCall({ toolName: "mcp", input: { tool: "list_agents" } }))
			?.reason ?? "",
		/MCP proxy/,
	);

	if (prevRole === undefined) delete process.env.PASEO_PI_ROLE;
	else process.env.PASEO_PI_ROLE = prevRole;
}

// --- Extension lifecycle: supervisor MCP guard via tool_call -------------------

{
	const { piStub, handlers } = makePiStub(["read", "mcp"]);

	const prevRole = process.env.PASEO_PI_ROLE;
	process.env.PASEO_PI_ROLE = "supervisor";
	const createExtension = await loadFreshExtension("lifecycle=3");
	createExtension(piStub);

	const toolCall = requireHandler(handlers, "tool_call");
	const mcp = async (input: unknown) => toolCall({ toolName: "mcp", input });
	const call = async (target: string) => mcp({ tool: target, args: {} });
	const reasonOf = async (
		pending: Promise<{ block?: boolean; reason?: string } | undefined>,
	): Promise<string> => (await pending)?.reason ?? "";

	assert.equal(await mcp({ connect: "paseo" }), undefined, "connect passes");
	assert.equal(await mcp({ search: "agents" }), undefined, "search passes");
	assert.equal(await call("list_agents"), undefined);
	assert.equal(await call("paseo_get_agent_activity"), undefined);
	assert.match(await reasonOf(call("create_terminal")), /monitoring tools/);
	assert.match(await reasonOf(call("paseo_update_agent")), /blocked/);
	assert.match(
		await reasonOf(mcp({ tool: "" })),
		/non-string|missing/,
		"empty tool target → fail-closed",
	);
	assert.match(
		await reasonOf(mcp({ frobnicate: true })),
		/determinable target/,
	);
	assert.match(await reasonOf(mcp(null)), /not an object/);
	assert.match(
		(await toolCall({ toolName: "write", input: {} }))?.reason ?? "",
		/Supervisor cannot modify product code/,
	);

	if (prevRole === undefined) delete process.env.PASEO_PI_ROLE;
	else process.env.PASEO_PI_ROLE = prevRole;
}

// --- Extension lifecycle: supervisor mcp_script backstop ----------------------

{
	const { piStub, handlers } = makePiStub(["read", "mcp", "mcp_script"]);

	const prevRole = process.env.PASEO_PI_ROLE;
	process.env.PASEO_PI_ROLE = "supervisor";
	const createExtension = await loadFreshExtension("lifecycle=4");
	createExtension(piStub);

	const toolCall = requireHandler(handlers, "tool_call");
	const script = async (code: string) =>
		toolCall({ toolName: "mcp_script", input: { code } });

	assert.equal(
		await script("const r = await tools.paseo_list_agents(); emit(r);"),
		undefined,
		"monitoring call passes",
	);
	assert.match(
		(await script("await tools.paseo_create_agent({ provider: 'pi-peer/x' });"))
			?.reason ?? "",
		/allowlist/,
		"supervisor cannot create agents via mcp_script backstop",
	);
	assert.match(
		(await script('await tools.call("paseo_create_terminal", {});'))?.reason ??
			"",
		/allowlist/,
	);

	if (prevRole === undefined) delete process.env.PASEO_PI_ROLE;
	else process.env.PASEO_PI_ROLE = prevRole;
}

// --- Extension lifecycle: peer MODE write + EDIT denied strips write tools ----

{
	const activeTools: string[] = [];
	const { piStub, handlers } = makePiStub(
		["read", "write", "edit", "bash"],
		activeTools,
	);

	const prevRole = process.env.PASEO_PI_ROLE;
	process.env.PASEO_PI_ROLE = "peer";
	const createExtension = await loadFreshExtension("lifecycle=5");
	createExtension(piStub);

	const before = requireHandler(handlers, "before_agent_start");
	const toolCall = requireHandler(handlers, "tool_call");

	// V3 write brief with full authority → write tools active.
	await before({ prompt: v3WriteBrief, systemPrompt: "base" });
	assert.ok(activeTools.includes("write"), "V3 write brief grants write");

	// V3 write brief with EDIT_AUTHORITY denied → write/edit stripped.
	await before({
		prompt:
			"PASEO_TEAM_TASK_V3_BEGIN\nMODE: write\nEDIT_AUTHORITY: denied\nCOMMIT_AUTHORITY: allowed\nPASEO_TEAM_TASK_V3_END\n",
		systemPrompt: "base",
	});
	assert.ok(
		!activeTools.includes("write") && !activeTools.includes("edit"),
		"EDIT_AUTHORITY denied strips write tools even with MODE: write",
	);
	assert.match(
		(await toolCall({ toolName: "edit", input: {} }))?.reason ?? "",
		/EDIT_AUTHORITY/,
		"backstop blocks edit with explicit EDIT_AUTHORITY reason",
	);

	if (prevRole === undefined) delete process.env.PASEO_PI_ROLE;
	else process.env.PASEO_PI_ROLE = prevRole;
}

console.log("[paseo-team] policy tests passed");

// policy.test.mts — unit tests for the role policy pure functions.
// Run: node test/policy.test.mts   (node >= 23.6 runs .ts natively)

import assert from "node:assert/strict";
import {
	ALL_PASEO_TOOLS,
	callsPaseoCli,
	denyReason,
	isSupervisorAllowedMcpTarget,
	parsePeerMode,
	policyFor,
} from "../extensions/paseo-team-policy.ts";

// --- parsePeerMode ----------------------------------------------------------

assert.equal(
	parsePeerMode("PASEO_TEAM_TASK_V1\n\nMODE: write\n\nOBJECTIVE: x"),
	"write",
);
assert.equal(parsePeerMode("MODE: write\nmore content"), "write");
assert.equal(parsePeerMode("MODE: read-only"), "read-only");
assert.equal(parsePeerMode("MOD E: write"), null);
assert.equal(parsePeerMode("no mode here"), null);
assert.equal(
	parsePeerMode("X MODE: write"),
	null,
	"MODE must be line-anchored",
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

const lead = policyFor("lead", "read-only");
assert.ok(
	ALL_PASEO_TOOLS.every((t) => lead.allow.includes(t)),
	"lead allows all paseo tools",
);
assert.ok(
	lead.allow.includes("mcp") && lead.allow.includes("mcp_script"),
	"lead keeps the MCP proxy tools",
);
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

// --- isSupervisorAllowedMcpTarget -------------------------------------------

assert.equal(isSupervisorAllowedMcpTarget("list_agents"), true);
assert.equal(isSupervisorAllowedMcpTarget("paseo_list_agents"), true);
assert.equal(isSupervisorAllowedMcpTarget("get_agent_status"), true);
assert.equal(isSupervisorAllowedMcpTarget("send_agent_prompt"), true);
assert.equal(isSupervisorAllowedMcpTarget("create_agent"), false);
assert.equal(isSupervisorAllowedMcpTarget("paseo_create_agent"), false, "prefixed form");
assert.equal(isSupervisorAllowedMcpTarget("create_terminal"), false, "no terminal access");
assert.equal(isSupervisorAllowedMcpTarget("paseo_create_terminal"), false);
assert.equal(isSupervisorAllowedMcpTarget("start_workspace_script"), false);
assert.equal(isSupervisorAllowedMcpTarget("create_schedule"), false);
assert.equal(isSupervisorAllowedMcpTarget("list_providers"), false, "no discovery");
assert.equal(isSupervisorAllowedMcpTarget("unknown_tool"), false, "fail-closed on unknown");

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

console.log("[paseo-team] policy tests passed");

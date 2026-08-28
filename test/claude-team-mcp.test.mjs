// claude-team-mcp.test.mjs — the stdio MCP server that gives Claude the two
// team tools the Pi extension registers natively.
//
// The role gate is the point: peer_ask_lead must reach only a Peer's Lead, and
// team_watchdog must stay with Lead/Supervisor, whether or not the PreToolUse
// hook is installed. The transport is hand-rolled (zero deps), so the JSON-RPC
// framing is pinned here too.

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { callTeamTool, handleMessage, TEAM_TOOLS, SERVER_NAME } from "../scripts/claude-team-mcp.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const serverPath = join(root, "scripts", "claude-team-mcp.mjs");

// --- protocol -----------------------------------------------------------------

{
	const initialized = await handleMessage({
		jsonrpc: "2.0",
		id: 1,
		method: "initialize",
		params: { protocolVersion: "2025-06-18", capabilities: {} },
	});
	assert.equal(initialized.result.serverInfo.name, SERVER_NAME);
	assert.equal(initialized.result.protocolVersion, "2025-06-18");
	assert.ok(initialized.result.capabilities.tools);

	// Notifications carry no id and must never be answered.
	assert.equal(await handleMessage({ jsonrpc: "2.0", method: "notifications/initialized" }), null);

	const listed = await handleMessage({ jsonrpc: "2.0", id: 2, method: "tools/list" });
	// Parity with the Pi extension's registerTeamTools: a tool that exists on one
	// runtime and not the other is a capability the other runtime silently lacks.
	assert.deepEqual(
		listed.result.tools.map((tool) => tool.name).sort(),
		["peer_ask_lead", "team_chat", "team_fork", "team_lease", "team_watchdog"],
	);
	for (const tool of listed.result.tools) {
		assert.equal(tool.inputSchema.type, "object");
		assert.ok(tool.description.length > 0);
	}

	const unknown = await handleMessage({ jsonrpc: "2.0", id: 3, method: "does/not/exist" });
	assert.equal(unknown.error.code, -32601);
	const badCall = await handleMessage({ jsonrpc: "2.0", id: 4, method: "tools/call", params: {} });
	assert.equal(badCall.error.code, -32602);
	assert.equal(await handleMessage(null), null);
}

// --- role gate ----------------------------------------------------------------

{
	const peerOnly = await callTeamTool("peer_ask_lead", { kind: "question", message: "x" }, {
		PASEO_PI_ROLE: "lead",
	});
	assert.equal(peerOnly.isError, true);
	assert.match(peerOnly.content[0].text, /only to peer agents/);

	const leadOnly = await callTeamTool("team_watchdog", {}, { PASEO_PI_ROLE: "peer" });
	assert.equal(leadOnly.isError, true);
	assert.match(leadOnly.content[0].text, /only to lead or supervisor agents/);

	// No role at all is not a free pass.
	const unset = await callTeamTool("team_watchdog", {}, {});
	assert.equal(unset.isError, true);
	assert.match(unset.content[0].text, /PASEO_PI_ROLE=unset/);

	const unknownTool = await callTeamTool("rm_rf", {}, { PASEO_PI_ROLE: "lead" });
	assert.equal(unknownTool.isError, true);
	assert.match(unknownTool.content[0].text, /Unknown tool/);
}

// Every tool declares which roles may call it, and both are covered.
assert.deepEqual(
	TEAM_TOOLS.map((tool) => [tool.name, tool.roles]).sort(),
	[
		["peer_ask_lead", ["peer"]],
		["team_chat", ["lead", "supervisor"]],
		["team_fork", ["lead", "supervisor"]],
		["team_lease", ["lead", "supervisor"]],
		["team_watchdog", ["lead", "supervisor"]],
	],
);

// --- end to end over stdio ----------------------------------------------------

{
	const stdout = execFileSync(process.execPath, [serverPath], {
		encoding: "utf8",
		env: { ...process.env, PASEO_PI_ROLE: "peer" },
		input: [
			JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }),
			JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
			JSON.stringify({ jsonrpc: "2.0", id: 2, method: "ping" }),
			"not json at all",
			JSON.stringify({ jsonrpc: "2.0", id: 3, method: "tools/list" }),
			"",
		].join("\n"),
	});
	const messages = stdout.trim().split(/\r?\n/).map((line) => JSON.parse(line));
	assert.deepEqual(messages.map((message) => message.id), [1, 2, null, 3]);
	assert.equal(messages[2].error.code, -32700, "a malformed line is answered, not fatal");
	assert.equal(messages[3].result.tools.length, TEAM_TOOLS.length);
}

// The Pi extension takes this text from policy-core's teamChatToolDescription();
// this file is plain .mjs and cannot import the .ts core, so the string is
// mirrored — and drift between the two runtimes is exactly what this pack's
// parity tests exist to catch.
{
	const { teamChatToolDescription } = await import("../extensions/paseo-team-core/policy-core.ts");
	const chat = TEAM_TOOLS.find((tool) => tool.name === "team_chat");
	assert.equal(
		chat.description,
		teamChatToolDescription(),
		"the Claude tool description must not drift from the shared one",
	);
	assert.ok(
		!/only sanctioned/i.test(chat.description),
		"and must not overstate closure: the bash rules are heuristics, not a boundary",
	);

	// The payload ceiling exists in three unlinked copies for the same reason the
	// description does: this file cannot import the .ts core, and team-chat.mjs is
	// a separate process. Only team-chat.mjs ENFORCES it — the other two advertise
	// it — so drift would leave a schema promising more than the tool accepts.
	// Same parity rule for the lease tool: one description, two runtimes.
	const lease = TEAM_TOOLS.find((tool) => tool.name === "team_lease");
	const { teamLeaseToolDescription } = await import("../extensions/paseo-team-core/policy-core.ts");
	assert.equal(lease.description, teamLeaseToolDescription(), "the lease description must not drift either");

	const { TEAM_CHAT_MAX_BODY_BYTES: coreCeiling } = await import("../extensions/paseo-team-core/policy-core.ts");
	const { MAX_BODY_BYTES: enforcedCeiling } = await import("../scripts/team-chat.mjs");
	assert.equal(chat.inputSchema.properties.message.maxLength, enforcedCeiling, "the Claude schema advertises what team-chat.mjs enforces");
	assert.equal(coreCeiling, enforcedCeiling, "and so does the shared core");

	// Same parity rule for the fork tool, and one more for its reason set: the
	// enum in this schema is what a Claude Lead can even ASK for, so a reason
	// the core accepts but the schema omits is a capability this runtime lacks.
	const fork = TEAM_TOOLS.find((tool) => tool.name === "team_fork");
	const { teamForkToolDescription, FORK_REASONS } = await import("../extensions/paseo-team-core/policy-core.ts");
	assert.equal(fork.description, teamForkToolDescription(), "the fork description must not drift either");
	assert.deepEqual(
		[...fork.inputSchema.properties.reason.enum].sort(),
		[...FORK_REASONS].sort(),
		"the advertised fork reasons must be exactly the ones the core accepts",
	);
}

console.log("claude team mcp tests passed");

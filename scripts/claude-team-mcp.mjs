// claude-team-mcp.mjs — stdio MCP server exposing the pack's team tools
// to Claude Code, which has no extension API to register tools directly.
//
// Pi gets `peer_ask_lead`, `team_watchdog` and `team_chat` from the policy
// extension (registerTeamTools). Claude gets the SAME tools from this server, with
// the same role gate and the same underlying support scripts, so a Peer talks
// to its Lead identically on both runtimes. Claude sees them as
// `mcp__paseo-team__peer_ask_lead` / `__team_watchdog` / `__team_chat`.
//
// Zero dependencies on purpose (the pack ships no runtime deps): this speaks
// the MCP stdio framing — one JSON-RPC message per line — directly.
//
// Register with:
//   claude mcp add --scope user paseo-team -- node <this file>
// or through `pteam claude-setup`, which does it for you.

import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { createInterface } from "node:readline";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { isEntrypoint } from "./lib-common.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
export const SERVER_NAME = "paseo-team";
export const SERVER_VERSION = "1.0.0";
const DEFAULT_PROTOCOL_VERSION = "2025-06-18";

export const TEAM_TOOLS = [
	{
		name: "peer_ask_lead",
		description:
			"Send a question, blocker, dependency request, or progress update to this Peer's parent Lead only.",
		roles: ["peer"],
		script: "team-communication.mjs",
		timeoutMs: 30_000,
		buildArgs: (params) => ["ask-lead", JSON.stringify(params ?? {})],
		inputSchema: {
			type: "object",
			properties: {
				kind: {
					type: "string",
					enum: ["question", "blocked", "dependency", "progress"],
				},
				message: { type: "string", minLength: 1, maxLength: 12000 },
				taskId: { type: "string" },
				correlationId: { type: "string" },
			},
			required: ["kind", "message"],
			additionalProperties: false,
		},
	},
	{
		name: "team_watchdog",
		description:
			"Inspect running Paseo agents and report suspected stale agents. Observation only; never cancels or replaces agents.",
		roles: ["lead", "supervisor"],
		script: "watchdog.mjs",
		timeoutMs: 130_000,
		buildArgs: (params) => [JSON.stringify(params ?? {})],
		inputSchema: {
			type: "object",
			properties: {
				staleAfterMs: { type: "integer", minimum: 1000, maximum: 86400000 },
				maxAgents: { type: "integer", minimum: 1, maximum: 200 },
				concurrency: { type: "integer", minimum: 1, maximum: 16 },
				globalDeadlineMs: { type: "integer", minimum: 1000, maximum: 120000 },
				commandTimeoutMs: { type: "integer", minimum: 250, maximum: 30000 },
			},
			additionalProperties: false,
		},
	},
	{
		name: "team_chat",
		// Mirrors policy-core's teamChatToolDescription(). This file is plain .mjs
		// and cannot import the TypeScript core, so the text is duplicated and
		// claude-team-mcp.test.mjs asserts the two never drift. Deliberately does
		// NOT claim the chat surface is sealed: the bash rules are heuristics and
		// rooms are unrestricted unless PASEO_TEAM_ROOMS is set.
		description:
			"Coordinate with other Leads and Supervisors through a Paseo chat room. `post` delivers a TEAM_MESSAGE_V1 envelope and wakes each recipient by mention; `read` returns the room with envelopes parsed; `rooms` lists rooms. Recipients are agent ids/short-ids, or 'domain:<name>' to reach every agent carrying that domain label. Use this instead of the Paseo chat CLI, which the bash guard redirects here. Rooms are unrestricted unless PASEO_TEAM_ROOMS is set.",
		roles: ["lead", "supervisor"],
		script: "team-chat.mjs",
		timeoutMs: 30_000,
		// `rooms` takes no payload; post/read carry theirs as one JSON argument,
		// matching how the Pi extension invokes the same script.
		buildArgs: (params) => {
			const { action, ...rest } = params ?? {};
			const command = action === "post" ? "post" : action === "read" ? "read" : "rooms";
			return command === "rooms" ? [command] : [command, JSON.stringify(rest)];
		},
		inputSchema: {
			type: "object",
			properties: {
				action: { type: "string", enum: ["post", "read", "rooms"] },
				room: { type: "string", maxLength: 128 },
				kind: {
					type: "string",
					enum: ["handoff", "dependency", "claim", "release", "question", "decision", "progress"],
				},
				topic: { type: "string", maxLength: 128 },
				message: { type: "string", minLength: 1, maxLength: 8192 },
				to: { type: "array", items: { type: "string", maxLength: 136 }, minItems: 1, maxItems: 64 },
				correlationId: { type: "string", maxLength: 128 },
				replyTo: { type: "string", maxLength: 128 },
				hop: { type: "integer", minimum: 0, maximum: 7 },
				ttl: { type: "integer", minimum: 1, maximum: 8 },
				since: { type: "string", maxLength: 64 },
				limit: { type: "integer", minimum: 1, maximum: 500 },
			},
			required: ["action"],
			additionalProperties: false,
		},
	},
];

/** Same two-candidate resolution the Pi extension uses for support scripts. */
export function supportScriptPath(name, env = process.env) {
	const configured = env.PASEO_TEAM_SCRIPTS_DIR?.trim();
	const candidates = configured ? [join(configured, name)] : [join(HERE, name)];
	const found = candidates.find((candidate) => existsSync(candidate));
	if (!found) {
		throw new Error(`Paseo team support script is missing: ${name}`);
	}
	return found;
}

export function runSupportScript(name, args, timeoutMs = 30_000, env = process.env) {
	return new Promise((resolve) => {
		execFile(
			process.execPath,
			[supportScriptPath(name, env), ...args],
			{ encoding: "utf8", timeout: timeoutMs, windowsHide: true, env },
			(error, stdout, stderr) => {
				resolve({
					stdout: String(stdout ?? ""),
					stderr: String(stderr ?? ""),
					code: error ? 1 : 0,
				});
			},
		);
	});
}

function toolListPayload() {
	return {
		tools: TEAM_TOOLS.map(({ name, description, inputSchema }) => ({
			name,
			description,
			inputSchema,
		})),
	};
}

function textResult(text, isError = false) {
	return { content: [{ type: "text", text }], isError };
}

/**
 * Role gate, mirroring the Pi extension exactly. The PreToolUse hook already
 * denies these calls for the wrong role; this is the same rule enforced at the
 * other end, so the tools stay safe even if the hook is not installed.
 */
export async function callTeamTool(name, params, env = process.env) {
	const tool = TEAM_TOOLS.find((candidate) => candidate.name === name);
	if (!tool) return textResult(`Unknown tool: ${name}`, true);
	const role = env.PASEO_PI_ROLE?.trim().toLowerCase() ?? "";
	if (!tool.roles.includes(role)) {
		return textResult(
			`${name} is available only to ${tool.roles.join(" or ")} agents (PASEO_PI_ROLE=${role || "unset"}).`,
			true,
		);
	}
	const result = await runSupportScript(
		tool.script,
		tool.buildArgs(params),
		tool.timeoutMs,
		env,
	);
	return textResult(result.stdout || result.stderr, result.code !== 0);
}

/**
 * Handle one JSON-RPC request. Returns the response object, or null for
 * notifications (which must never be answered).
 */
export async function handleMessage(message, env = process.env) {
	if (typeof message !== "object" || message === null) return null;
	const { id, method, params } = message;
	const isNotification = id === undefined || id === null;
	const reply = (result) => (isNotification ? null : { jsonrpc: "2.0", id, result });
	const fail = (code, msg) =>
		isNotification ? null : { jsonrpc: "2.0", id, error: { code, message: msg } };

	switch (method) {
		case "initialize": {
			const requested = params?.protocolVersion;
			return reply({
				protocolVersion:
					typeof requested === "string" ? requested : DEFAULT_PROTOCOL_VERSION,
				capabilities: { tools: { listChanged: false } },
				serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
			});
		}
		case "notifications/initialized":
		case "notifications/cancelled":
			return null;
		case "ping":
			return reply({});
		case "tools/list":
			return reply(toolListPayload());
		case "tools/call": {
			const name = params?.name;
			if (typeof name !== "string") {
				return fail(-32602, "tools/call requires a string name");
			}
			try {
				return reply(await callTeamTool(name, params?.arguments, env));
			} catch (error) {
				return reply(textResult(`${name} failed: ${error?.message ?? error}`, true));
			}
		}
		default:
			return fail(-32601, `Method not found: ${method}`);
	}
}

export async function main(env = process.env) {
	const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
	for await (const line of rl) {
		const text = line.trim();
		if (!text) continue;
		let message;
		try {
			message = JSON.parse(text);
		} catch {
			process.stdout.write(
				`${JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } })}\n`,
			);
			continue;
		}
		const response = await handleMessage(message, env);
		if (response) process.stdout.write(`${JSON.stringify(response)}\n`);
	}
}

if (isEntrypoint(import.meta.url, process.argv[1])) {
	await main();
}

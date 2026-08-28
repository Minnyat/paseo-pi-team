/**
 * paseo-team-policy.ts — Pi adapter for the Paseo team role pack.
 *
 * Reads PASEO_PI_ROLE (supervisor | lead | peer) from the environment and:
 *   - injects the role prompt (prompts/<role>.md) into the system prompt;
 *   - applies a per-role tool allowlist via setActiveTools();
 *   - blocks policy-violating tool calls as a backstop via tool_call.
 *
 * Every RULE lives in ./paseo-team-core/policy-core.ts, which knows nothing about Pi; this
 * file only binds those rules to Pi's extension API and re-exports the core so
 * existing importers (tests, tooling) keep one entry point. The Claude Code
 * adapter binds the SAME core through settings hooks — see
 * ./paseo-team-core/claude-policy.ts and scripts/claude-hook.mjs.
 *
 * When PASEO_PI_ROLE is unset the extension stays passive: no prompt
 * injection, no tool restriction. Safe to install globally.
 *
 * Fail-closed invariants (Phase 3):
 *   - Peer write authority is derived from the *current prompt's* strict
 *     V3 task brief (PASEO_TEAM_TASK_V3_BEGIN/END marker block) on every
 *     before_agent_start. Legacy V1/V2 briefs are parseable for diagnostics
 *     but NEVER grant write mode or git authority (their whole-prompt scan
 *     was an injection surface). A turn without a valid V3 brief is
 *     read-only — write mode never leaks across turns.
 *   - Peer git authority (commit/push) comes from V3 authority fields and
 *     is denied by default; force-push and merge are always denied, and
 *     granted push authority is branch-scoped to agent/<TASK_ID>.
 *   - Supervisor and Lead MCP proxy calls are checked against a fail-closed
 *     target allowlist. Anything that cannot be classified (missing or
 *     non-string tool target, unknown input shape) is blocked.
 *
 * Prompts are resolved from $PASEO_TEAM_PROMPTS_DIR or, by default, from a
 * `prompts/` directory next to this file (the installer copies them there).
 * Extra per-profile tools can be added via $PASEO_TEAM_EXTRA_TOOLS="a,b".
 * Lead gets write/edit tools only when $PASEO_TEAM_LEAD_WRITE=1 (documented
 * opt-in; orchestration work does not need them).
 */

import {
	isToolCallEventType,
	type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import { execFile } from "node:child_process";
import { existsSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
	ALL_PASEO_TOOLS,
	browserMcpAllowed,
	callsAgentBrowserCli,
	callsPaseoCli,
	denyReason,
	detectRole,
	extraTools,
	gitAuthorityBlockReason,
	isAgentBrowserMcpTarget,
	loadRolePrompt,
	mcpBlockReason,
	mcpScriptBlockReason,
	parseTaskBrief,
	peerGitAuthority,
	peerMcpBlockReason,
	policyWithAuthority,
	resolvePeerMode,
	teamToolBlockReason,
	PEER_COMMUNICATION_TOOL,
	TEAM_WATCHDOG_TOOL,
	TEAM_CHAT_TOOL,
	TEAM_CHAT_MAX_BODY_BYTES,
	TEAM_MESSAGE_KIND_NAMES,
	coordinationCliBlockReason,
	supportScriptBlockReason,
	teamChatToolBlockReason,
	teamChatToolDescription,
	type ParsedTaskBrief,
	type PeerMode,
	type Policy,
	type TeamRole,
} from "./paseo-team-core/policy-core.ts";

/**
 * Re-export the whole core so `paseo-team-policy.ts` stays the single import
 * surface for tests and tooling that predate the core split.
 */
export * from "./paseo-team-core/policy-core.ts";

function supportScriptPath(name: string): string {
	const configured = process.env.PASEO_TEAM_SCRIPTS_DIR?.trim();
	const candidates = configured
		? [join(configured, name)]
		: [
				join(dirname(fileURLToPath(import.meta.url)), "paseo-team-scripts", name),
				join(dirname(fileURLToPath(import.meta.url)), "../scripts", name),
			];
		const found = candidates.find((candidate) => existsSync(candidate));
	if (!found) throw new Error(`Paseo team support script is missing: ${name}`);
	return found;
}

function runSupportScript(name: string, args: string[], signal?: AbortSignal, timeoutMs = 30_000): Promise<{ stdout: string; stderr: string; code: number; killed: boolean }> {
	return new Promise((resolve, reject) => {
		execFile(
			process.execPath,
			[supportScriptPath(name), ...args],
			{ encoding: "utf8", timeout: timeoutMs, windowsHide: true, env: process.env, signal },
			(error, stdout, stderr) => {
				if (error && !stdout && !stderr) reject(error);
				else resolve({ stdout: String(stdout ?? ""), stderr: String(stderr ?? ""), code: error ? 1 : 0, killed: Boolean(error?.killed) });
			},
		);
	});
}

function registerTeamTools(pi: ExtensionAPI, r: TeamRole): void {
	if (typeof pi.registerTool !== "function") return;
	pi.registerTool({
		name: PEER_COMMUNICATION_TOOL,
		label: "peer_ask_lead",
		description: "Send a question, blocker, dependency request, or progress update to this Peer’s parent Lead only.",
		parameters: {
			type: "object",
			properties: {
				kind: { type: "string", enum: ["question", "blocked", "dependency", "progress"] },
				message: { type: "string", minLength: 1, maxLength: 12000 },
				taskId: { type: "string" },
				correlationId: { type: "string" },
			},
			required: ["kind", "message"],
			additionalProperties: false,
		} as any,
		async execute(_id, params, signal, _onUpdate, _ctx) {
			if (r !== "peer") return { content: [{ type: "text", text: "peer_ask_lead is available only to Peer agents." }], details: undefined, isError: true };
			const result = await runSupportScript("team-communication.mjs", ["ask-lead", JSON.stringify(params)], signal);
			return { content: [{ type: "text", text: result.stdout || result.stderr }], details: undefined, isError: result.code !== 0 };
		},
	});
	pi.registerTool({
		name: TEAM_WATCHDOG_TOOL,
		label: "team_watchdog",
		description: "Inspect running Paseo agents and report suspected stale agents. Observation only; never cancels or replaces agents.",
		parameters: { type: "object", properties: { staleAfterMs: { type: "integer", minimum: 1000, maximum: 86400000 }, maxAgents: { type: "integer", minimum: 1, maximum: 200 }, concurrency: { type: "integer", minimum: 1, maximum: 16 }, globalDeadlineMs: { type: "integer", minimum: 1000, maximum: 120000 }, commandTimeoutMs: { type: "integer", minimum: 250, maximum: 30000 } }, additionalProperties: false } as any,
		async execute(_id, params, signal, _onUpdate, _ctx) {
			if (r !== "lead" && r !== "supervisor") return { content: [{ type: "text", text: "team_watchdog is available only to Lead or Supervisor agents." }], details: undefined, isError: true };
			const result = await runSupportScript("watchdog.mjs", [JSON.stringify(params ?? {})], signal, 130_000);
			return { content: [{ type: "text", text: result.stdout || result.stderr }], details: undefined, isError: result.code !== 0 };
		},
	});
	pi.registerTool({
		name: TEAM_CHAT_TOOL,
		label: "team_chat",
		description: teamChatToolDescription(),
		parameters: {
			type: "object",
			properties: {
				action: { type: "string", enum: ["post", "read", "rooms"] },
				room: { type: "string", maxLength: 128 },
				kind: { type: "string", enum: [...TEAM_MESSAGE_KIND_NAMES] },
				topic: { type: "string", maxLength: 128 },
				message: { type: "string", minLength: 1, maxLength: TEAM_CHAT_MAX_BODY_BYTES },
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
		} as any,
		async execute(_id, params, signal, _onUpdate, _ctx) {
			const blocked = teamChatToolBlockReason(r, TEAM_CHAT_TOOL);
			if (blocked) return { content: [{ type: "text", text: blocked }], details: undefined, isError: true };
			const { action, ...rest } = (params ?? {}) as Record<string, unknown>;
			const command = action === "post" ? "post" : action === "read" ? "read" : "rooms";
			const args = command === "rooms" ? [command] : [command, JSON.stringify(rest)];
			const result = await runSupportScript("team-chat.mjs", args, signal);
			return { content: [{ type: "text", text: result.stdout || result.stderr }], details: undefined, isError: result.code !== 0 };
		},
	});
}

// ---------------------------------------------------------------------------
// Per-turn peer state — recomputed from the *current* prompt on every
// before_agent_start. Never sticky across turns.
// ---------------------------------------------------------------------------

let currentBrief: ParsedTaskBrief | null = null;

function currentPeerMode(): PeerMode {
	return resolvePeerMode(currentBrief);
}


function currentPolicy(r: TeamRole): Policy {
	return policyWithAuthority(r, currentPeerMode(), currentBrief);
}

function applyPolicy(pi: ExtensionAPI, r: TeamRole): Policy {
	const registered = new Set(pi.getAllTools().map((t) => t.name));
	const policy = currentPolicy(r);
	const browserTools =
		r === "peer" && browserMcpAllowed(currentBrief)
			? [...registered].filter(isAgentBrowserMcpTarget)
			: [];
	const allowed = [
		...new Set([...policy.allow, ...browserTools, ...extraTools()]),
	].filter((name) => registered.has(name));
	pi.setActiveTools(allowed);
	return policy;
}

function describePolicy(p: Policy): string {
	return `allow=[${p.allow.join(", ")}] deny=[${p.deny.join(", ")}]`;
}

// ---------------------------------------------------------------------------
// Debug commands
// ---------------------------------------------------------------------------

function registerDebugCommands(pi: ExtensionAPI, r: TeamRole | undefined) {
	pi.registerCommand("team-role", {
		description: "Show the active Paseo team role and its tool policy",
		handler: async (_args, ctx) => {
			if (!r) {
				ctx.ui.notify(
					"PASEO_PI_ROLE is unset — extension is passive (no restrictions).",
					"warning",
				);
				return;
			}
			const briefInfo = currentBrief
				? `brief=V${currentBrief.version} mode=${currentBrief.mode ?? "invalid"}${
						currentBrief.malformed.length
							? ` malformed=[${currentBrief.malformed.join("; ")}]`
							: ""
					}`
				: "brief=none";
			const p = currentPolicy(r);
			ctx.ui.notify(
				`role=${r} peerMode=${currentPeerMode()} ${briefInfo}\n${describePolicy(p)}`,
				"info",
			);
		},
	});

	pi.registerCommand("team-tools", {
		description: "List all registered tools with source and active state",
		handler: async (_args, ctx) => {
			const all = pi.getAllTools();
			const active = new Set(pi.getActiveTools());
			const rows = all.map((t) => {
				const state = active.has(t.name) ? "active  " : "inactive";
				const source = t.sourceInfo?.source ?? "unknown";
				return `${state} ${t.name.padEnd(32)} source=${source}`;
			});
			const text = [
				`role: ${r ?? "none"}`,
				`peerMode: ${currentPeerMode()}`,
				`tools: ${all.length} registered, ${active.size} active`,
				...rows,
			].join("\n");
			console.log(`[paseo-team] /team-tools\n${text}`);
			const dumpPath = join(homedir(), ".pi", "team-tools.txt");
			writeFileSync(dumpPath, `${text}\n`, "utf8");
			ctx.ui.notify(`team-tools: ${all.length} tools -> ${dumpPath}`, "info");
		},
	});
}

// ---------------------------------------------------------------------------
// Extension entry
// ---------------------------------------------------------------------------

export default function (pi: ExtensionAPI) {
	const activeRole = detectRole();
	if (!activeRole) {
		console.log("[paseo-team] PASEO_PI_ROLE unset — extension passive");
		registerDebugCommands(pi, undefined);
		return;
	}
	const r: TeamRole = activeRole;
	registerTeamTools(pi, r);

	console.log(
		`[paseo-team] role=${r} peerMode=${currentPeerMode()} policy=${describePolicy(currentPolicy(r))}`,
	);

	pi.on("session_start", () => {
		currentBrief = null;
		applyPolicy(pi, r);
	});

	pi.on("before_agent_start", async (event) => {
		if (r === "peer") {
			// Recompute authority from THIS prompt — never inherit from an
			// earlier turn. Missing/malformed brief → read-only.
			currentBrief = parseTaskBrief(event.prompt);
			if (currentBrief?.malformed.length) {
				console.warn(
					`[paseo-team] malformed task brief → read-only: ${currentBrief.malformed.join("; ")}`,
				);
			}
		}
		applyPolicy(pi, r);
		const rolePrompt = loadRolePrompt(r);
		if (!rolePrompt) return;
		return {
			systemPrompt: `${event.systemPrompt}\n\n## Paseo Team Role\n${rolePrompt}`,
		};
	});

	pi.on("tool_call", async (event) => {
		const peerMode = currentPeerMode();
		const policy = currentPolicy(r);
		if (
			r === "peer" &&
			isAgentBrowserMcpTarget(event.toolName) &&
			!browserMcpAllowed(currentBrief)
		) {
			return {
				block: true,
				reason:
					"Direct agent-browser MCP tool is denied because BROWSER_MCP_AUTHORITY is not allowed in the current V3 brief.",
			};
		}
		const teamBlockReason = teamToolBlockReason(r, event.toolName, currentBrief);
		if (teamBlockReason) return { block: true, reason: teamBlockReason };
		if (policy.deny.includes(event.toolName)) {
			if (
				r === "peer" &&
				peerMode === "write" &&
				(event.toolName === "write" || event.toolName === "edit")
			) {
				return {
					block: true,
					reason:
						"EDIT_AUTHORITY is denied for this task even though MODE is write. Report AUTHORITY_MISMATCH to the Lead.",
				};
			}
			return {
				block: true,
				reason: denyReason(r, peerMode, event.toolName),
			};
		}
		if (isToolCallEventType("mcp", event)) {
			if (r === "peer") {
				const blockReason = peerMcpBlockReason(event.input, currentBrief);
				if (blockReason) return { block: true, reason: blockReason };
			}
			if (r === "supervisor" || r === "lead") {
				const blockReason = mcpBlockReason(r, event.input);
				if (blockReason) {
					return { block: true, reason: blockReason };
				}
			}
		}
		if (
			(r === "lead" || r === "supervisor") &&
			isToolCallEventType("mcp_script", event)
		) {
			const code = typeof event.input.code === "string" ? event.input.code : "";
			const blockReason = mcpScriptBlockReason(r, code);
			if (blockReason) {
				return { block: true, reason: blockReason };
			}
		}
		if ((r === "lead" || r === "supervisor") && isToolCallEventType("bash", event)) {
			const chatReason = coordinationCliBlockReason(r, event.input.command ?? "");
			if (chatReason) {
				return { block: true, reason: chatReason };
			}
		}
		if (r === "peer" && isToolCallEventType("bash", event)) {
			const command = event.input.command ?? "";
			if (callsPaseoCli(command)) {
				return {
					block: true,
					reason:
						"Peer cannot drive the Paseo CLI from bash (would bypass the tool policy). Report a DEPENDENCY_REQUEST to the Lead instead.",
				};
			}
			if (callsAgentBrowserCli(command)) {
				return {
					block: true,
					reason:
						"Peer cannot run agent-browser CLI through bash; BROWSER_MCP_AUTHORITY only permits the typed agent-browser MCP surface.",
				};
			}
			const supportScriptReason = supportScriptBlockReason(r, command);
			if (supportScriptReason) {
				return { block: true, reason: supportScriptReason };
			}
			const gitBlockReason = gitAuthorityBlockReason(
				command,
				peerGitAuthority(currentBrief),
				currentBrief?.fields.get("TASK_ID"),
			);
			if (gitBlockReason) {
				return { block: true, reason: gitBlockReason };
			}
		}
	});

	registerDebugCommands(pi, r);
}

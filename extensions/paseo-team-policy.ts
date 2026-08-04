/**
 * paseo-team-policy.ts — role policy extension for the Paseo + Pi team pack.
 *
 * Reads PASEO_PI_ROLE (supervisor | lead | peer) from the environment and:
 *   - injects the role prompt (prompts/<role>.md) into the system prompt;
 *   - applies a per-role tool allowlist via setActiveTools();
 *   - blocks policy-violating tool calls as a backstop via tool_call.
 *
 * When PASEO_PI_ROLE is unset the extension stays passive: no prompt
 * injection, no tool restriction. Safe to install globally.
 *
 * Prompts are resolved from $PASEO_TEAM_PROMPTS_DIR or, by default, from a
 * `prompts/` directory next to this file (the installer copies them there).
 * Extra per-profile tools can be added via $PASEO_TEAM_EXTRA_TOOLS="a,b".
 *
 * Policy tables below are the *initial* allowlists from the deep-dive plan
 * (Giai đoạn 4). Tune them after inspecting the real tool registry with
 * `/team-tools`, then lock them in.
 */

import {
	isToolCallEventType,
	type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// ---------------------------------------------------------------------------
// Role detection
// ---------------------------------------------------------------------------

export type TeamRole = "supervisor" | "lead" | "peer";
export type PeerMode = "write" | "read-only";

export function detectRole(): TeamRole | undefined {
	const raw = process.env.PASEO_PI_ROLE?.trim().toLowerCase();
	return raw === "supervisor" || raw === "lead" || raw === "peer"
		? raw
		: undefined;
}

export const role: TeamRole | undefined = detectRole();

// ---------------------------------------------------------------------------
// Tool policy tables
// ---------------------------------------------------------------------------

export const PASEO_TOOLS = {
	discovery: ["list_providers", "list_models", "inspect_provider"],
	workspace: ["create_workspace", "list_workspaces", "archive_workspace"],
	monitoring: ["list_agents", "get_agent_status", "get_agent_activity"],
	orchestration: [
		"create_agent",
		"send_agent_prompt",
		"update_agent",
		"cancel_agent",
		"archive_agent",
	],
} as const;

export const ALL_PASEO_TOOLS: string[] = [
	...PASEO_TOOLS.discovery,
	...PASEO_TOOLS.workspace,
	...PASEO_TOOLS.monitoring,
	...PASEO_TOOLS.orchestration,
];

const PI_READ_ONLY = ["read", "bash"];
const PI_WRITE = ["read", "write", "edit", "bash"];

/** pi-mcp-adapter proxy tools — Paseo tools are reached through the `mcp` tool. */
const MCP_TOOLS = ["mcp", "mcp_script"];

/**
 * Paseo tools the supervisor may call through the MCP proxy. Fail-closed:
 * anything else in the catalog (terminals, workspace scripts, schedules,
 * discovery, orchestration, ...) is blocked. send_agent_prompt is allowed so
 * the supervisor can deliver observations to the Lead.
 */
const SUPERVISOR_ALLOWED_MCP_TARGETS: string[] = [
	"list_agents",
	"get_agent_status",
	"get_agent_activity",
	"send_agent_prompt",
];

/**
 * Match a possibly-prefixed proxy tool name against known Paseo tool names.
 * Handles "paseo_list_providers" and "server:list_providers" forms without
 * mangling bare names like "list_providers" (whose first segment is part of
 * the name itself).
 */
export function matchesPaseoToolName(name: string, known: string[]): boolean {
	return (
		known.includes(name) ||
		known.some((t) => name.endsWith(`_${t}`) || name.endsWith(`:${t}`))
	);
}

export interface Policy {
	/** Pure allowlist applied via setActiveTools(). */
	allow: string[];
	/** Backstop names blocked in tool_call. */
	deny: string[];
}

export function policyFor(role: TeamRole, peerMode: PeerMode): Policy {
	switch (role) {
		case "lead":
			return {
				allow: [...PI_WRITE, ...ALL_PASEO_TOOLS, ...MCP_TOOLS],
				deny: [],
			};
		case "supervisor":
			return {
				allow: ["read", "mcp", ...PASEO_TOOLS.monitoring, "send_agent_prompt"],
				deny: ["write", "edit", ...ALL_PASEO_TOOLS],
			};
		case "peer":
			return peerMode === "write"
				? { allow: [...PI_WRITE], deny: [...ALL_PASEO_TOOLS, ...MCP_TOOLS] }
				: {
						allow: [...PI_READ_ONLY],
						deny: [...ALL_PASEO_TOOLS, ...MCP_TOOLS, "write", "edit"],
					};
	}
}

export function denyReason(
	role: TeamRole,
	peerMode: PeerMode,
	toolName: string,
): string {
	if (role === "peer" && (toolName === "mcp" || toolName === "mcp_script")) {
		return "Peer cannot use the MCP proxy (it would expose Paseo orchestration tools). Report a DEPENDENCY_REQUEST to the Lead instead.";
	}
	if (role === "peer" && matchesPaseoToolName(toolName, ALL_PASEO_TOOLS)) {
		return "Peer cannot orchestrate agents or manage workspaces. Report a DEPENDENCY_REQUEST to the Lead instead.";
	}
	if (
		role === "peer" &&
		peerMode !== "write" &&
		(toolName === "write" || toolName === "edit")
	) {
		return "This Peer session is read-only (MODE: read-only). Propose the change in your report instead of editing files.";
	}
	if (role === "supervisor" && (toolName === "write" || toolName === "edit")) {
		return "Supervisor cannot modify product code. Send an observation to the Lead instead.";
	}
	if (role === "supervisor") {
		return "Supervisor cannot create or manage agents or workspaces. Send an observation to the Lead instead.";
	}
	return `Tool "${toolName}" is blocked by the ${role} role policy.`;
}

// ---------------------------------------------------------------------------
// Bash CLI guard — peers must not drive Paseo from the shell to bypass the
// tool policy. Heuristic only; not an authorization boundary.
// ---------------------------------------------------------------------------

const PASEO_CLI_RE =
	/\b(paseo|paseo-pi|pio)(?:\.(?:cmd|exe|ps1|sh))?\s+(?:run|send|ls|agent|workspace|provider|schedule|heartbeat|daemon|status|attach|logs|stop|delete|archive|inspect|wait|import|clone|onboard|start|restart|hub|chat|terminal|script|loop|permit|speech|hooks|help)\b/i;

export function callsPaseoCli(command: string): boolean {
	return PASEO_CLI_RE.test(command);
}

// ---------------------------------------------------------------------------
// MCP proxy target guard — the `mcp` tool can call any Paseo tool by name, so
// supervisors must be checked on the *target* name, not the outer tool.
// ---------------------------------------------------------------------------

export function isSupervisorAllowedMcpTarget(toolName: string): boolean {
	return matchesPaseoToolName(toolName, SUPERVISOR_ALLOWED_MCP_TARGETS);
}

// ---------------------------------------------------------------------------
// Peer mode — parsed from the PASEO_TEAM_TASK_V1 brief
// ---------------------------------------------------------------------------

export function parsePeerMode(prompt: string): PeerMode | null {
	const match = prompt.match(/^MODE:\s*(write|read-only)\s*$/im);
	if (!match?.[1]) return null;
	return match[1].toLowerCase() === "write" ? "write" : "read-only";
}

let peerMode: PeerMode = "read-only";

// ---------------------------------------------------------------------------
// Role prompts
// ---------------------------------------------------------------------------

export function promptsDir(): string {
	const override = process.env.PASEO_TEAM_PROMPTS_DIR;
	if (override) return override;
	const extDir = dirname(fileURLToPath(import.meta.url));
	const primary = join(extDir, "prompts");
	const secondary = join(dirname(extDir), "prompts");
	if (existsSync(primary)) return primary;
	return existsSync(secondary) ? secondary : primary;
}

const promptCache = new Map<TeamRole, string>();
let warnedMissing = false;

export function loadRolePrompt(r: TeamRole): string | undefined {
	const cached = promptCache.get(r);
	if (cached !== undefined) return cached;
	try {
		const text = readFileSync(join(promptsDir(), `${r}.md`), "utf8");
		promptCache.set(r, text);
		return text;
	} catch {
		if (!warnedMissing) {
			warnedMissing = true;
			console.warn(
				`[paseo-team] prompt file not found for role "${r}" (looked in ${promptsDir()})`,
			);
		}
		return undefined;
	}
}

// ---------------------------------------------------------------------------
// Policy application
// ---------------------------------------------------------------------------

function extraTools(): string[] {
	return (process.env.PASEO_TEAM_EXTRA_TOOLS ?? "")
		.split(",")
		.map((s) => s.trim())
		.filter(Boolean);
}

function applyPolicy(pi: ExtensionAPI, r: TeamRole): Policy {
	const registered = new Set(pi.getAllTools().map((t) => t.name));
	const policy = policyFor(r, peerMode);
	const allowed = [...new Set([...policy.allow, ...extraTools()])].filter(
		(name) => registered.has(name),
	);
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
			const p = policyFor(r, peerMode);
			ctx.ui.notify(
				`role=${r} peerMode=${peerMode}\n${describePolicy(p)}`,
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
				`peerMode: ${peerMode}`,
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
	if (!role) {
		console.log("[paseo-team] PASEO_PI_ROLE unset — extension passive");
		registerDebugCommands(pi, undefined);
		return;
	}

	console.log(
		`[paseo-team] role=${role} peerMode=${peerMode} policy=${describePolicy(policyFor(role, peerMode))}`,
	);

	pi.on("session_start", () => {
		applyPolicy(pi, role);
	});

	pi.on("before_agent_start", async (event) => {
		if (role === "peer") {
			const parsed = parsePeerMode(event.prompt);
			if (parsed) peerMode = parsed;
		}
		applyPolicy(pi, role);
		const rolePrompt = loadRolePrompt(role);
		if (!rolePrompt) return;
		return {
			systemPrompt: `${event.systemPrompt}\n\n## Paseo Team Role\n${rolePrompt}`,
		};
	});

	pi.on("tool_call", async (event) => {
		const policy = policyFor(role, peerMode);
		if (policy.deny.includes(event.toolName)) {
			return {
				block: true,
				reason: denyReason(role, peerMode, event.toolName),
			};
		}
		if (isToolCallEventType("mcp", event)) {
			if (role === "peer") {
				return {
					block: true,
					reason:
						"Peer cannot use the MCP proxy (it would expose Paseo orchestration tools). Report a DEPENDENCY_REQUEST to the Lead instead.",
				};
			}
			if (role === "supervisor") {
				const target =
					typeof event.input.tool === "string" ? event.input.tool : undefined;
				if (target && !isSupervisorAllowedMcpTarget(target)) {
					return {
						block: true,
						reason: `Supervisor may only call monitoring tools through MCP (list_agents, get_agent_status, get_agent_activity, send_agent_prompt). "${target}" is blocked — send an observation to the Lead instead.`,
					};
				}
			}
		}
		if (role === "peer" && isToolCallEventType("bash", event)) {
			const command = event.input.command ?? "";
			if (callsPaseoCli(command)) {
				return {
					block: true,
					reason:
						"Peer cannot drive the Paseo CLI from bash (would bypass the tool policy). Report a DEPENDENCY_REQUEST to the Lead instead.",
				};
			}
		}
	});

	registerDebugCommands(pi, role);
}

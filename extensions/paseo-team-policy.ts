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

/** Kept for API compatibility; the extension factory re-detects lazily. */
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
	/**
	 * Lead needs permission triage: an agent-scoped Peer that raises a
	 * permission request otherwise deadlocks the workflow. Supervisor must
	 * NOT get these (permission answers are an authority act, not monitoring).
	 */
	permissions: ["list_pending_permissions", "respond_to_permission"],
} as const;

export const ALL_PASEO_TOOLS: string[] = [
	...PASEO_TOOLS.discovery,
	...PASEO_TOOLS.workspace,
	...PASEO_TOOLS.monitoring,
	...PASEO_TOOLS.orchestration,
];

export const LEAD_ALLOWED_MCP_TARGETS: string[] = [
	...PASEO_TOOLS.discovery,
	...PASEO_TOOLS.workspace,
	...PASEO_TOOLS.monitoring,
	...PASEO_TOOLS.orchestration,
	...PASEO_TOOLS.permissions,
];

const PI_READ_ONLY = ["read", "bash"];
const PI_WRITE = ["read", "write", "edit", "bash"];

/** pi-mcp-adapter proxy tools — Paseo tools are reached through the `mcp` tool. */
const MCP_TOOLS = ["mcp", "mcp_script"];

/** Monitoring-only Paseo tools — the supervisor's default surface. */
const SUPERVISOR_MONITORING_TARGETS: string[] = [
	"list_agents",
	"get_agent_status",
	"get_agent_activity",
	"send_agent_prompt",
];

/**
 * Paseo tools the supervisor may call through the MCP proxy. Fail-closed:
 * anything else in the catalog (terminals, workspace scripts, schedules,
 * discovery, orchestration, permissions, ...) is blocked. send_agent_prompt
 * is allowed so the supervisor can deliver observations to the Lead.
 * create_agent is the SINGLE orchestration exception — a gated lead-recovery
 * action whose arguments are validated by supervisorCreateAgentBlockReason.
 * Raw orchestration (peers, workspaces, discovery, arbitrary model choice)
 * stays blocked.
 */
const SUPERVISOR_ALLOWED_MCP_TARGETS: string[] = [
	...SUPERVISOR_MONITORING_TARGETS,
	"create_agent",
];

/**
 * Stricter set for the mcp_script backstop scan: create_agent is excluded
 * because a script's arguments cannot be statically verified (the arg guard
 * only runs on direct `mcp` proxy calls). Supervisor mcp_script is already
 * hard-denied at the policy level — this is defense in depth only.
 */
const SUPERVISOR_MCP_SCRIPT_TARGETS: string[] = SUPERVISOR_MONITORING_TARGETS;

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

function leadWriteEnabled(): boolean {
	const raw = process.env.PASEO_TEAM_LEAD_WRITE?.trim().toLowerCase();
	return raw === "1" || raw === "true" || raw === "yes";
}

export function policyFor(role: TeamRole, peerMode: PeerMode): Policy {
	switch (role) {
		case "lead":
			return {
				allow: [
					...(leadWriteEnabled() ? PI_WRITE : PI_READ_ONLY),
					...LEAD_ALLOWED_MCP_TARGETS,
					...MCP_TOOLS,
				],
				deny: [],
			};
		case "supervisor":
			return {
				allow: ["read", "mcp", ...PASEO_TOOLS.monitoring, "send_agent_prompt"],
				deny: ["write", "edit", "mcp_script", ...ALL_PASEO_TOOLS],
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

/**
 * Effective peer policy for the CURRENT turn. `MODE: write` grants write/edit
 * tools only when the brief also grants edit authority: an explicit
 * `EDIT_AUTHORITY: denied` (or a fail-closed V3 brief) strips write/edit
 * even on a write-mode turn.
 */
export function policyWithAuthority(
	role: TeamRole,
	peerMode: PeerMode,
	brief: ParsedTaskBrief | null,
): Policy {
	const policy = policyFor(role, peerMode);
	if (
		role === "peer" &&
		peerMode === "write" &&
		!peerGitAuthority(brief).edit
	) {
		return {
			allow: policy.allow.filter((t) => t !== "write" && t !== "edit"),
			deny: [...new Set([...policy.deny, "write", "edit"])],
		};
	}
	return policy;
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
	if (role === "supervisor" && toolName === "mcp_script") {
		return "Supervisor cannot use mcp_script: dynamic MCP dispatch cannot be verified against the monitoring allowlist. Call monitoring tools individually through the mcp proxy (list_agents, get_agent_status, get_agent_activity, send_agent_prompt).";
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
// supervisor and lead must be checked on the *target* name, not the outer
// tool. Fail-closed: unclassifiable input is blocked.
// ---------------------------------------------------------------------------

export interface McpInputClassification {
	kind: "meta" | "target" | "unknown";
	target?: string;
	reason?: string;
}

/**
 * Gateway meta operations that never reach a Paseo tool: server status,
 * connection, discovery, and adapter housekeeping. Anything else must carry
 * a determinable target (`tool: "<name>"`) to be allowed.
 */
const MCP_META_KEYS = [
	"connect",
	"search",
	"describe",
	"instructions",
	"server",
];
const MCP_META_ACTIONS = new Set(["ui-messages"]);

export function classifyMcpInput(input: unknown): McpInputClassification {
	if (typeof input !== "object" || input === null) {
		return { kind: "unknown", reason: "mcp input is not an object" };
	}
	const rec = input as Record<string, unknown>;
	if ("tool" in rec) {
		return typeof rec.tool === "string" && rec.tool.trim().length > 0
			? { kind: "target", target: rec.tool }
			: {
					kind: "unknown",
					reason: "mcp input has a missing or non-string tool field",
				};
	}
	if (MCP_META_KEYS.some((k) => k in rec)) {
		return { kind: "meta" };
	}
	if ("action" in rec) {
		return typeof rec.action === "string" && MCP_META_ACTIONS.has(rec.action)
			? { kind: "meta" }
			: {
					kind: "unknown",
					reason: `mcp action "${String(rec.action)}" is not a meta operation`,
				};
	}
	if (Object.keys(rec).length === 0) {
		return { kind: "meta" }; // mcp({}) = gateway status
	}
	return {
		kind: "unknown",
		reason:
			"mcp input carries no determinable target (expected tool, connect, search, describe, instructions, server, or a known action)",
	};
}

export function isSupervisorAllowedMcpTarget(toolName: string): boolean {
	return matchesPaseoToolName(toolName, SUPERVISOR_ALLOWED_MCP_TARGETS);
}

export function mcpAllowedTargets(role: TeamRole): string[] {
	switch (role) {
		case "supervisor":
			return SUPERVISOR_ALLOWED_MCP_TARGETS;
		case "lead":
			return LEAD_ALLOWED_MCP_TARGETS;
		case "peer":
			return [];
	}
}

/** Extract create_agent args from an mcp proxy input ({ tool, args }). */
function extractCreateAgentArgs(input: unknown): unknown {
	if (typeof input !== "object" || input === null) return null;
	const args = (input as Record<string, unknown>).args;
	if (typeof args === "string") {
		try {
			return JSON.parse(args);
		} catch {
			return null;
		}
	}
	return args ?? null;
}

const SUPERVISOR_RECOVERY_PURPOSES = new Set(["recovery", "bootstrap"]);

/**
 * Argument-level gate for supervisor create_agent through the MCP proxy.
 * The supervisor may create exactly ONE kind of agent: a successor Lead
 * (`pi-lead/<pi-provider>/<model-id>`), flagged recovery/bootstrap with a
 * project id and an explicit thinking level. Anything else — peers, other
 * providers, missing labels, missing thinking, malformed args — is blocked
 * fail-closed. The labels land on the created agent, so `paseo agent ls`
 * shows exactly why it exists (audit trail).
 */
export function supervisorCreateAgentBlockReason(
	input: unknown,
): string | null {
	const args = extractCreateAgentArgs(input);
	if (typeof args !== "object" || args === null) {
		return "Supervisor create_agent requires an args object (provider, labels, settings). Refusing fail-closed.";
	}
	const rec = args as Record<string, unknown>;
	const provider = typeof rec.provider === "string" ? rec.provider : "";
	// pi-lead/<pi-provider>/<model-id>; model ids may contain slashes
	// (Paseo splits at the first slash only), so just require both segments.
	if (!/^pi-lead\/[^/]+\/[^/]+/.test(provider)) {
		return `Supervisor create_agent is lead-recovery only: provider must be "pi-lead/<pi-provider>/<model-id>" (got "${provider || "<missing>"}"). Peers and other providers are created by the Lead, never by the Supervisor.`;
	}
	const labels = rec.labels;
	if (typeof labels !== "object" || labels === null) {
		return "Supervisor create_agent requires labels to prove this is a gated recovery action.";
	}
	const labelMap = labels as Record<string, unknown>;
	const purpose = labelMap.purpose;
	if (
		typeof purpose !== "string" ||
		!SUPERVISOR_RECOVERY_PURPOSES.has(purpose)
	) {
		return `Supervisor create_agent labels.purpose must be "recovery" or "bootstrap" (got "${typeof purpose === "string" ? purpose : "<missing>"}").`;
	}
	const recoveryFor = labelMap.recovery_for;
	if (typeof recoveryFor !== "string" || recoveryFor.trim().length === 0) {
		return "Supervisor create_agent labels.recovery_for (project id) is required.";
	}
	const thinking =
		typeof rec.settings === "object" && rec.settings !== null
			? (rec.settings as Record<string, unknown>).thinkingOptionId
			: undefined;
	if (typeof thinking !== "string" || thinking.trim().length === 0) {
		return "Supervisor create_agent requires settings.thinkingOptionId (no daemon-default model — route from the approved Lead route).";
	}
	return null;
}

/**
 * Decide whether an `mcp` proxy call is allowed for a role.
 * Returns a block reason, or null when allowed.
 */
export function mcpBlockReason(role: TeamRole, input: unknown): string | null {
	const classification = classifyMcpInput(input);
	if (classification.kind === "meta") return null;
	if (classification.kind === "unknown") {
		return (
			classification.reason ??
			"mcp call could not be classified — blocked fail-closed"
		);
	}
	const target = classification.target ?? "";
	if (!matchesPaseoToolName(target, mcpAllowedTargets(role))) {
		if (role === "supervisor") {
			return `Supervisor may only call monitoring tools through MCP (list_agents, get_agent_status, get_agent_activity, send_agent_prompt) plus a gated lead-recovery create_agent. "${target}" is blocked — send an observation to the Lead instead.`;
		}
		return `"${target}" is not in the ${role} MCP allowlist (discovery, workspace, monitoring, orchestration, permissions).`;
	}
	if (role === "supervisor" && matchesPaseoToolName(target, ["create_agent"])) {
		const argBlock = supervisorCreateAgentBlockReason(input);
		if (argBlock) return argBlock;
	}
	return null;
}

/**
 * mcp_script executes arbitrary JS that can call MCP tools directly, bypassing
 * the `mcp` guard. Heuristic backstop: scan for direct tool references
 * (`tools.<name>()`, `tools["<name>"]()`, `tools.call("<name>", ...)` or
 * `tools["call"]("<name>", ...)`) and
 * reject names outside the role allowlist. Any call whose target is NOT a
 * string literal (variable, concatenation, computed key) is unverifiable and
 * blocked — fail-closed, not fail-open. Not a security boundary.
 */
const MCP_SCRIPT_DIRECT_CALL_RE =
	/\btools\s*\[\s*["'`]call["'`]\s*\]\s*\(\s*["'`]([^"'`]+)["'`]|\btools\.call\(\s*["'`]([^"'`]+)["'`]|\btools\[["'`]([^"'`]+)["'`]\]\s*\(|\btools\.([A-Za-z_][A-Za-z0-9_]*)\s*\(/g;

/**
 * Dynamic dispatch forms we can never resolve statically:
 *   tools.call(<non-literal>)     — tools.call(target)
 *   tools["call"](<non-literal>)  — tools["call"](target)
 *   tools[<non-literal>](         — tools[target]() / tools[i + 1]()
 * `tools.call("literal")`/`tools["call"]("literal")` are matched by
 * MCP_SCRIPT_DIRECT_CALL_RE above, so the dynamic regexes only fire on
 * unclassifiable arguments.
 */
const MCP_SCRIPT_DYNAMIC_CALL_RE =
	/\btools\s*\.\s*call\s*\(\s*(?!["'`])|\btools\s*\[\s*["'`]call["'`]\s*\]\s*\(\s*(?!["'`])|\btools\s*\[\s*(?![\s"'`\]])/g;

export function mcpScriptBlockReason(
	role: TeamRole,
	code: string,
): string | null {
	// Supervisor: mcp_script can't be argument-guarded, so its scan keeps the
	// stricter monitoring-only set (create_agent excluded). mcp_script is
	// already hard-denied for the supervisor at the policy level anyway.
	const allowed =
		role === "supervisor"
			? SUPERVISOR_MCP_SCRIPT_TARGETS
			: mcpAllowedTargets(role);
	for (const _match of code.matchAll(MCP_SCRIPT_DYNAMIC_CALL_RE)) {
		return `mcp_script invokes an MCP tool through a non-literal target (variable, expression or computed key) — the ${role} allowlist cannot verify it, so the call is blocked fail-closed. Use a literal tool name: tools.call("<allowed_tool>", ...) or tools.<allowed_tool>().`;
	}
	for (const match of code.matchAll(MCP_SCRIPT_DIRECT_CALL_RE)) {
		// Group order mirrors the pattern: tools["call"](literal), tools.call(...),
		// tools[...], tools.<name>(...). The bracket-call-literal branch must be
		// FIRST — otherwise the generic bracket branch captures the helper name
		// "call", the helper skip-list then drops it, and the real literal
		// target escapes allowlist validation entirely.
		const name = match[1] ?? match[2] ?? match[3] ?? match[4] ?? "";
		if (["call", "describe", "search", "emit"].includes(name)) continue;
		if (!matchesPaseoToolName(name, allowed)) {
			return `Tool "${name}" referenced in mcp_script is not in the ${role} MCP allowlist.`;
		}
	}
	return null;
}

// ---------------------------------------------------------------------------
// Strict task brief (PASEO_TEAM_TASK_V1 | V2 legacy header | V3 marker block)
// ---------------------------------------------------------------------------

export type BriefVersion = 1 | 2 | 3;

export interface ParsedTaskBrief {
	version: BriefVersion;
	/** null when MODE is missing or invalid — always resolves read-only. */
	mode: PeerMode | null;
	/** Human-readable integrity issues found while parsing the brief. */
	malformed: string[];
	/** Uppercase FIELD → first occurrence value (trimmed). */
	fields: Map<string, string>;
}

const BRIEF_HEADER_RE = /^PASEO_TEAM_TASK_V([12])$/;
const V3_BEGIN = "PASEO_TEAM_TASK_V3_BEGIN";
const V3_END = "PASEO_TEAM_TASK_V3_END";
const BRIEF_FIELD_RE = /^([A-Z][A-Z0-9_]*):\s*(.*)$/;
const AUTHORITY_FIELDS = [
	"EDIT_AUTHORITY",
	"COMMIT_AUTHORITY",
	"PUSH_TASK_BRANCH_AUTHORITY",
	"FORCE_PUSH_AUTHORITY",
	"MERGE_AUTHORITY",
	"DEPLOY_AUTHORITY",
] as const;

/**
 * V3 field allowlist. Anything outside this set makes the whole brief
 * fail-closed (read-only, all authorities denied) — unknown structure is
 * treated as hostile input, not as free text to ignore.
 */
const V3_ALLOWED_FIELDS = new Set([
	"TASK_ID",
	"PROJECT_ID",
	"DISPOSITION",
	"MODE",
	"ASSIGNED_HOST_ID",
	"ASSIGNED_PASEO_PROVIDER",
	"ASSIGNED_MODEL",
	"ASSIGNED_THINKING",
	"WORKSPACE_REF",
	"AGENT_REF",
	"EXPECTED_BASE_SHA",
	"ASSIGNED_CANDIDATE_SHA",
	"OWNED_SCOPE",
	"EXCLUDED_SCOPE",
	"VERIFICATION_PROFILE",
	"RETURN_CHANNEL",
	...AUTHORITY_FIELDS,
]);

/**
 * Parse a V3 marker-block brief. The block starts at the exact first
 * non-empty line `PASEO_TEAM_TASK_V3_BEGIN` and ends at the first line that
 * trims to `PASEO_TEAM_TASK_V3_END`. Only lines *before* the end marker are
 * field-bearing; the task body after it is untrusted text and can never
 * grant authority.
 *
 * Fail-closed rules (any hit → mode null, fields dropped):
 *   - begin marker without end marker;
 *   - unparseable line inside the block;
 *   - field outside the allowlist;
 *   - duplicate field (any field — cheaply catches injected overrides;
 *     duplicate *authority* fields are the classic injection vector);
 *   - missing/invalid MODE or malformed authority values.
 */
function parseV3Brief(lines: string[]): ParsedTaskBrief {
	const malformed: string[] = [];
	const fields = new Map<string, string>();
	let begin = -1;
	for (let i = 0; i < lines.length; i++) {
		if ((lines[i]?.trim() ?? "").length > 0) {
			begin = i;
			break;
		}
	}
	let end = -1;
	for (let i = begin + 1; i < lines.length; i++) {
		if ((lines[i] ?? "").trim() === V3_END) {
			end = i;
			break;
		}
	}
	if (end < 0) {
		malformed.push("V3 brief has no closing PASEO_TEAM_TASK_V3_END marker");
	} else {
		for (let i = begin + 1; i < end; i++) {
			const line = (lines[i] ?? "").trim();
			if (line.length === 0) continue;
			const match = line.match(BRIEF_FIELD_RE);
			if (!match || match[1] === undefined || match[2] === undefined) {
				malformed.push(`unparseable line in V3 brief: "${line}"`);
				continue;
			}
			const key = match[1];
			if (!V3_ALLOWED_FIELDS.has(key)) {
				malformed.push(`unknown V3 brief field "${key}"`);
				continue;
			}
			if (fields.has(key)) {
				malformed.push(
					AUTHORITY_FIELDS.includes(key as never)
						? `duplicate authority field "${key}"`
						: `duplicate field "${key}"`,
				);
				continue;
			}
			fields.set(key, match[2].trim());
		}
	}

	const failClosed = (): ParsedTaskBrief => ({
		version: 3,
		mode: null,
		malformed,
		fields: new Map(),
	});

	let mode: PeerMode | null = null;
	const rawMode = fields.get("MODE");
	if (rawMode === undefined) {
		malformed.push("missing MODE field");
	} else {
		const normalized = rawMode.toLowerCase();
		if (normalized === "write" || normalized === "read-only") {
			mode = normalized;
		} else {
			malformed.push(`invalid MODE value "${rawMode}"`);
		}
	}
	for (const field of AUTHORITY_FIELDS) {
		const value = fields.get(field);
		if (value !== undefined) {
			const normalized = value.toLowerCase();
			if (normalized !== "allowed" && normalized !== "denied") {
				malformed.push(`invalid ${field} value "${value}"`);
			}
		}
	}
	if (malformed.length > 0) return failClosed();
	return { version: 3, mode, malformed, fields };
}

/**
 * Legacy V1/V2 briefs historically scanned the WHOLE prompt for authority
 * fields — an authorization-injection vector (a body line like
 * `COMMIT_AUTHORITY: allowed` granted real authority). V3 closes it.
 * V1/V2 are accepted for identity/mode parsing only; resolvePeerMode and
 * peerGitAuthority below treat them as read-only with all authority denied.
 */
export function isLegacyBrief(brief: ParsedTaskBrief): boolean {
	return brief.version < 3;
}

/**
 * Parse a task brief. Returns null when the prompt does not start with a
 * recognized header — callers must treat that as an unbriefed (read-only)
 * turn. A recognized header with a missing/invalid MODE yields
 * `mode: null` plus a malformed note, never silent write access.
 */
export function parseTaskBrief(prompt: string): ParsedTaskBrief | null {
	const lines = prompt.split(/\r?\n/);
	const firstNonEmpty = lines.map((l) => l.trim()).find((l) => l.length > 0);
	if (!firstNonEmpty) return null;
	if (firstNonEmpty === V3_BEGIN) return parseV3Brief(lines);
	const headerMatch = firstNonEmpty.match(BRIEF_HEADER_RE);
	if (!headerMatch || !headerMatch[1]) return null;
	const version: BriefVersion = headerMatch[1] === "2" ? 2 : 1;

	const fields = new Map<string, string>();
	for (const line of lines) {
		const fieldMatch = line.match(BRIEF_FIELD_RE);
		const key = fieldMatch?.[1];
		if (
			key !== undefined &&
			fieldMatch?.[2] !== undefined &&
			!fields.has(key)
		) {
			fields.set(key, fieldMatch[2].trim());
		}
	}

	const malformed: string[] = [];
	let mode: PeerMode | null = null;
	const rawMode = fields.get("MODE");
	if (rawMode === undefined) {
		malformed.push("missing MODE field");
	} else {
		const normalized = rawMode.toLowerCase();
		if (normalized === "write" || normalized === "read-only") {
			mode = normalized;
		} else {
			malformed.push(`invalid MODE value "${rawMode}"`);
		}
	}

	if (version === 2) {
		for (const field of AUTHORITY_FIELDS) {
			const value = fields.get(field);
			if (value !== undefined) {
				const normalized = value.toLowerCase();
				if (normalized !== "allowed" && normalized !== "denied") {
					malformed.push(
						`invalid ${field} value "${value}" (treated as denied)`,
					);
				}
			}
		}
	}

	// Legacy briefs are kept parseable for diagnostics, but their write mode
	// and authority fields are never honored (whole-prompt scan injection
	// surface closed by V3). Surface that loudly for /team-role debugging.
	if (mode === "write" || AUTHORITY_FIELDS.some((f) => fields.has(f))) {
		malformed.push(
			`legacy V${version} brief: MODE and *_AUTHORITY fields are ignored — only a V3 marker block can grant write/authority`,
		);
	}

	return { version, mode, malformed, fields };
}

/** Fail-closed mode resolution: unknown/incomplete/legacy brief → read-only. */
export function resolvePeerMode(brief: ParsedTaskBrief | null): PeerMode {
	if (brief === null) return "read-only";
	// Legacy V1/V2 briefs never grant write mode: their parser scanned the
	// whole prompt, so any body line could silently grant authority. Use V3.
	if (isLegacyBrief(brief)) return "read-only";
	return brief.mode ?? "read-only";
}

export interface PeerGitAuthority {
	edit: boolean;
	commit: boolean;
	pushTaskBranch: boolean;
	forcePush: boolean;
	merge: boolean;
	deploy: boolean;
}

function authorityField(
	brief: ParsedTaskBrief | null,
	field: string,
): boolean | undefined {
	const raw = brief?.fields.get(field);
	if (raw === undefined) return undefined;
	return raw.toLowerCase() === "allowed";
}

/**
 * Git authority for a peer turn. Defaults are fail-closed: commit and push
 * are denied unless the brief explicitly allows them; force-push, merge and
 * deploy are never allowed, even if a brief claims otherwise.
 */
export function peerGitAuthority(
	brief: ParsedTaskBrief | null,
): PeerGitAuthority {
	if (brief === null || isLegacyBrief(brief)) {
		// No brief, or a legacy V1/V2 brief (whole-prompt scan injection
		// surface): every authority is denied regardless of claimed fields.
		return {
			edit: false,
			commit: false,
			pushTaskBranch: false,
			forcePush: false,
			merge: false,
			deploy: false,
		};
	}
	const mode = resolvePeerMode(brief);
	return {
		edit: authorityField(brief, "EDIT_AUTHORITY") ?? mode === "write",
		commit: authorityField(brief, "COMMIT_AUTHORITY") ?? false,
		pushTaskBranch:
			authorityField(brief, "PUSH_TASK_BRANCH_AUTHORITY") ?? false,
		forcePush: false,
		merge: false,
		deploy: false,
	};
}

// ---------------------------------------------------------------------------
// Peer git authority guard — heuristics on bash commands mirroring the
// PASEO CLI guard. Not an authorization boundary.
// ---------------------------------------------------------------------------

const GIT_COMMIT_RE = /\bgit\b[^|;&]*\bcommit\b/i;
const GIT_PUSH_RE = /\bgit\b[^|;&]*\bpush\b/i;

/**
 * Force-push detection over every `git push` segment of a command. Catches
 * the forms a flag-order/heuristic regex misses: `--force[:=...] variants`,
 * combined short flags (`-f`, `-uf`, `-fu`, ...) and forced refspecs
 * (`+HEAD:refs/...`, `+main`). Chained commands are split first so a
 * `git fetch && git push --force` chain cannot hide the flag.
 */
function detectForcePush(command: string): boolean {
	for (const segment of command.split(/[|;&]+/)) {
		if (!GIT_PUSH_RE.test(segment)) continue;
		if (/--force(?:-with-lease)?\b/i.test(segment)) return true;
		if (/(?:^|\s)-[a-z]*f[a-z]*(?:\s|$)/i.test(segment)) return true;
		if (/(?:^|\s)\+/i.test(segment)) return true; // forced refspec +src[:dst]
	}
	return false;
}

/**
 * The ONLY push form a peer may run when PUSH_TASK_BRANCH_AUTHORITY is
 * granted: upload HEAD to its own task branch on origin. Branch name must
 * be exactly agent/<TASK_ID> from the current brief — pushing any other
 * branch (main, a teammate's branch), other remotes, --all/--tags/--mirror
 * or deletions is structurally impossible in this form.
 */
const EXACT_PUSH_RE =
	/^\s*git\s+push\s+-u\s+origin\s+HEAD:refs\/heads\/([A-Za-z0-9][A-Za-z0-9._/-]*)\s*$/;

export function expectedTaskBranch(taskId: string | undefined): string | null {
	const id = taskId?.trim();
	if (!id || /\s/.test(id)) return null;
	return `agent/${id}`;
}

const GIT_MERGE_RE = /\bgit\b[^|;&]*\bmerge\b/i;
const GIT_AMEND_RE = /\bgit\b[^|;&]*\bcommit\b[^|;&]*--amend\b/i;

export function gitAuthorityBlockReason(
	command: string,
	authority: PeerGitAuthority,
	taskId?: string,
): string | null {
	if (detectForcePush(command)) {
		return "FORCE_PUSH_AUTHORITY is always denied for Peers (including -f/-uf/-fu, --force*= and +refspec forms). Ask the Lead to update the brief — peers never force-push.";
	}
	if (GIT_AMEND_RE.test(command)) {
		return "git commit --amend is always denied for Peers: a pushed branch must advance by NEW commits so the SHA chain stays reviewable. Create a new correction commit and (when granted) push it with the exact branch-scoped form.";
	}
	if (GIT_PUSH_RE.test(command)) {
		if (!authority.pushTaskBranch) {
			return "PUSH_TASK_BRANCH_AUTHORITY is denied for this task. Report AUTHORITY_MISMATCH to the Lead.";
		}
		const expected = expectedTaskBranch(taskId);
		const match = command.match(EXACT_PUSH_RE);
		if (expected === null || !match || match[1] !== expected) {
			return `Push authority is branch-scoped: only "git push -u origin HEAD:refs/heads/${expected ?? "agent/<TASK_ID>"}" is allowed. Other branches/remotes, --all, --tags, --mirror, deletions and chained commands are blocked. Push first, run other commands separately.`;
		}
	}
	if (GIT_COMMIT_RE.test(command) && !authority.commit) {
		return "COMMIT_AUTHORITY is denied for this task. Report AUTHORITY_MISMATCH to the Lead (or hand off a stable workspace snapshot instead of a SHA).";
	}
	if (GIT_MERGE_RE.test(command) && !authority.merge) {
		return "MERGE_AUTHORITY is always denied for Peers. Integration belongs to the Lead or Human.";
	}
	return null;
}

// ---------------------------------------------------------------------------
// Legacy parser — kept for API compatibility; strict semantics now live in
// parseTaskBrief + resolvePeerMode.
// ---------------------------------------------------------------------------

export function parsePeerMode(prompt: string): PeerMode | null {
	return parseTaskBrief(prompt)?.mode ?? null;
}

// ---------------------------------------------------------------------------
// Per-turn peer state — recomputed from the *current* prompt on every
// before_agent_start. Never sticky across turns.
// ---------------------------------------------------------------------------

let currentBrief: ParsedTaskBrief | null = null;

function currentPeerMode(): PeerMode {
	return resolvePeerMode(currentBrief);
}

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

function currentPolicy(r: TeamRole): Policy {
	return policyWithAuthority(r, currentPeerMode(), currentBrief);
}

function applyPolicy(pi: ExtensionAPI, r: TeamRole): Policy {
	const registered = new Set(pi.getAllTools().map((t) => t.name));
	const policy = currentPolicy(r);
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
				return {
					block: true,
					reason:
						"Peer cannot use the MCP proxy (it would expose Paseo orchestration tools). Report a DEPENDENCY_REQUEST to the Lead instead.",
				};
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
		if (r === "peer" && isToolCallEventType("bash", event)) {
			const command = event.input.command ?? "";
			if (callsPaseoCli(command)) {
				return {
					block: true,
					reason:
						"Peer cannot drive the Paseo CLI from bash (would bypass the tool policy). Report a DEPENDENCY_REQUEST to the Lead instead.",
				};
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

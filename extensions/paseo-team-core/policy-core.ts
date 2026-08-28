/**
 * policy-core.ts — runtime-neutral role policy for the Paseo team pack.
 *
 * This module holds every rule that is TRUE REGARDLESS of which coding agent
 * executes the turn: task-brief parsing, peer authority derivation, the Paseo
 * MCP allowlists, the bash guards, and the git authority guard.
 *
 * It imports nothing from any agent runtime. Two thin adapters bind it to a
 * runtime and both MUST route every decision through here — a rule that lives
 * in only one adapter is a rule the other runtime silently lacks:
 *   - extensions/paseo-team-policy.ts              → Pi (extension API)
 *   - extensions/paseo-team-core/claude-policy.ts  → Claude Code (settings hooks)
 *
 * This module lives in a SUBDIRECTORY on purpose. Pi discovers
 * `~/.pi/agent/extensions/*.ts` as extensions, and a subdirectory is only
 * entered when it carries an index.ts/index.js or a package.json with a `pi`
 * field (loader.js resolveExtensionEntries) — neither exists here, so the core
 * is invisible to that scan while staying a plain `.ts` file that the repo's
 * review harness — and every tool that globs TypeScript sources — can see.
 */

import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// ---------------------------------------------------------------------------
// Role detection
// ---------------------------------------------------------------------------

export type TeamRole = "supervisor" | "lead" | "peer";
export type PeerMode = "write" | "read-only";

/**
 * The active role, from the environment Paseo sets on the agent process.
 *
 * The env is a PARAMETER (defaulting to this process's) because the Claude
 * adapter is exercised with an explicit environment in tests and can be called
 * for a different session's env; reading the global directly would silently
 * ignore that argument and resolve every call as passive.
 */
export function detectRole(
	env: Record<string, string | undefined> = process.env,
): TeamRole | undefined {
	const raw = env.PASEO_PI_ROLE?.trim().toLowerCase();
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

/** pi-mcp-adapter proxy tools — Paseo tools are reached through the `mcp` tool. */
export const MCP_TOOLS = ["mcp", "mcp_script"];
export const PEER_COMMUNICATION_TOOL = "peer_ask_lead";
export const TEAM_WATCHDOG_TOOL = "team_watchdog";
export const TEAM_CHAT_TOOL = "team_chat";
/** Payload ceiling, kept in sync with scripts/team-chat.mjs MAX_BODY_BYTES. */
export const TEAM_CHAT_MAX_BODY_BYTES = 8192;
/** Mirror of TEAM_MESSAGE_KINDS in scripts/team-chat.mjs (shapes tool schemas). */
export const TEAM_MESSAGE_KIND_NAMES = [
	"handoff",
	"dependency",
	"claim",
	"release",
	"question",
	"decision",
	"progress",
] as const;
export const PI_READ_ONLY = ["read", "bash", PEER_COMMUNICATION_TOOL];
export const PI_WRITE = ["read", "write", "edit", "bash", PEER_COMMUNICATION_TOOL];

/**
 * agent-browser MCP names are normalized by pi-mcp-adapter. Keep this prefix
 * allowlist explicit: a bare `open`/`click` target could belong to another
 * MCP server and must never be treated as browser authority.
 */
const AGENT_BROWSER_MCP_PREFIXES = [
	"agent_browser_",
	"agent-browser_",
	"agent_browser:",
	"agent-browser:",
	"mcp__agent_browser__",
	"mcp__agent-browser__",
];
export function isAgentBrowserMcpTarget(name: string): boolean {
	const normalized = name.trim().toLowerCase();
	return AGENT_BROWSER_MCP_PREFIXES.some((prefix) =>
		normalized.startsWith(prefix),
	);
}

export function callsAgentBrowserCli(command: string): boolean {
	// This is a deny heuristic, not a shell parser: block every literal
	// agent-browser reference in a Peer bash command so wrappers/aliases do not
	// reopen the CLI surface. The typed MCP path is checked separately.
	return /(?:^|[^a-z0-9])agent-browser(?:\.(?:cmd|exe|ps1|sh))?(?=$|[^a-z0-9])/i.test(
		command,
	);
}

/** Monitoring-only Paseo tools — the supervisor's default surface. */
export const SUPERVISOR_MONITORING_TARGETS: string[] = [
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
export const SUPERVISOR_ALLOWED_MCP_TARGETS: string[] = [
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

export function leadWriteEnabled(): boolean {
	const raw = process.env.PASEO_TEAM_LEAD_WRITE?.trim().toLowerCase();
	return raw === "1" || raw === "true" || raw === "yes";
}

export function policyFor(role: TeamRole, peerMode: PeerMode): Policy {
	switch (role) {
		case "lead":
			return {
				allow: [
					...(leadWriteEnabled() ? PI_WRITE : PI_READ_ONLY).filter(
						(tool) => tool !== PEER_COMMUNICATION_TOOL,
					),
					TEAM_WATCHDOG_TOOL,
					TEAM_CHAT_TOOL,
					...LEAD_ALLOWED_MCP_TARGETS,
					...MCP_TOOLS,
				],
				deny: [],
			};
		case "supervisor":
			return {
				allow: ["read", "mcp", TEAM_WATCHDOG_TOOL, TEAM_CHAT_TOOL, ...PASEO_TOOLS.monitoring, "send_agent_prompt"],
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
	if (role !== "peer") return policy;

	const authority = peerAuthority(brief);
	const allow = [...policy.allow];
	const deny = [...policy.deny];
	if (authority.browserMcp) {
		allow.push("mcp");
		const mcpIndex = deny.indexOf("mcp");
		if (mcpIndex >= 0) deny.splice(mcpIndex, 1);
	}
	if (peerMode === "write" && !authority.edit) {
		return {
			allow: allow.filter((t) => t !== "write" && t !== "edit"),
			deny: [...new Set([...deny, "write", "edit"])],
		};
	}
	return { allow: [...new Set(allow)], deny: [...new Set(deny)] };
}

export function denyReason(
	role: TeamRole,
	peerMode: PeerMode,
	toolName: string,
): string {
	if (role === "peer" && (toolName === "mcp" || toolName === "mcp_script")) {
		return "Peer cannot use the MCP proxy unless the current V3 brief grants BROWSER_MCP_AUTHORITY: allowed. Paseo orchestration MCP remains forbidden. Report a DEPENDENCY_REQUEST to the Lead instead.";
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

/**
 * `paseo chat ...` in a bash command, in any spelling the shims use.
 *
 * Chat is the coordination bus between Leads and Supervisors, and it is the one
 * Paseo surface with no MCP tool behind it (60 tools, none of them chat --
 * measured 2026-08-27). Left on bash it is a channel no policy can inspect: no
 * room allowlist, no TEAM_MESSAGE_V1 envelope, no size ceiling, no audit.
 */
const PASEO_CHAT_CLI_RE =
	/\b(paseo|paseo-pi|pio)(?:\.(?:cmd|exe|ps1|sh))?\s+chat\b/i;

export function callsPaseoChatCli(command: string): boolean {
	return PASEO_CHAT_CLI_RE.test(command);
}

/**
 * Direct invocation of a pack support script that grants authority the caller's
 * role does not have.
 *
 * Blocking `paseo chat` while leaving `node .../team-chat.mjs` open moves the
 * bypass one word to the left: the script's own gate reads PASEO_PI_ROLE and
 * PASEO_AGENT_ID from an environment the calling process owns, so it can only
 * check what the caller asserts. This puts both spellings at the same bar.
 *
 * Two scripts are deliberately NOT listed:
 *   - ocr-review.mjs        the Reviewer skill runs it directly, by design
 *   - team-communication.mjs equivalent to peer_ask_lead — same parent-scoped,
 *                            fail-closed sender, no authority a Peer lacks
 *
 * Like every bash rule in this file this is a HEURISTIC, not an authorization
 * boundary: a determined process can always re-spell the invocation. It closes
 * the obvious door, and the daemon remains the only real boundary.
 */
const AUTHORITY_SUPPORT_SCRIPTS = ["team-chat.mjs", "remote-paseo.mjs"];
const SUPPORT_SCRIPT_RE = new RegExp(
	`(?:^|[\\s"'\`/\\\\])(${AUTHORITY_SUPPORT_SCRIPTS.map((name) => name.replace(".", "\\.")).join("|")})(?=$|["'\`\\s])`,
	"i",
);

export function callsTeamSupportScript(command: string): boolean {
	if (typeof command !== "string" || command.trim() === "") return false;
	// Require an actual invocation, not a bare mention in prose or an echo.
	if (!/\bnode(?:\.exe)?\b/i.test(command)) return false;
	return SUPPORT_SCRIPT_RE.test(command);
}

/** Reason a Peer may not run a pack support script from bash. */
export function supportScriptBlockReason(
	role: TeamRole,
	command: string,
): string | null {
	if (role !== "peer") return null;
	if (!callsTeamSupportScript(command)) return null;
	return "Peer cannot run this Paseo team support script from bash — it would grant coordination or remote-host authority the Peer role does not have. Use peer_ask_lead to raise a DEPENDENCY_REQUEST instead.";
}

/**
 * Lead/Supervisor bash guard: redirect the chat CLI to the typed tool.
 *
 * Deliberately narrow -- a chat-only redirect, not a new CLI ban. Every other
 * Paseo command a Lead runs from bash (remote-paseo.mjs, `ls`, status checks)
 * is untouched. Peers are already covered by the blanket callsPaseoCli() block
 * and are not this function's business.
 *
 * This lives in the CORE, not in an adapter: a Lead running on Claude must hit
 * the same wall as a Lead running on Pi, or the guard is decoration.
 */
export function coordinationCliBlockReason(
	role: TeamRole,
	command: string,
): string | null {
	if (role !== "lead" && role !== "supervisor") return null;
	if (!callsPaseoChatCli(command)) return null;
	return `Use the team_chat tool instead of the Paseo chat CLI. The typed tool enforces the TEAM_MESSAGE_V1 envelope, the room allowlist, the ${TEAM_CHAT_MAX_BODY_BYTES}-byte payload ceiling and hop/TTL loop protection - none of which exist when the command is typed by hand.`;
}

/**
 * One sentence the runtime adapters put in the team_chat tool description.
 * Deliberately does NOT claim the chat surface is sealed: the bash rules are
 * heuristics, rooms are unrestricted unless PASEO_TEAM_ROOMS is set, and chat
 * rooms have no ACL of their own.
 */
export function teamChatToolDescription(): string {
	return (
		"Coordinate with other Leads and Supervisors through a Paseo chat room. " +
		"`post` delivers a TEAM_MESSAGE_V1 envelope and wakes each recipient by mention; " +
		"`read` returns the room with envelopes parsed; `rooms` lists rooms. " +
		"Recipients are agent ids/short-ids, or 'domain:<name>' to reach every agent carrying that domain label. " +
		"Use this instead of the Paseo chat CLI, which the bash guard redirects here. " +
		"Rooms are unrestricted unless PASEO_TEAM_ROOMS is set."
	);
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

/** Extract tool args from an mcp proxy input ({ tool, args }). */
function extractMcpArgs(input: unknown): unknown {
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

// ---------------------------------------------------------------------------
// Runtime families — the pack runs the SAME three roles on more than one
// coding agent. A Paseo role provider is always "<family>-<role>"; what
// differs per family is only how many segments a model reference carries.
// ---------------------------------------------------------------------------

export type RuntimeFamily = "pi" | "claude";
export const RUNTIME_FAMILIES: RuntimeFamily[] = ["pi", "claude"];
export const ROLES: TeamRole[] = ["supervisor", "lead", "peer"];

/** Every role provider name the pack owns, e.g. "pi-peer", "claude-lead". */
export const ROLE_PROVIDERS: string[] = RUNTIME_FAMILIES.flatMap((family) =>
	ROLES.map((r) => `${family}-${r}`),
);

export interface RoleProvider {
	family: RuntimeFamily;
	role: TeamRole;
}

/** Split "claude-peer" → { family: "claude", role: "peer" }; null when unknown. */
export function parseRoleProvider(name: string): RoleProvider | null {
	const head = name.split("/")[0]?.trim().toLowerCase() ?? "";
	for (const family of RUNTIME_FAMILIES) {
		const prefix = `${family}-`;
		if (!head.startsWith(prefix)) continue;
		const role = head.slice(prefix.length);
		if (ROLES.includes(role as TeamRole)) {
			return { family, role: role as TeamRole };
		}
	}
	return null;
}

/**
 * A create_agent provider reference the Supervisor may use for lead recovery.
 *
 * Pi model ids carry their own provider segment ("pi-lead/<pi-provider>/<model>",
 * Paseo splits at the FIRST slash only), while Claude model ids are single
 * segment ("claude-lead/claude-opus-5"). Both must name the LEAD role and both
 * must carry a model — a bare "pi-lead" would let the daemon pick a default.
 */
export function isLeadRecoveryProvider(provider: string): boolean {
	const parsed = parseRoleProvider(provider);
	if (!parsed || parsed.role !== "lead") return false;
	const segments = provider.split("/").filter((part) => part.length > 0);
	return parsed.family === "pi" ? segments.length >= 3 : segments.length >= 2;
}

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
	return supervisorCreateAgentArgsBlockReason(extractMcpArgs(input));
}

/**
 * Same gate, applied to a plain create_agent arguments object.
 *
 * Runtimes differ in how the arguments arrive: Pi proxies Paseo tools through
 * `mcp({ tool, args })`, while Claude Code calls `mcp__paseo__create_agent`
 * with the arguments as the tool input itself. Both funnel here so the gate
 * cannot drift between runtimes.
 */
export function supervisorCreateAgentArgsBlockReason(
	args: unknown,
): string | null {
	if (typeof args !== "object" || args === null) {
		return "Supervisor create_agent requires an args object (provider, labels, settings). Refusing fail-closed.";
	}
	const rec = args as Record<string, unknown>;
	const provider = typeof rec.provider === "string" ? rec.provider : "";
	if (!isLeadRecoveryProvider(provider)) {
		return `Supervisor create_agent is lead-recovery only: provider must be a Lead role provider carrying a model — "pi-lead/<pi-provider>/<model-id>" or "claude-lead/<claude-model-id>" (got "${provider || "<missing>"}"). Peers and other providers are created by the Lead, never by the Supervisor.`;
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
 * Argument-level gate for Lead create_workspace through the MCP proxy —
 * Layer 1 of the reviewer isolation invariant (Layer 2 is the runtime
 * assertLinkedWorktree gate in ocr-review.mjs, which rejects any
 * non-worktree workspace with REVIEW_WORKSPACE_NOT_WORKTREE).
 *
 * MCP create_workspace args carry no disposition field, so reviewer intent
 * is declared through the workspace naming convention the Lead skill
 * mandates: reviewer workspaces are titled/slugged with "review". The gate
 * enforces:
 *   - isolation is explicit and valid ("local" | "worktree") — never a
 *     daemon default;
 *   - a review-marked workspace (title/worktreeSlug containing "review")
 *     MUST use worktree isolation; local is the exact anti-pattern the
 *     runtime gate rejects, so it is blocked before creation.
 */
export function leadCreateWorkspaceBlockReason(input: unknown): string | null {
	return leadCreateWorkspaceArgsBlockReason(extractMcpArgs(input));
}

/** Same gate against a plain create_workspace arguments object (see above). */
export function leadCreateWorkspaceArgsBlockReason(
	args: unknown,
): string | null {
	if (typeof args !== "object" || args === null) {
		return 'Lead create_workspace requires an args object with an explicit isolation ("local" or "worktree"). Refusing fail-closed.';
	}
	const rec = args as Record<string, unknown>;
	const isolation =
		typeof rec.isolation === "string" ? rec.isolation.trim() : "";
	if (isolation !== "local" && isolation !== "worktree") {
		return `create_workspace requires explicit isolation "local" or "worktree" (got "${isolation || "<missing>"}") — never rely on a daemon default.`;
	}
	const markers = [rec.title, rec.worktreeSlug].filter(
		(value): value is string => typeof value === "string",
	);
	if (isolation !== "worktree" && markers.some((value) => /review/i.test(value))) {
		return 'An independent-reviewer workspace must use isolation "worktree" (a linked git worktree from the source repository). If the worktree cannot be created, report BLOCKED: REVIEW_WORKTREE_UNAVAILABLE — never fall back to a local workspace.';
	}
	return null;
}

/**
 * Decide whether an `mcp` proxy call is allowed for a role.
 * Returns a block reason, or null when allowed.
 */
function isAgentBrowserServer(value: unknown): boolean {
	return value === "agent-browser" || value === "agent_browser";
}

export function peerMcpBlockReason(
	input: unknown,
	brief: ParsedTaskBrief | null,
): string | null {
	if (!browserMcpAllowed(brief)) {
		return "Peer browser MCP is not authorized for this turn. Lead must send a V3 brief with BROWSER_MCP_AUTHORITY: allowed.";
	}
	const classification = classifyMcpInput(input);
	if (classification.kind === "unknown") {
		return (
			classification.reason ??
			"browser MCP call could not be classified — blocked fail-closed"
		);
	}
	if (classification.kind === "meta") {
		const rec = input as Record<string, unknown>;
		if (typeof rec.connect === "string" || typeof rec.server === "string") {
			const selected = [rec.connect, rec.server].filter(
				(value): value is string => typeof value === "string",
			);
			return selected.every(isAgentBrowserServer)
				? null
				: "Peer may connect/query only the agent-browser MCP server; other MCP servers are denied.";
		}
		if (typeof rec.search === "string") {
			return isAgentBrowserServer(rec.server)
				? null
				: "Peer MCP search must set server=agent-browser; broad discovery is denied.";
		}
		if (typeof rec.describe === "string") {
			return (rec.server === undefined || isAgentBrowserServer(rec.server)) &&
				isAgentBrowserMcpTarget(rec.describe)
				? null
				: "Peer may describe only an agent-browser MCP target.";
		}
		return "Peer browser MCP meta operation is not allowed; use an agent-browser target explicitly.";
	}
	const target = classification.target ?? "";
	return isAgentBrowserMcpTarget(target)
		? null
		: `"${target}" is not an agent-browser MCP target; Paseo and unrelated MCP servers remain forbidden for Peers.`;
}

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
	if (role === "lead" && isAgentBrowserMcpTarget(target)) return null;
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
	if (role === "lead" && matchesPaseoToolName(target, ["create_workspace"])) {
		const argBlock = leadCreateWorkspaceBlockReason(input);
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
		if (
			!matchesPaseoToolName(name, allowed) &&
			!(role === "lead" && isAgentBrowserMcpTarget(name))
		) {
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
	"BROWSER_MCP_AUTHORITY",
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

/**
 * JSON shape of a parsed brief, for adapters that must carry the brief across
 * PROCESS boundaries (Claude Code runs each hook in its own process, so the
 * turn's brief is written once and re-read per tool call).
 */
export interface SerializedTaskBrief {
	version: BriefVersion;
	mode: PeerMode | null;
	malformed: string[];
	fields: [string, string][];
}

export function serializeBrief(brief: ParsedTaskBrief): SerializedTaskBrief {
	return {
		version: brief.version,
		mode: brief.mode,
		malformed: [...brief.malformed],
		fields: [...brief.fields.entries()],
	};
}

/**
 * Rebuild a brief from its serialized form. Fail-closed: anything that is not
 * a structurally valid serialization returns null (an unbriefed, read-only
 * turn) rather than a partially trusted brief.
 */
export function deserializeBrief(value: unknown): ParsedTaskBrief | null {
	if (typeof value !== "object" || value === null) return null;
	const record = value as Record<string, unknown>;
	const version = record.version;
	if (version !== 1 && version !== 2 && version !== 3) return null;
	const mode = record.mode;
	if (mode !== "write" && mode !== "read-only" && mode !== null) return null;
	if (!Array.isArray(record.malformed) || !Array.isArray(record.fields)) {
		return null;
	}
	const malformed: string[] = [];
	for (const entry of record.malformed) {
		if (typeof entry !== "string") return null;
		malformed.push(entry);
	}
	const fields = new Map<string, string>();
	for (const entry of record.fields) {
		if (!Array.isArray(entry) || entry.length !== 2) return null;
		const [key, fieldValue] = entry;
		if (typeof key !== "string" || typeof fieldValue !== "string") return null;
		fields.set(key, fieldValue);
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

export interface PeerAuthority {
	edit: boolean;
	browserMcp: boolean;
	commit: boolean;
	pushTaskBranch: boolean;
	forcePush: boolean;
	merge: boolean;
	deploy: boolean;
}

export function peerAuthority(brief: ParsedTaskBrief | null): PeerAuthority {
	if (brief === null || isLegacyBrief(brief)) {
		return {
			edit: false,
			browserMcp: false,
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
		browserMcp: authorityField(brief, "BROWSER_MCP_AUTHORITY") ?? false,
		commit: authorityField(brief, "COMMIT_AUTHORITY") ?? false,
		pushTaskBranch:
			authorityField(brief, "PUSH_TASK_BRANCH_AUTHORITY") ?? false,
		forcePush: false,
		merge: false,
		deploy: false,
	};
}

export function browserMcpAllowed(brief: ParsedTaskBrief | null): boolean {
	return peerAuthority(brief).browserMcp;
}

export type PeerGitAuthority = Omit<PeerAuthority, "browserMcp">;

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
	const authority = peerAuthority(brief);
	return {
		edit: authority.edit,
		commit: authority.commit,
		pushTaskBranch: authority.pushTaskBranch,
		forcePush: authority.forcePush,
		merge: authority.merge,
		deploy: authority.deploy,
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
// Role prompts
// ---------------------------------------------------------------------------

/**
 * Where the role prompts live, resolved from THIS module's location.
 *
 * Three candidates because the layouts differ: installed, the prompts sit in
 * the extensions directory one level above this core
 * (`<ext>/prompts`, core in `<ext>/paseo-team-core/`); in a source checkout
 * they sit at the repo root, two levels above (`<repo>/prompts`, core in
 * `<repo>/extensions/paseo-team-core/`). The first candidate covers a
 * self-contained copy that ships prompts beside the core.
 */
export function promptsDir(): string {
	const override = process.env.PASEO_TEAM_PROMPTS_DIR;
	if (override) return override;
	const coreDir = dirname(fileURLToPath(import.meta.url));
	const candidates = [
		join(coreDir, "prompts"),
		join(dirname(coreDir), "prompts"),
		join(dirname(dirname(coreDir)), "prompts"),
	];
	return candidates.find((candidate) => existsSync(candidate)) ?? candidates[1]!;
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

export function extraTools(): string[] {
	return (process.env.PASEO_TEAM_EXTRA_TOOLS ?? "")
		.split(",")
		.map((s) => s.trim())
		.filter(Boolean);
}

export function teamToolBlockReason(
	role: TeamRole,
	toolName: string,
	brief: ParsedTaskBrief | null,
): string | null {
	if (toolName === PEER_COMMUNICATION_TOOL) {
		if (role !== "peer") return "peer_ask_lead is restricted to Peer agents.";
		if (!brief || brief.version !== 3 || brief.malformed.length > 0) {
			return "peer_ask_lead requires a valid current V3 task brief.";
		}
	}
	if (toolName === TEAM_WATCHDOG_TOOL && role !== "lead" && role !== "supervisor") {
		return "team_watchdog is restricted to Lead and Supervisor agents.";
	}
	const chatReason = teamChatToolBlockReason(role, toolName);
	if (chatReason) return chatReason;
	return null;
}

/**
 * Who may hold the coordination channel. A Peer coordinates with exactly one
 * agent -- its parent Lead -- and has peer_ask_lead for that; a room would hand
 * it a broadcast surface the parent cannot see.
 *
 * Called with a role alone it answers "may this role hold team_chat at all",
 * which is what the runtime adapters ask before exposing the tool.
 */
export function teamChatToolBlockReason(
	role: TeamRole,
	toolName: string = TEAM_CHAT_TOOL,
): string | null {
	if (toolName !== TEAM_CHAT_TOOL) return null;
	if (role !== "lead" && role !== "supervisor") {
		return "team_chat is restricted to Lead and Supervisor agents.";
	}
	return null;
}

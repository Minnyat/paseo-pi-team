/**
 * graph.mjs — turns Paseo's flat agent list into the team graph the WebUI draws.
 *
 * Everything above `collectGraph` is pure and fixture-testable on purpose: the
 * expensive, flaky part (spawning paseo) is one thin function, and the part
 * that decides what an operator sees is not allowed to need a daemon to test.
 *
 * What Paseo gives us, and what it does not:
 *   - nodes            <- `paseo ls -g --json`
 *   - spawn edges      <- `paseo inspect <id>`.ParentAgentId  (one call each)
 *   - pending permits  <- `paseo permit ls --json`            (one call total)
 *   - message edges    <- NOT queryable. `send` is fire-and-forget.
 *
 * Message edges are therefore *reconstructed*, and every reconstruction path
 * carries a confidence. The reliable one is Peer -> Lead: every such message
 * already travels as a PEER_MESSAGE_V1 block built by
 * scripts/team-communication.mjs, so its header parses back into a real edge.
 * Lead -> Peer can only be inferred from tool-call logs and is marked
 * "suspected"; a graph that draws a guess with the same weight as a fact is
 * worse than a graph that admits it does not know.
 */

import { MESSAGE_KINDS } from "../../scripts/team-communication.mjs";
import { runPaseoJson, mapWithConcurrency, PaseoError } from "./paseo-bridge.mjs";
import * as cache from "./graph-cache.mjs";

export const ROLES = Object.freeze(["supervisor", "lead", "peer"]);

/** Default number of `paseo inspect` calls a single snapshot may spend. */
export const DEFAULT_MAX_INSPECT = 6;

/**
 * "pi-supervisor/Minnyat/deepseek-v4-flash" (ls) and "pi-supervisor"
 * (inspect) must map to the same role, so only the first path segment counts.
 * Anything unrecognized returns null — an unknown provider is displayed as
 * unknown, never bucketed into a role it might not have.
 */
export function inferRole(provider) {
	if (typeof provider !== "string") return null;
	const head = provider.split("/")[0].trim().toLowerCase();
	const bare = head.startsWith("pi-") ? head.slice(3) : head;
	return ROLES.includes(bare) ? bare : null;
}

const PEER_MESSAGE_HEADER = "PEER_MESSAGE_V1";
const HEADER_LINE = /^([A-Z_]+):\s*(.+)$/;

/**
 * Parse a PEER_MESSAGE_V1 block out of arbitrary agent text.
 *
 * Fail-closed: a block missing any field, or carrying a kind outside
 * MESSAGE_KINDS, yields null rather than a half-populated edge. The header is
 * produced by our own sender, so a malformed one means either a version skew
 * or text that merely quotes the marker — neither should become an edge.
 */
export function parsePeerMessage(text) {
	if (typeof text !== "string") return null;
	const start = text.indexOf(PEER_MESSAGE_HEADER);
	if (start < 0) return null;
	const lines = text.slice(start).split(/\r?\n/).slice(1);
	const fields = {};
	for (const line of lines) {
		if (line.trim() === "") break;
		const match = HEADER_LINE.exec(line.trim());
		if (!match) break;
		fields[match[1]] = match[2].trim();
	}
	const kind = fields.KIND;
	const fromAgentId = fields.FROM_AGENT_ID;
	if (!MESSAGE_KINDS.includes(kind)) return null;
	if (!fromAgentId || !fields.CORRELATION_ID || !fields.TASK_ID) return null;
	return {
		kind,
		fromAgentId,
		correlationId: fields.CORRELATION_ID,
		taskId: fields.TASK_ID,
	};
}

const PERMIT_AGENT_KEYS = ["agentId", "AgentId", "agent_id", "agent", "AgentID"];
const PERMIT_REQUEST_KEYS = ["requestId", "RequestId", "request_id", "reqId", "ReqId", "id", "Id"];
const PERMIT_TOOL_KEYS = ["tool", "Tool", "toolName", "ToolName", "name", "Name"];

function firstString(entry, keys) {
	for (const key of keys) {
		const value = entry?.[key];
		if (typeof value === "string" && value.trim() !== "") return value.trim();
	}
	return null;
}

/**
 * Normalize one `paseo permit ls` row.
 *
 * The pending list was empty on every machine available while this was
 * written, so the field names are matched permissively across the casings
 * Paseo uses elsewhere. A row we cannot pin to (agent, request) is NOT
 * dropped: it is returned unclassified so the inbox can still show it —
 * with allow/deny disabled, because approving a request you cannot name is
 * exactly the mistake this UI must not enable.
 */
export function normalizePermit(entry) {
	if (!entry || typeof entry !== "object") return { ok: false, raw: entry };
	const agentId = firstString(entry, PERMIT_AGENT_KEYS);
	const requestId = firstString(entry, PERMIT_REQUEST_KEYS);
	if (!agentId || !requestId) return { ok: false, raw: entry };
	return {
		ok: true,
		agentId,
		requestId,
		tool: firstString(entry, PERMIT_TOOL_KEYS),
		raw: entry,
	};
}

export function normalizePermits(list) {
	const rows = Array.isArray(list) ? list : [];
	const permits = [];
	const unclassified = [];
	for (const row of rows) {
		const normalized = normalizePermit(row);
		if (normalized.ok) permits.push(normalized);
		else unclassified.push(normalized.raw);
	}
	return { permits, unclassified };
}

/**
 * Assemble the snapshot. Pure: same inputs, same output, no clock of its own.
 *
 * @param {object} input
 * @param {Array}  input.agents      rows from `paseo ls -g --json`
 * @param {object} input.parents     { [agentId]: parentId|null } — the known subset
 * @param {Array}  input.permits     rows from `paseo permit ls --json`
 * @param {Array}  [input.messages]  reconstructed message edges
 * @param {Array}  [input.degraded]  collection faults to surface verbatim
 * @param {number} input.now
 */
export function buildGraph({ agents = [], parents = {}, permits = [], messages = [], degraded = [], now = 0 } = {}) {
	const rows = Array.isArray(agents) ? agents.filter((a) => a && typeof a.id === "string") : [];
	const known = new Set(rows.map((a) => a.id));
	const { permits: normalizedPermits, unclassified } = normalizePermits(permits);

	const permitCount = new Map();
	for (const permit of normalizedPermits) {
		permitCount.set(permit.agentId, (permitCount.get(permit.agentId) ?? 0) + 1);
	}

	const faults = [...degraded];
	if (unclassified.length > 0) {
		faults.push({
			reason: "PERMIT_SHAPE_UNRECOGNIZED",
			detail: `${unclassified.length} pending permit row(s) had no recognizable agent/request id`,
		});
	}

	const nodes = rows.map((agent) => {
		const hasParentInfo = Object.hasOwn(parents, agent.id);
		const parentId = hasParentInfo ? parents[agent.id] : null;
		// An agent whose parent exists but is not in the listing (archived, or
		// living in a directory this listing did not cover) must not be drawn
		// as a root: that would silently flatten the tree.
		const orphan = Boolean(parentId) && !known.has(parentId);
		if (orphan) {
			faults.push({ agentId: agent.id, reason: "PARENT_NOT_LISTED", detail: parentId });
		}
		return {
			id: agent.id,
			shortId: typeof agent.shortId === "string" ? agent.shortId : agent.id.slice(0, 7),
			name: typeof agent.name === "string" ? agent.name : "",
			role: inferRole(agent.provider),
			provider: typeof agent.provider === "string" ? agent.provider : null,
			thinking: typeof agent.thinking === "string" ? agent.thinking : null,
			status: typeof agent.status === "string" ? agent.status : "unknown",
			cwd: typeof agent.cwd === "string" ? agent.cwd : null,
			created: typeof agent.created === "string" ? agent.created : null,
			parentId: hasParentInfo ? parentId : null,
			parentKnown: hasParentInfo,
			orphan,
			pendingPermissions: permitCount.get(agent.id) ?? 0,
		};
	});

	const edges = [];
	for (const node of nodes) {
		if (node.parentId && known.has(node.parentId)) {
			edges.push({ type: "spawn", from: node.parentId, to: node.id, confidence: "confirmed" });
		}
	}
	// Message edges are keyed by correlationId: the same PEER_MESSAGE_V1 block
	// can be seen twice (sender log and recipient prompt) and must draw once.
	const seen = new Set();
	for (const message of messages) {
		if (!message || typeof message.from !== "string" || typeof message.to !== "string") continue;
		const key = message.correlationId ?? `${message.from}->${message.to}:${message.ts ?? ""}`;
		if (seen.has(key)) continue;
		seen.add(key);
		edges.push({
			type: "message",
			from: message.from,
			to: message.to,
			kind: message.kind ?? null,
			taskId: message.taskId ?? null,
			correlationId: message.correlationId ?? null,
			ts: message.ts ?? null,
			confidence: message.confidence ?? "suspected",
		});
	}

	const byRole = {};
	const byStatus = {};
	for (const node of nodes) {
		const role = node.role ?? "unknown";
		byRole[role] = (byRole[role] ?? 0) + 1;
		byStatus[node.status] = (byStatus[node.status] ?? 0) + 1;
	}

	return {
		collectedAt: new Date(now).toISOString(),
		counts: {
			agents: nodes.length,
			edges: edges.length,
			pendingPermissions: normalizedPermits.length + unclassified.length,
			byRole,
			byStatus,
		},
		nodes,
		edges,
		permits: normalizedPermits.map(({ ok, raw, ...rest }) => ({ ...rest, raw })),
		unclassifiedPermits: unclassified,
		degraded: faults,
	};
}

/**
 * Collect one snapshot.
 *
 * Cost model (see paseo-bridge.mjs): `ls` and `permit ls` are issued
 * concurrently — one ~3s round trip for both — and at most `maxInspect`
 * parent lookups are spent per call, filling the cache across successive
 * polls instead of blocking a minute on a cold start. `pendingParents` tells
 * the UI the tree is still being drawn rather than letting it look complete.
 */
export async function collectGraph(options = {}) {
	const now = options.now ?? Date.now();
	const maxInspect = Math.max(0, Math.floor(options.maxInspect ?? DEFAULT_MAX_INSPECT));
	const run = options.runPaseoJson ?? runPaseoJson;
	const timeoutMs = options.timeoutMs;
	const listArgs = options.all ? ["ls", "-g", "-a"] : ["ls", "-g"];
	const degraded = [];

	const [listed, permitted] = await Promise.all([
		run(listArgs, { timeoutMs }).catch((error) => error),
		run(["permit", "ls"], { timeoutMs }).catch((error) => error),
	]);

	if (listed instanceof Error) {
		// No agent list means no graph at all. Report the fault as data instead
		// of throwing: the WebUI must still render a page that explains itself.
		return {
			...buildGraph({ now }),
			ok: false,
			degraded: [{ reason: listed.code ?? "LIST_FAILED", detail: String(listed.message ?? listed) }],
		};
	}
	const agents = Array.isArray(listed) ? listed : [];
	let permits = [];
	if (permitted instanceof Error) {
		degraded.push({ reason: permitted.code ?? "PERMIT_LIST_FAILED", detail: String(permitted.message ?? permitted) });
	} else if (Array.isArray(permitted)) {
		permits = permitted;
	} else {
		degraded.push({ reason: "PERMIT_SHAPE_UNRECOGNIZED", detail: "permit ls did not return an array" });
	}

	const store = options.cache ?? cache.readParentCache();
	const ids = agents.map((agent) => agent.id).filter((id) => typeof id === "string");
	const stale = cache.staleIds(ids, store, { now, ttlMs: options.parentTtlMs });
	const budget = stale.slice(0, maxInspect);

	const inspected = await mapWithConcurrency(budget, options.concurrency ?? 4, (id) =>
		run(["inspect", id], { timeoutMs }),
	);
	inspected.forEach((result, index) => {
		const id = budget[index];
		if (result.ok) {
			const detail = result.value ?? {};
			cache.rememberParent(store, id, detail.ParentAgentId ?? detail.parentAgentId ?? null, now);
		} else {
			degraded.push({
				agentId: id,
				reason: result.error?.code ?? "INSPECT_FAILED",
				detail: String(result.error?.message ?? result.error),
			});
		}
	});

	cache.pruneCache(store, ids);
	if (options.persistCache !== false) {
		try {
			cache.writeParentCache(store);
		} catch (error) {
			degraded.push({ reason: "CACHE_WRITE_FAILED", detail: String(error?.message ?? error) });
		}
	}

	const parents = {};
	for (const id of ids) {
		const entry = store.parents?.[id];
		if (entry) parents[id] = entry.parentId;
	}

	const graph = buildGraph({ agents, parents, permits, degraded, now });
	return {
		...graph,
		ok: true,
		pendingParents: Math.max(0, stale.length - budget.length),
		inspectSpent: budget.length,
	};
}

export { PaseoError };

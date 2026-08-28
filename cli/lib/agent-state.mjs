/**
 * agent-state.mjs — read what Paseo already knows about an agent, off disk.
 *
 * Paseo persists one JSON file per agent at
 * `$PASEO_HOME/agents/<cwd-slug>/<agent-id>.json`, and it carries everything
 * the team graph previously had to buy with `paseo inspect`:
 *
 *   labels["paseo.parent-agent-id"]  -> the spawn edge   (was: inspect, ~3s each)
 *   labels["team.domain"]            -> which supervisor/lead owns this seat
 *   runtimeInfo.model / thinking     -> what the agent ACTUALLY runs
 *   runtimeInfo.sessionId            -> the pi session id
 *   persistence.nativeHandle         -> the pi session JSONL path (fork/handoff)
 *
 * Two deliberate rules, both measured on 2026-08-28:
 *
 *   - `runtimeInfo.model` wins over `config.model`, and
 *     `persistence.metadata.model` is NEVER a model source: it is a
 *     creation-time snapshot that Paseo does not rewrite when the model is
 *     changed through `update_agent`, so trusting it reports a model the agent
 *     is not running.
 *   - Agents are found by SCANNING the agents root, not by recomputing the
 *     cwd slug. The slug rule (drop `:`, separators to `-`) is undocumented
 *     and would silently mis-resolve the day it changes; an id-keyed scan
 *     cannot.
 *
 * The whole surface (`paseo import`, this file layout) is undocumented — see
 * docs/multi-supervisor-topology.md §1.13 — so every read here degrades into
 * data rather than throwing: a graph that admits a gap beats one that lies.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { paseoAgentsDir } from "./config-walker.mjs";

export const AGENT_DOMAIN_LABEL = "team.domain";
export const AGENT_PARENT_LABEL = "paseo.parent-agent-id";

/** Paseo agent ids are UUIDs. Anything else never becomes a path segment. */
const AGENT_ID = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

export function isAgentId(value) {
	return typeof value === "string" && AGENT_ID.test(value);
}

function str(value) {
	return typeof value === "string" && value.trim() !== "" ? value : null;
}

/**
 * Build `{ [agentId]: absoluteFilePath }` by scanning one level of cwd-slug
 * directories. One pass serves a whole snapshot, which is the access pattern
 * every caller has (`agents`, `graph`).
 */
export function buildStateIndex(root = paseoAgentsDir()) {
	const index = {};
	const degraded = [];
	let slugs;
	try {
		slugs = readdirSync(root, { withFileTypes: true });
	} catch (error) {
		// A missing root is the normal state of a machine Paseo has not written
		// agent state on — a fresh host, a sandbox, another PASEO_HOME. The
		// enrichment is simply unavailable; the graph still renders from `ls`.
		// Anything else (permissions, a file where the directory should be) IS a
		// fault, because it means the data exists and we could not read it.
		if (error?.code === "ENOENT") return { index, degraded: [] };
		return {
			index,
			degraded: [{ reason: "AGENT_STATE_ROOT_UNREADABLE", detail: `${root}: ${String(error?.message ?? error)}` }],
		};
	}
	for (const slug of slugs) {
		if (!slug.isDirectory()) continue;
		const dir = join(root, slug.name);
		let files;
		try {
			files = readdirSync(dir);
		} catch (error) {
			degraded.push({ reason: "AGENT_STATE_DIR_UNREADABLE", detail: `${dir}: ${String(error?.message ?? error)}` });
			continue;
		}
		for (const file of files) {
			if (!file.endsWith(".json")) continue;
			const id = file.slice(0, -".json".length);
			if (!isAgentId(id)) continue;
			index[id] = join(dir, file);
		}
	}
	return { index, degraded };
}

/**
 * Normalize one raw state object. Pure: same input, same output, no I/O.
 * Returns null for anything that is not an object, so a junk file is a fault
 * about one agent instead of an exception that ends the snapshot.
 */
export function normalizeAgentState(raw, agentId) {
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
	const labels =
		raw.labels && typeof raw.labels === "object" && !Array.isArray(raw.labels)
			? { ...raw.labels }
			: {};
	const runtime = raw.runtimeInfo && typeof raw.runtimeInfo === "object" ? raw.runtimeInfo : {};
	const config = raw.config && typeof raw.config === "object" ? raw.config : {};
	const persistence = raw.persistence && typeof raw.persistence === "object" ? raw.persistence : {};

	const runtimeModel = str(runtime.model);
	const configModel = str(config.model);
	const model = runtimeModel ?? configModel;

	return {
		agentId: str(raw.id) ?? agentId,
		provider: str(raw.provider),
		cwd: str(raw.cwd),
		workspaceId: str(raw.workspaceId),
		title: str(raw.title),
		labels,
		domain: str(labels[AGENT_DOMAIN_LABEL]),
		parentAgentId: str(labels[AGENT_PARENT_LABEL]),
		model,
		modelSource: runtimeModel ? "runtime" : configModel ? "config" : null,
		// Only a real disagreement counts: a missing runtimeInfo (agent not
		// started yet) is not drift, it is "not known yet".
		modelDrift: Boolean(runtimeModel && configModel && runtimeModel !== configModel),
		thinking: str(runtime.thinkingOptionId),
		sessionId: str(runtime.sessionId) ?? str(persistence.sessionId),
		sessionFile: str(persistence.nativeHandle),
	};
}

/**
 * Read normalized state for the given agent ids.
 *
 * @param {string[]} ids
 * @param {{ root?: string, index?: Record<string,string> }} [options]
 * @returns {{ states: Record<string, object>, degraded: Array<object>, index: Record<string,string> }}
 */
export function readAgentStates(ids, options = {}) {
	const root = options.root ?? paseoAgentsDir();
	const built = options.index ? { index: options.index, degraded: [] } : buildStateIndex(root);
	const states = {};
	const degraded = [...built.degraded];

	for (const id of Array.isArray(ids) ? ids : []) {
		if (!isAgentId(id)) {
			degraded.push({ agentId: typeof id === "string" ? id : String(id), reason: "AGENT_STATE_ID_INVALID" });
			continue;
		}
		const path = built.index[id];
		if (!path) {
			degraded.push({ agentId: id, reason: "AGENT_STATE_MISSING" });
			continue;
		}
		let normalized = null;
		try {
			normalized = normalizeAgentState(JSON.parse(readFileSync(path, "utf8")), id);
		} catch (error) {
			degraded.push({ agentId: id, reason: "AGENT_STATE_UNREADABLE", detail: String(error?.message ?? error) });
			continue;
		}
		if (!normalized) {
			degraded.push({ agentId: id, reason: "AGENT_STATE_UNREADABLE", detail: "state file is not a JSON object" });
			continue;
		}
		states[id] = normalized;
	}
	return { states, degraded, index: built.index };
}

/** Present only so callers can report the root they actually read. */
export function agentStateRoot() {
	try {
		const root = paseoAgentsDir();
		statSync(root);
		return root;
	} catch {
		return null;
	}
}

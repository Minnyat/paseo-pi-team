/**
 * agent-state.mjs — CLI-side view of Paseo's per-agent state files.
 *
 * The reading itself lives in `extensions/paseo-team-core/agent-directory.ts`,
 * because the POLICY needs the same facts: the `send_agent_prompt` ownership
 * guard (PR-D) decides who owns an agent, and `pteam graph` draws it. Two
 * readers would eventually disagree, and a graph that disagrees with the policy
 * is worse than no graph. This module only binds that reader to the CLI's own
 * path resolution (`config-walker.paseoAgentsDir`) and keeps the export surface
 * the CLI and its tests already use.
 */

import { statSync } from "node:fs";
import {
	AGENT_DOMAIN_LABEL,
	AGENT_PARENT_LABEL,
	buildStateIndex as buildStateIndexAt,
	isAgentId,
	normalizeAgentState,
	readAgentStates as readAgentStatesAt,
} from "../../extensions/paseo-team-core/agent-directory.js";
import { paseoAgentsDir } from "./config-walker.mjs";

export {
	AGENT_DOMAIN_LABEL,
	AGENT_PARENT_LABEL,
	isAgentId,
	normalizeAgentState,
};

export function buildStateIndex(root = paseoAgentsDir()) {
	return buildStateIndexAt(root);
}

/**
 * Read normalized state for the given agent ids.
 *
 * @param {string[]} ids
 * @param {{ root?: string, index?: Record<string,string> }} [options]
 * @returns {{ states: Record<string, object>, degraded: Array<object>, index: Record<string,string> }}
 */
export function readAgentStates(ids, options = {}) {
	return readAgentStatesAt(ids, { ...options, root: options.root ?? paseoAgentsDir() });
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

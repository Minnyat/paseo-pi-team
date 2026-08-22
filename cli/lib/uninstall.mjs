/**
 * uninstall.mjs — the inverse of scripts/install.* plus the pack's runtime
 * footprints. Every removal is scoped to artifacts this pack owns:
 *
 *   - shared locations (the prompts dir, the skills dir, mcp.json) only ever
 *     lose *named items* — never a whole directory or file another tool may
 *     also live in.
 *   - ~/.paseo-pi-team holds the permit audit log, an accountability record
 *     of every allow/deny decision, so it survives uninstall unless --purge
 *     explicitly asks for it.
 *
 * Idempotent by design: a second run reports every target as "missing" and
 * still succeeds, so uninstall can be re-run after a partial failure.
 */

import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import * as cw from "./config-walker.mjs";

/** The one mcp.json server entry browser-setup.mjs adds; nothing else is ours. */
export const MCP_ENTRY = "agent-browser";

export function teamScriptsDir() {
	return join(cw.extensionsDir(), "paseo-team-scripts");
}

function removePath(kind, absPath) {
	if (!existsSync(absPath)) return { kind, path: absPath, status: "missing" };
	rmSync(absPath, { recursive: true, force: true });
	return { kind, path: absPath, status: "removed" };
}

/** Removes only the pack's own server entry; other tools' entries stay. */
export function removeMcpEntry(mcpPath = cw.mcpConfigPath()) {
	const cfg = cw.readJsonOrNull(mcpPath);
	if (cfg === null) return { path: mcpPath, entry: MCP_ENTRY, status: "mcp-config-missing" };
	if (!cfg.mcpServers || typeof cfg.mcpServers !== "object" || !(MCP_ENTRY in cfg.mcpServers)) {
		return { path: mcpPath, entry: MCP_ENTRY, status: "entry-missing" };
	}
	delete cfg.mcpServers[MCP_ENTRY];
	// atomicWriteJson parks a timestamped backup next to mcp.json, so even a
	// wrong removal is recoverable from the .bak-* sibling.
	cw.atomicWriteJson(mcpPath, JSON.stringify(cfg));
	return { path: mcpPath, entry: MCP_ENTRY, status: "removed" };
}

export function uninstall({ purge = false } = {}) {
	const targets = [
		removePath("policy-extension", cw.policyExtensionPath()),
		...cw.ROLE_PROMPTS.map((role) => removePath(`prompt-${role}`, cw.rolePromptPath(role))),
		...cw.PACK_SKILLS.map((name) => removePath(`skill-${name}`, cw.skillDirPath(name))),
		removePath("team-scripts", teamScriptsDir()),
	];
	const mcp = removeMcpEntry();

	const teamDir = cw.teamConfigDir();
	let teamData;
	if (purge) {
		teamData = removePath("team-data", teamDir);
	} else {
		teamData = {
			kind: "team-data",
			path: teamDir,
			status: existsSync(teamDir) ? "kept" : "missing",
			reason: "holds the permit audit log; re-run with --purge to delete it",
		};
	}

	const all = [...targets, mcp, teamData];
	return {
		purge,
		targets,
		mcp,
		teamData,
		summary: {
			removed: all.filter((t) => t.status === "removed").length,
			missing: all.filter((t) => ["missing", "entry-missing", "mcp-config-missing"].includes(t.status)).length,
			kept: all.filter((t) => t.status === "kept").length,
		},
	};
}

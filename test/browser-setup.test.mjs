import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	AGENT_BROWSER_MCP_SERVER,
	browserMcpConfig,
	mergeAgentBrowserMcpConfig,
	mcpConfigCandidates,
	skillIsInstalled,
} from "../scripts/browser-setup.mjs";

// Existing MCP servers/config must survive installation byte-for-byte in meaning.
{
	const existing = {
		settings: { toolPrefix: "server" },
		mcpServers: {
			github: { command: "gh-mcp", args: ["serve"] },
			[AGENT_BROWSER_MCP_SERVER]: {
				command: "custom-agent-browser",
				args: ["mcp", "--tools", "core"],
				disabled: true,
			},
		},
	};
	const merged = mergeAgentBrowserMcpConfig(existing);
	assert.deepEqual(
		merged,
		existing,
		"existing agent-browser config is never overwritten",
	);
}

{
	const merged = mergeAgentBrowserMcpConfig({
		mcpServers: { github: { command: "gh" } },
	});
	assert.deepEqual(merged.mcpServers.github, { command: "gh" });
	assert.deepEqual(
		merged.mcpServers[AGENT_BROWSER_MCP_SERVER],
		browserMcpConfig(),
	);
}

assert.equal(
	mergeAgentBrowserMcpConfig({}).mcpServers[AGENT_BROWSER_MCP_SERVER].args[0],
	"mcp",
);
assert.ok(
	mcpConfigCandidates("C:/pi").some((path) =>
		/agent[\\/]mcp\.json$/.test(path),
	),
);
const skillRoot = mkdtempSync(join(tmpdir(), "paseo-browser-test-"));
mkdirSync(join(skillRoot, "agent-browser"), { recursive: true });
writeFileSync(join(skillRoot, "agent-browser", "SKILL.md"), "# test\n");
assert.equal(
	skillIsInstalled(join(skillRoot, "agent-browser", "SKILL.md")),
	true,
);
assert.equal(skillIsInstalled(join(skillRoot, "agent-browser")), false);
rmSync(skillRoot, { recursive: true, force: true });

console.log("[paseo-team] browser setup tests passed");

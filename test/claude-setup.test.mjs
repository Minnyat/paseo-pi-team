// claude-setup.test.mjs — installing the Claude half of the pack.
//
// ~/.claude/settings.json and ~/.claude.json belong to the USER and already
// carry other tools' entries (Paseo installs its own hooks in the same file).
// The contract under test: merge, never replace; tag our own entries so an
// upgrade updates instead of duplicating; remove only what we added; and never
// rewrite a file we could not parse.

import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	buildProviderSnippet,
	claudeSettingsPath,
	claudeUserConfigPath,
	hookEntry,
	hookScriptPath,
	install,
	installedHookScripts,
	mergeHooks,
	mergeMcpServer,
	normalizePath,
	removeHooks,
	removeMcpServer,
	uninstall,
	verify,
	mergeBrowserMcpServer,
	removeBrowserMcpServer,
	HOOK_EVENTS,
	PASEO_TEAM_HOOK_TAG,
	TEAM_MCP_SERVER_NAME,
} from "../scripts/claude-setup.mjs";
import { AGENT_BROWSER_MCP_SERVER } from "../scripts/browser-setup.mjs";

const home = mkdtempSync(join(tmpdir(), "paseo-claude-setup-"));
const claudeDir = join(home, ".claude");
mkdirSync(claudeDir, { recursive: true });
const userConfigPath = join(home, ".claude.json");
const env = {
	...process.env,
	CLAUDE_CONFIG_DIR: claudeDir,
	PASEO_TEAM_CLAUDE_USER_CONFIG: userConfigPath,
};

assert.equal(claudeSettingsPath(env), join(claudeDir, "settings.json"));
assert.equal(claudeUserConfigPath(env), userConfigPath);
// The user config is NOT under CLAUDE_CONFIG_DIR: without its own override a
// test run would edit the developer's real MCP config.
assert.notEqual(claudeUserConfigPath({}), join(claudeDir, ".claude.json"));

// --- pure merges --------------------------------------------------------------

{
	// A foreign hook (Paseo's own) must survive ours being added.
	const foreign = {
		matcher: "",
		hooks: [{ type: "command", command: "paseo hooks claude UserPromptSubmit" }],
	};
	const settings = { model: "opus", hooks: { UserPromptSubmit: [foreign] } };
	const merged = mergeHooks(settings, env);
	assert.equal(merged.model, "opus");
	assert.deepEqual(merged.hooks.UserPromptSubmit[0], foreign);
	assert.equal(merged.hooks.UserPromptSubmit.length, 2);
	for (const event of Object.keys(HOOK_EVENTS)) {
		const ours = merged.hooks[event].filter((entry) => entry[PASEO_TEAM_HOOK_TAG]);
		assert.equal(ours.length, 1, `${event}: exactly one tagged entry`);
		assert.match(ours[0].hooks[0].command, /claude-hook\.mjs" [a-z-]+$/);
	}
	// Input is never mutated.
	assert.equal(settings.hooks.UserPromptSubmit.length, 1);

	// Re-merging replaces our entry instead of appending a second one.
	const twice = mergeHooks(merged, env);
	assert.equal(twice.hooks.PreToolUse.length, 1);
	assert.equal(twice.hooks.UserPromptSubmit.length, 2);

	// Removal takes ours out and leaves the foreign one.
	const removed = removeHooks(twice);
	assert.deepEqual(removed.hooks.UserPromptSubmit, [foreign]);
	assert.equal(removed.hooks.PreToolUse, undefined, "empty event key is dropped");
}

{
	// An untagged legacy entry pointing at our script is still ours.
	const legacy = {
		matcher: "*",
		hooks: [{ type: "command", command: "node /old/path/claude-hook.mjs pre-tool-use" }],
	};
	const merged = mergeHooks({ hooks: { PreToolUse: [legacy] } }, env);
	assert.equal(merged.hooks.PreToolUse.length, 1, "upgraded in place, not duplicated");
	assert.equal(merged.hooks.PreToolUse[0][PASEO_TEAM_HOOK_TAG], true);
}

{
	const config = { mcpServers: { other: { type: "stdio", command: "x" } } };
	const merged = mergeMcpServer(config, env);
	assert.deepEqual(merged.mcpServers.other, { type: "stdio", command: "x" });
	assert.equal(merged.mcpServers[TEAM_MCP_SERVER_NAME].type, "stdio");
	assert.match(merged.mcpServers[TEAM_MCP_SERVER_NAME].args[0], /claude-team-mcp\.mjs$/);
	const removed = removeMcpServer(merged);
	assert.deepEqual(Object.keys(removed.mcpServers), ["other"]);
	// Removing when absent is a no-op, not an error.
	assert.deepEqual(removeMcpServer({ mcpServers: {} }).mcpServers, {});
	assert.deepEqual(removeMcpServer({}), {});
}

// Hook commands use forward slashes even on Windows: they may be handed to a
// shell, where a backslash path would be read as escapes.
{
	const entry = hookEntry("PreToolUse", env);
	assert.ok(!entry.hooks[0].command.includes("\\"), entry.hooks[0].command);
	// Empty matcher = all tools, the same form Paseo's own hooks use in this
	// file. A matcher that matches nothing would disable the policy silently.
	assert.equal(entry.matcher, "");
	assert.equal(hookEntry("SessionStart", env).matcher, "");
	assert.ok(normalizePath("C:\\a\\b").endsWith("/a/b") || normalizePath("/a/b").endsWith("/a/b"));
}

// --- install / verify / uninstall on disk ------------------------------------

{
	writeFileSync(
		join(claudeDir, "settings.json"),
		JSON.stringify({ model: "opus[1m]", hooks: { Stop: [{ matcher: "", hooks: [] }] } }, null, 2),
		"utf8",
	);
	writeFileSync(userConfigPath, JSON.stringify({ mcpServers: { other: {} } }, null, 2), "utf8");

	const before = await verify(env);
	assert.equal(before.ok, false);
	assert.ok(before.missing.includes("hook:PreToolUse"));

	const installed = await install(env);
	assert.equal(installed.ok, true);
	assert.equal(installed.hooks.status, "updated");
	assert.equal(installed.mcp.status, "updated");

	const after = await verify(env);
	assert.equal(after.ok, true, JSON.stringify(after.missing));
	assert.deepEqual(after.hooks, { SessionStart: true, UserPromptSubmit: true, PreToolUse: true });
	assert.equal(after.mcpServer, true);

	// Idempotent: a second install changes nothing on disk.
	const again = await install(env);
	assert.equal(again.hooks.status, "unchanged");
	assert.equal(again.mcp.status, "unchanged");

	// The user's own settings survived.
	const settings = JSON.parse(readFileSync(join(claudeDir, "settings.json"), "utf8"));
	assert.equal(settings.model, "opus[1m]");
	assert.ok(settings.hooks.Stop);
	// A backup was parked next to the file before the first write.
	assert.ok(readdirSync(claudeDir).some((name) => name.includes("settings.json.bak-")));

	const removedResult = await uninstall(env);
	assert.equal(removedResult.ok, true);
	const settingsAfter = JSON.parse(readFileSync(join(claudeDir, "settings.json"), "utf8"));
	assert.equal(settingsAfter.model, "opus[1m]");
	assert.ok(settingsAfter.hooks.Stop, "foreign hooks survive uninstall");
	assert.equal(settingsAfter.hooks.PreToolUse, undefined);
	const configAfter = JSON.parse(readFileSync(userConfigPath, "utf8"));
	assert.deepEqual(Object.keys(configAfter.mcpServers), ["other"]);
	assert.equal((await verify(env)).ok, false);
}

// A present-but-corrupt file is reported, never rewritten.
{
	const corruptDir = mkdtempSync(join(tmpdir(), "paseo-claude-corrupt-"));
	const corruptSettings = join(corruptDir, "settings.json");
	writeFileSync(corruptSettings, "{ not json", "utf8");
	const corruptEnv = {
		...process.env,
		CLAUDE_CONFIG_DIR: corruptDir,
		PASEO_TEAM_CLAUDE_USER_CONFIG: join(corruptDir, ".claude.json"),
	};
	const result = await install(corruptEnv);
	assert.equal(result.ok, false);
	assert.equal(result.hooks.status, "failed");
	assert.equal(readFileSync(corruptSettings, "utf8"), "{ not json", "bytes untouched");
	// The other file is independent and still gets installed.
	assert.equal(result.mcp.status, "created");
	rmSync(corruptDir, { recursive: true, force: true });
}

// A missing settings file is created rather than treated as an error.
{
	const freshDir = join(home, "fresh");
	const freshEnv = {
		...process.env,
		CLAUDE_CONFIG_DIR: freshDir,
		PASEO_TEAM_CLAUDE_USER_CONFIG: join(freshDir, ".claude.json"),
	};
	const result = await install(freshEnv);
	assert.equal(result.hooks.status, "created");
	assert.ok(existsSync(join(freshDir, "settings.json")));
}

// --- verify reports the REGISTERED script, not the one we would install -------
//
// A hook left pointing at a moved checkout is the stale-install failure mode
// this command exists to catch, so verify must read the path out of the
// settings file and check every one of them.
{
	const staleDir = mkdtempSync(join(tmpdir(), "paseo-claude-stale-"));
	const staleEnv = {
		...process.env,
		CLAUDE_CONFIG_DIR: staleDir,
		PASEO_TEAM_CLAUDE_USER_CONFIG: join(staleDir, ".claude.json"),
	};
	await install(staleEnv);
	const settingsFile = join(staleDir, "settings.json");
	const settings = JSON.parse(readFileSync(settingsFile, "utf8"));
	assert.deepEqual(installedHookScripts(settings), [hookScriptPath(staleEnv)]);
	assert.deepEqual(installedHookScripts({}), []);
	assert.equal((await verify(staleEnv)).ok, true);

	// Break ONE event only: a partially re-pointed install must still fail.
	for (const entry of settings.hooks.PreToolUse) {
		if (!entry[PASEO_TEAM_HOOK_TAG]) continue;
		entry.hooks[0].command = entry.hooks[0].command.replace(
			/"[^"]+claude-hook\.mjs"/,
			'"/nowhere/claude-hook.mjs"',
		);
	}
	writeFileSync(settingsFile, JSON.stringify(settings, null, 2), "utf8");
	const stale = await verify(staleEnv);
	assert.equal(stale.ok, false, "a hook pointing at a missing script is not ok");
	assert.ok(stale.missing.some((item) => item.includes("/nowhere/claude-hook.mjs")));
	assert.ok(stale.hookScripts.includes("/nowhere/claude-hook.mjs"));
	rmSync(staleDir, { recursive: true, force: true });
}

// --- provider snippet ---------------------------------------------------------

{
	const snippet = await buildProviderSnippet(env);
	const providers = snippet.agents.providers;
	assert.deepEqual(Object.keys(providers).sort(), [
		"claude-lead",
		"claude-peer",
		"claude-supervisor",
	]);
	for (const [name, provider] of Object.entries(providers)) {
		assert.equal(provider.extends, "claude");
		assert.equal(provider.env.PASEO_PI_ROLE, name.replace("claude-", ""));
		assert.ok(provider.disallowedTools.includes("Task"));
	}
	assert.ok(providers["claude-supervisor"].disallowedTools.includes("Bash"));
	assert.ok(!providers["claude-peer"].disallowedTools.includes("Write"));

	// The checked-in example config must match what the code generates, or an
	// operator who copies it gets a policy the code does not enforce.
	const example = JSON.parse(
		readFileSync(new URL("../config/paseo.providers.example.json", import.meta.url), "utf8"),
	);
	for (const [name, provider] of Object.entries(providers)) {
		assert.deepEqual(example.agents.providers[name], provider, `${name} drifted from the generator`);
	}
	assert.ok(example.agents.providers["pi-peer"], "pi providers stay in the example");
}

// --- agent-browser on the Claude side -----------------------------------------
//
// The Lead may drive a browser and a granted Peer may too (claude-policy.ts
// classifies mcp__agent-browser__* before the role allowlist), but a tool the
// runtime never registered cannot be called. Pi got its entry from
// browser-setup.mjs; ~/.claude.json is owned by this module, so the same
// server has to be registered here or the Claude half of that policy is dead.
{
	const merged = mergeBrowserMcpServer({ mcpServers: { other: { command: "x" } } });
	assert.deepEqual(merged.mcpServers.other, { command: "x" });
	assert.deepEqual(merged.mcpServers[AGENT_BROWSER_MCP_SERVER], {
		type: "stdio",
		command: "agent-browser",
		args: ["mcp"],
	});

	// Attach mode reaches Claude through the same flag the pi entry gets.
	assert.deepEqual(
		mergeBrowserMcpServer({}, { cdpPort: 9222 }).mcpServers[AGENT_BROWSER_MCP_SERVER].args,
		["--cdp", "9222", "mcp"],
	);

	// An entry the user already owns is never rewritten — same rule as pi.
	const owned = {
		mcpServers: {
			[AGENT_BROWSER_MCP_SERVER]: { command: "agent-browser", args: ["--cdp", "9333", "mcp"] },
		},
	};
	assert.deepEqual(mergeBrowserMcpServer(owned), owned);

	const removed = removeBrowserMcpServer(merged);
	assert.deepEqual(Object.keys(removed.mcpServers), ["other"]);
	assert.deepEqual(removeBrowserMcpServer({}), {});
}

// install/verify/uninstall must cover BOTH servers, on a fresh config file.
{
	const browserDir = mkdtempSync(join(tmpdir(), "paseo-claude-browser-"));
	const browserConfig = join(browserDir, ".claude.json");
	const browserEnv = {
		...process.env,
		CLAUDE_CONFIG_DIR: browserDir,
		PASEO_TEAM_CLAUDE_USER_CONFIG: browserConfig,
	};

	const before = await verify(browserEnv);
	assert.equal(before.browserMcpServer, false);
	assert.ok(
		before.missing.includes(`mcp:${AGENT_BROWSER_MCP_SERVER}`),
		"a missing browser server is reported, not silently passed",
	);

	const installed = await install(browserEnv);
	assert.equal(installed.ok, true);
	const config = JSON.parse(readFileSync(browserConfig, "utf8"));
	assert.ok(config.mcpServers[TEAM_MCP_SERVER_NAME], "the team server is still installed");
	assert.equal(config.mcpServers[AGENT_BROWSER_MCP_SERVER].command, "agent-browser");

	const after = await verify(browserEnv);
	assert.equal(after.browserMcpServer, true);
	assert.equal(after.ok, true, JSON.stringify(after.missing));

	// Idempotent: the second install writes nothing.
	assert.equal((await install(browserEnv)).mcp.status, "unchanged");

	// A disabled entry is present but unusable — verify must not call it ok.
	const disabled = JSON.parse(readFileSync(browserConfig, "utf8"));
	disabled.mcpServers[AGENT_BROWSER_MCP_SERVER].disabled = true;
	writeFileSync(browserConfig, JSON.stringify(disabled, null, 2), "utf8");
	assert.equal((await verify(browserEnv)).browserMcpServer, false);
	writeFileSync(browserConfig, JSON.stringify(config, null, 2), "utf8");

	await uninstall(browserEnv);
	const cleaned = JSON.parse(readFileSync(browserConfig, "utf8"));
	assert.equal(cleaned.mcpServers[AGENT_BROWSER_MCP_SERVER], undefined);
	assert.equal(cleaned.mcpServers[TEAM_MCP_SERVER_NAME], undefined);
	rmSync(browserDir, { recursive: true, force: true });
}

// A requested attach port that contradicts the entry already on disk is an
// error you can see, not an install that silently keeps the old mode.
{
	const conflictDir = mkdtempSync(join(tmpdir(), "paseo-claude-cdp-"));
	const conflictConfig = join(conflictDir, ".claude.json");
	writeFileSync(
		conflictConfig,
		JSON.stringify({
			mcpServers: {
				[AGENT_BROWSER_MCP_SERVER]: { command: "agent-browser", args: ["mcp"] },
			},
		}, null, 2),
		"utf8",
	);
	const conflictEnv = {
		...process.env,
		CLAUDE_CONFIG_DIR: conflictDir,
		PASEO_TEAM_CLAUDE_USER_CONFIG: conflictConfig,
	};
	const result = await install(conflictEnv, { cdpPort: 9222 });
	assert.equal(result.ok, false);
	assert.equal(result.mcp.status, "failed");
	assert.match(result.mcp.error, /9222/);
	assert.deepEqual(
		JSON.parse(readFileSync(conflictConfig, "utf8")).mcpServers[AGENT_BROWSER_MCP_SERVER].args,
		["mcp"],
		"the user's entry is left exactly as it was",
	);
	rmSync(conflictDir, { recursive: true, force: true });
}

rmSync(home, { recursive: true, force: true });
console.log("claude setup tests passed");

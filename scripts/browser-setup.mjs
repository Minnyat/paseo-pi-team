#!/usr/bin/env node
// Idempotent agent-browser setup for the Paseo + Pi role pack.
//
// agent-browser is both a CLI and an MCP stdio server (`agent-browser mcp`).
// Pi's MCP adapter reads the user-global config at ~/.pi/agent/mcp.json, so
// this script adds only the missing server entry and never rewrites an
// existing server definition.

import { spawnSync } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	readFileSync,
	renameSync,
	rmSync,
	cpSync,
	writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

export const AGENT_BROWSER_PACKAGE = "agent-browser";
export const AGENT_BROWSER_MCP_SERVER = "agent-browser";

export function browserMcpConfig() {
	return {
		command: "agent-browser",
		args: ["mcp"],
		lifecycle: "lazy",
	};
}

/** Add agent-browser only when the user has not configured that server yet. */
export function mergeAgentBrowserMcpConfig(config) {
	const source =
		config && typeof config === "object" && !Array.isArray(config)
			? config
			: {};
	const servers =
		source.mcpServers &&
		typeof source.mcpServers === "object" &&
		!Array.isArray(source.mcpServers)
			? source.mcpServers
			: {};
	if (Object.hasOwn(servers, AGENT_BROWSER_MCP_SERVER)) return source;
	return {
		...source,
		mcpServers: {
			...servers,
			[AGENT_BROWSER_MCP_SERVER]: browserMcpConfig(),
		},
	};
}

export function skillIsInstalled(skillPath) {
	return (
		typeof skillPath === "string" &&
		skillPath.endsWith("SKILL.md") &&
		existsSync(skillPath)
	);
}

function defaultAgentDir(piHome) {
	return piHome
		? join(piHome, "agent")
		: (process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent"));
}

export function defaultMcpConfigPath(piHome) {
	return join(defaultAgentDir(piHome), "mcp.json");
}

export function defaultSkillPath(piHome) {
	return join(defaultAgentDir(piHome), "skills", "agent-browser");
}

/** User-global MCP files considered by pi-mcp-adapter, in precedence order. */
export function mcpConfigCandidates(piHome, cwd = process.cwd()) {
	const agentDir = defaultAgentDir(piHome);
	const home = homedir();
	return [
		join(home, ".config", "mcp", "mcp.json"),
		join(home, ".agents", "mcp.json"),
		join(home, ".agents", "mcp", "mcp.json"),
		join(agentDir, "mcp.json"),
		join(cwd, ".mcp.json"),
		join(cwd, ".pi", "mcp.json"),
	];
}

const EXECUTABLES = Object.freeze({
	agentBrowser: "agent-browser",
	npm: "npm",
});

function run(tool, args, options = {}) {
	const executable = EXECUTABLES[tool];
	if (!executable) throw new Error(`unsupported setup executable: ${tool}`);
	const isWindows = process.platform === "win32";
	const command = isWindows ? process.env.ComSpec || "cmd.exe" : executable;
	const commandArgs = isWindows
		? ["/d", "/s", "/c", `${executable}.cmd`, ...args]
		: args;
	const result = spawnSync(command, commandArgs, {
		encoding: "utf8",
		timeout: options.timeout ?? 120000,
		stdio: ["ignore", "pipe", "pipe"],
		shell: false,
		env: process.env,
	});
	return {
		ok: result.status === 0,
		stdout: String(result.stdout ?? ""),
		stderr: String(result.stderr ?? ""),
		status: result.status,
		error: result.error ? String(result.error.message ?? result.error) : "",
	};
}

function readJson(path) {
	if (!existsSync(path)) return {};
	const text = readFileSync(path, "utf8");
	let value;
	try {
		value = JSON.parse(text);
	} catch (error) {
		throw new Error(
			`${path} contains invalid JSON: ${String(error?.message ?? error)}`,
		);
	}
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw new Error(`${path} must contain a JSON object`);
	}
	return value;
}

function writeJsonAtomic(path, value) {
	mkdirSync(dirname(path), { recursive: true });
	const temp = `${path}.${process.pid}.tmp`;
	writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, {
		encoding: "utf8",
		mode: 0o600,
	});
	try {
		renameSync(temp, path);
	} catch (error) {
		rmSync(temp, { force: true });
		throw error;
	}
}

function commandOutputPath(output) {
	return (
		output
			.trim()
			.split(/\r?\n/)
			.map((line) => line.trim())
			.find((line) => line.length > 0) ?? ""
	);
}

export function inspectAgentBrowser({ piHome, configPath, skillPath } = {}) {
	const resolvedConfig = configPath ?? defaultMcpConfigPath(piHome);
	const resolvedSkill = skillPath ?? defaultSkillPath(piHome);
	const version = run("agentBrowser", ["--version"], { timeout: 30000 });
	const configPaths = configPath ? [configPath] : mcpConfigCandidates(piHome);
	const configs = configPaths.map((path) => {
		try {
			return { path, config: readJson(path) };
		} catch {
			return { path, config: null };
		}
	});
	const configWithServer = configs.find(
		(entry) => entry.config?.mcpServers?.[AGENT_BROWSER_MCP_SERVER],
	);
	const invalidConfig = configs.find(
		(entry) => entry.config === null && existsSync(entry.path),
	);
	const runtime = run("agentBrowser", ["doctor", "--offline", "--quick"], {
		timeout: 120000,
	});
	const server =
		configWithServer?.config?.mcpServers?.[AGENT_BROWSER_MCP_SERVER];
	return {
		cli: version.ok,
		cliVersion: commandOutputPath(version.stdout),
		browserRuntime: runtime.ok,
		browserMcp: Boolean(server),
		browserMcpEnabled: Boolean(server && server.disabled !== true),
		skill: skillIsInstalled(join(resolvedSkill, "SKILL.md")),
		skillPath: resolvedSkill,
		configPath: configWithServer?.path ?? resolvedConfig,
		configReadable: !invalidConfig,
	};
}

export function installAgentBrowser({
	piHome,
	configPath,
	skillPath,
	withDeps,
} = {}) {
	const resolvedConfig = configPath ?? defaultMcpConfigPath(piHome);
	const resolvedSkill = skillPath ?? defaultSkillPath(piHome);
	const actions = [];

	let version = run("agentBrowser", ["--version"], { timeout: 30000 });
	if (!version.ok) {
		const installed = run("npm", ["install", "-g", AGENT_BROWSER_PACKAGE]);
		if (!installed.ok) {
			throw new Error(
				`Could not install ${AGENT_BROWSER_PACKAGE}: ${installed.stderr || installed.error || installed.stdout}`,
			);
		}
		actions.push("installed agent-browser CLI");
		version = run("agentBrowser", ["--version"], { timeout: 30000 });
		if (!version.ok)
			throw new Error(
				"agent-browser was installed but is not available on PATH",
			);
	} else {
		actions.push(
			`agent-browser already installed (${commandOutputPath(version.stdout) || "version unknown"})`,
		);
	}

	const doctor = run("agentBrowser", ["doctor", "--offline", "--quick"], {
		timeout: 120000,
	});
	if (!doctor.ok) {
		const installArgs = ["install"];
		if (withDeps ?? process.platform === "linux")
			installArgs.push("--with-deps");
		const browserInstall = run("agentBrowser", installArgs, {
			timeout: 300000,
		});
		if (!browserInstall.ok) {
			throw new Error(
				`Could not install Chrome for agent-browser: ${browserInstall.stderr || browserInstall.error || browserInstall.stdout}`,
			);
		}
		actions.push("installed browser runtime");
	} else {
		actions.push("browser runtime already ready");
	}

	const skillSourceResult = run(
		"agentBrowser",
		["skills", "path", "agent-browser"],
		{ timeout: 30000 },
	);
	const skillSource = resolve(commandOutputPath(skillSourceResult.stdout));
	const sourceSkillFile = join(skillSource, "SKILL.md");
	if (!skillSourceResult.ok || !skillIsInstalled(sourceSkillFile)) {
		throw new Error(
			`agent-browser skill was not found at the CLI-provided path: ${skillSource || "<empty>"}`,
		);
	}
	const targetSkillFile = join(resolvedSkill, "SKILL.md");
	mkdirSync(resolvedSkill, { recursive: true });
	cpSync(skillSource, resolvedSkill, { recursive: true, force: true });
	if (!skillIsInstalled(targetSkillFile))
		throw new Error(`Skill copy failed: ${targetSkillFile}`);
	actions.push("installed agent-browser skill");

	const existingConfig = mcpConfigCandidates(piHome).some((path) => {
		try {
			return Boolean(readJson(path).mcpServers?.[AGENT_BROWSER_MCP_SERVER]);
		} catch {
			return false;
		}
	});
	if (existingConfig) {
		actions.push(`MCP server ${AGENT_BROWSER_MCP_SERVER} already configured`);
	} else {
		const before = readJson(resolvedConfig);
		const after = mergeAgentBrowserMcpConfig(before);
		if (after !== before) {
			writeJsonAtomic(resolvedConfig, after);
			actions.push(`added MCP server ${AGENT_BROWSER_MCP_SERVER}`);
		}
	}

	return {
		actions,
		inspection: inspectAgentBrowser({
			piHome,
			configPath: resolvedConfig,
			skillPath: resolvedSkill,
		}),
	};
}

if (process.argv.includes("--install")) {
	const valueAfter = (flag) => {
		const index = process.argv.indexOf(flag);
		return index >= 0 ? process.argv[index + 1] : undefined;
	};
	try {
		const result = installAgentBrowser({
			piHome: valueAfter("--pi-home"),
			configPath: valueAfter("--config"),
			skillPath: valueAfter("--skill-dir"),
			withDeps: process.argv.includes("--with-deps") ? true : undefined,
		});
		console.log(`[paseo-team] ${result.actions.join("; ")}`);
	} catch (error) {
		console.error(
			`[paseo-team] agent-browser setup failed: ${String(error?.message ?? error)}`,
		);
		process.exitCode = 1;
	}
}

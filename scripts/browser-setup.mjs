#!/usr/bin/env node
// Idempotent agent-browser setup for the Paseo + Pi role pack.
//
// agent-browser is both a CLI and an MCP stdio server (`agent-browser mcp`).
// Pi's MCP adapter reads the user-global config at ~/.pi/agent/mcp.json, so
// this script adds only the missing server entry and never rewrites an
// existing server definition.
//
// Usage:
//   node scripts/browser-setup.mjs --install [--pi-home <dir>] [--config <path>]
//                                  [--skill-dir <dir>] [--with-deps]
//                                  [--attach-cdp-port <port>]
//
// Default is launch mode: agent-browser starts its own browser, which holds no
// credentials. --attach-cdp-port switches to attaching to an already-running
// Chrome over CDP — faster and reuses that profile's auth, at the cost of
// handing a granted Peer every session in it. Opt-in, explicit port, no env
// fallback: a knob this consequential must be visible in the install command.

import { spawnSync } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	statSync,
	readFileSync,
	renameSync,
	rmSync,
	cpSync,
	writeFileSync,
} from "node:fs";
import { homedir, networkInterfaces } from "node:os";
import { dirname, join, resolve } from "node:path";

export const AGENT_BROWSER_PACKAGE = "agent-browser";
export const AGENT_BROWSER_MCP_SERVER = "agent-browser";
const CONFIG_LOCK_RETRIES = 50;
const CONFIG_LOCK_WAIT_MS = 100;
const CONFIG_LOCK_STALE_MS = 5 * 60 * 1000;

/**
 * Validate a CDP port at the boundary. Everything downstream (mcp.json, the
 * preflight probe) assumes a real TCP port, so a typo must die here rather
 * than become a browser call that fails mid-turn.
 */
export function assertCdpPort(value) {
	const raw = typeof value === "string" ? value.trim() : value;
	const port =
		typeof raw === "number" || (typeof raw === "string" && raw.length > 0)
			? Number(raw)
			: Number.NaN;
	if (!Number.isInteger(port) || port < 1 || port > 65535) {
		throw new Error(
			`CDP port must be an integer 1-65535, got ${JSON.stringify(value) ?? String(value)}`,
		);
	}
	return port;
}

/**
 * MCP entry for the agent-browser stdio server.
 *
 * `cdpPort: null` (the default) is launch mode: agent-browser starts its own
 * browser, which carries no ambient credentials — the isolation that makes a
 * per-turn BROWSER_MCP_AUTHORITY grant a meaningful bound. Passing a port
 * switches to attach mode, where a granted Peer inherits every logged-in
 * session in the target profile, so it is opt-in only (`--attach-cdp-port`).
 *
 * agent-browser takes --cdp as a global flag, before the subcommand:
 *   agent-browser --cdp 9222 mcp
 */
export function browserMcpConfig({ cdpPort = null } = {}) {
	const args =
		cdpPort === null || cdpPort === undefined
			? ["mcp"]
			: ["--cdp", String(assertCdpPort(cdpPort)), "mcp"];
	return {
		command: "agent-browser",
		args,
		lifecycle: "lazy",
	};
}

/**
 * Shared arg reader for the validator and the CDP-target parser.
 * Returns null when the args are not a shape we can reason about.
 */
function readAgentBrowserArgs(args) {
	if (!Array.isArray(args) || args.length === 0) return null;
	if (!args.every((arg) => typeof arg === "string")) return null;
	const ports = new Set();
	let index = 0;
	// Leading global flag: --cdp <port> mcp
	if (args[0] === "--cdp") {
		if (args.length < 3) return null;
		let port;
		try {
			port = assertCdpPort(args[1]);
		} catch {
			return null;
		}
		ports.add(port);
		index = 2;
	}
	if (args[index] !== "mcp") return null;
	// A hand-written entry may also put the flag after the subcommand. Read it
	// so preflight probes the port the user actually meant, but stay permissive:
	// this function decides whether the installer OVERWRITES the entry, and an
	// entry we merely find odd is still the user's.
	const trailing = args.slice(index + 1);
	for (let i = 0; i < trailing.length; i++) {
		if (trailing[i] !== "--cdp") continue;
		try {
			ports.add(assertCdpPort(trailing[i + 1]));
		} catch {
			return { ports: new Set(), ambiguous: true };
		}
	}
	return { ports, ambiguous: ports.size > 1 };
}

export function isValidAgentBrowserMcpServer(server) {
	if (
		!server ||
		typeof server !== "object" ||
		Array.isArray(server) ||
		typeof server.command !== "string" ||
		server.command.trim() !== "agent-browser"
	) {
		return false;
	}
	if (server.disabled !== undefined && typeof server.disabled !== "boolean") {
		return false;
	}
	// Deliberately NOT validating `lifecycle` or any other extra field. What this
	// predicate really decides is whether the installer OVERWRITES the entry, so
	// every rejection is a clobber: rejecting a field the previous rule ignored
	// would silently replace a config the user owns. Only the fields the
	// installer itself relies on may gate validity.
	return readAgentBrowserArgs(server.args) !== null;
}

/**
 * How an installed entry reaches a browser.
 *   { mode: "launch",    port: null }   agent-browser starts an isolated browser
 *   { mode: "attach",    port: <n> }    it dials CDP on 127.0.0.1:<n>
 *   { mode: "ambiguous", port: null }   two different --cdp ports; we refuse to guess
 */
export function agentBrowserCdpTarget(server) {
	if (!isValidAgentBrowserMcpServer(server)) {
		throw new Error(
			"agentBrowserCdpTarget expects a valid agent-browser MCP server entry",
		);
	}
	const parsed = readAgentBrowserArgs(server.args);
	if (parsed.ambiguous) return { mode: "ambiguous", port: null };
	const [port] = parsed.ports;
	return port === undefined
		? { mode: "launch", port: null }
		: { mode: "attach", port };
}

/** One-line description of a parsed CDP target, for installer/preflight output. */
export function describeCdpTarget(target) {
	if (target.mode === "attach") return `attach mode, CDP port ${target.port}`;
	if (target.mode === "ambiguous") return "ambiguous --cdp flags";
	return "launch mode, isolated browser";
}

/**
 * Ask a CDP endpoint to identify itself. Used by preflight so an unreachable
 * attach target is a host-readiness failure instead of a browser call that
 * dies inside a Peer turn.
 */
export async function probeCdpEndpoint({
	host = "127.0.0.1",
	port,
	timeoutMs = 2000,
} = {}) {
	try {
		const response = await fetch(`http://${host}:${assertCdpPort(port)}/json/version`, {
			signal: AbortSignal.timeout(timeoutMs),
		});
		if (!response.ok) {
			return { ok: false, browser: "", error: `HTTP ${response.status}` };
		}
		const payload = await response.json();
		const browser = typeof payload?.Browser === "string" ? payload.Browser : "";
		return browser
			? { ok: true, browser, error: "" }
			: { ok: false, browser: "", error: "response is not a CDP /json/version payload" };
	} catch (error) {
		return {
			ok: false,
			browser: "",
			error: String(error?.message ?? error) || "unreachable",
		};
	}
}

/**
 * Non-loopback local addresses on which the same CDP port answers. Chrome
 * started with --remote-debugging-address=0.0.0.0 hands full, unauthenticated
 * browser control to anything on the network; a loopback-only probe cannot see
 * that, so dial the host's own external addresses too.
 */
export async function probeCdpExposure({ port, timeoutMs = 1000 } = {}) {
	const addresses = Object.values(networkInterfaces())
		.flat()
		.filter((entry) => entry && entry.family === "IPv4" && !entry.internal)
		.map((entry) => entry.address);
	const probes = await Promise.all(
		[...new Set(addresses)].map(async (address) => {
			const probe = await probeCdpEndpoint({ host: address, port, timeoutMs });
			return probe.ok ? address : null;
		}),
	);
	return probes.filter((address) => address !== null);
}

/** Add agent-browser only when the user has not configured that server yet. */
export function mergeAgentBrowserMcpConfig(config, { cdpPort = null } = {}) {
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
	const existing = servers[AGENT_BROWSER_MCP_SERVER];
	if (existing !== undefined && isValidAgentBrowserMcpServer(existing)) return source;
	return {
		...source,
		mcpServers: {
			...servers,
			[AGENT_BROWSER_MCP_SERVER]: browserMcpConfig({ cdpPort }),
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

function waitSync(milliseconds) {
	Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}

function withConfigLock(configPath, fn) {
	const lockPath = `${configPath}.lock`;
	let acquired = false;
	for (let attempt = 0; attempt < CONFIG_LOCK_RETRIES; attempt++) {
		try {
			mkdirSync(lockPath);
			writeFileSync(join(lockPath, "owner"), `${process.pid}\n`, "utf8");
			acquired = true;
			break;
		} catch (error) {
			if (error?.code !== "EEXIST") throw error;
			waitSync(CONFIG_LOCK_WAIT_MS);
			try {
				// Only remove a lock we can prove is stale via its mtime. A
				// directory lock makes the read/merge/write critical section
				// mutually exclusive across installer processes.
				const lockStat = statSync(lockPath);
				if (Date.now() - lockStat.mtimeMs > CONFIG_LOCK_STALE_MS) rmSync(lockPath, { recursive: true, force: true });
			} catch {
				// It was removed by the owner; retry acquisition.
			}
		}
	}
	if (!acquired) throw new Error(`timed out waiting for MCP config lock: ${lockPath}`);
	try {
		return fn();
	} finally {
		rmSync(lockPath, { recursive: true, force: true });
	}
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
	const configWithServer = configs.find((entry) =>
		isValidAgentBrowserMcpServer(entry.config?.mcpServers?.[AGENT_BROWSER_MCP_SERVER]),
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
		browserMcp: isValidAgentBrowserMcpServer(server),
		browserMcpEnabled: isValidAgentBrowserMcpServer(server) && server.disabled !== true,
		// Parsed once here so preflight never re-scans args on its own.
		cdpTarget: isValidAgentBrowserMcpServer(server)
			? agentBrowserCdpTarget(server)
			: null,
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
	cdpPort = null,
} = {}) {
	const requestedCdpPort = cdpPort === null ? null : assertCdpPort(cdpPort);
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
	// Replace, rather than merge, so removed files from a newer CLI cannot be
	// masked by stale files left by an older installation.
	rmSync(resolvedSkill, { recursive: true, force: true });
	mkdirSync(resolvedSkill, { recursive: true });
	cpSync(skillSource, resolvedSkill, { recursive: true, force: true });
	if (!skillIsInstalled(targetSkillFile))
		throw new Error(`Skill copy failed: ${targetSkillFile}`);
	actions.push("installed agent-browser skill");

	const existingConfig = mcpConfigCandidates(piHome)
		.map((path) => {
			try {
				const server = readJson(path).mcpServers?.[AGENT_BROWSER_MCP_SERVER];
				return isValidAgentBrowserMcpServer(server) ? { path, server } : null;
			} catch {
				return null;
			}
		})
		.find((entry) => entry !== null);
	if (existingConfig) {
		const target = agentBrowserCdpTarget(existingConfig.server);
		// The merge never rewrites an entry the user owns. That is the right
		// default, but it would turn --attach-cdp-port into a knob that silently
		// does nothing on the second run — so say so instead of pretending.
		if (requestedCdpPort !== null && target.port !== requestedCdpPort) {
			throw new Error(
				`--attach-cdp-port ${requestedCdpPort} conflicts with the existing ${AGENT_BROWSER_MCP_SERVER} entry in ${existingConfig.path} (${describeCdpTarget(target)}). ` +
					"Existing MCP entries are never rewritten: edit or remove that entry, then re-run.",
			);
		}
		actions.push(
			`MCP server ${AGENT_BROWSER_MCP_SERVER} already configured (${describeCdpTarget(target)})`,
		);
	} else {
		mkdirSync(dirname(resolvedConfig), { recursive: true });
		withConfigLock(resolvedConfig, () => {
			const before = readJson(resolvedConfig);
			const after = mergeAgentBrowserMcpConfig(before, { cdpPort: requestedCdpPort });
			if (after !== before) {
				writeJsonAtomic(resolvedConfig, after);
				actions.push(
					`added MCP server ${AGENT_BROWSER_MCP_SERVER} (${describeCdpTarget(
						agentBrowserCdpTarget(after.mcpServers[AGENT_BROWSER_MCP_SERVER]),
					)})`,
				);
			}
		});
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
		// Attach mode is opt-in and takes an explicit port: no env fallback, no
		// bare-flag default. A browser reached over CDP carries the profile's
		// live sessions, so the choice must be visible in the install command.
		const attachCdpPort = process.argv.includes("--attach-cdp-port")
			? assertCdpPort(valueAfter("--attach-cdp-port"))
			: null;
		const result = installAgentBrowser({
			piHome: valueAfter("--pi-home"),
			configPath: valueAfter("--config"),
			skillPath: valueAfter("--skill-dir"),
			withDeps: process.argv.includes("--with-deps") ? true : undefined,
			cdpPort: attachCdpPort,
		});
		console.log(`[paseo-team] ${result.actions.join("; ")}`);
		if (attachCdpPort !== null) {
			console.warn(
				`[paseo-team] attach mode: agent-browser will drive the browser already running on CDP port ${attachCdpPort}. ` +
					"A Peer holding BROWSER_MCP_AUTHORITY inherits every logged-in session in that profile, " +
					"and agent-browser rejects --allowed-domains while CDP is in use. Point it at a dedicated profile, never your daily browser.",
			);
		}
	} catch (error) {
		console.error(
			`[paseo-team] agent-browser setup failed: ${String(error?.message ?? error)}`,
		);
		process.exitCode = 1;
	}
}

// lib-common.mjs — helpers shared by the role-pack support scripts.
//
// INSTALL CONTRACT: the installer copies support scripts FLAT into
// ~/.pi/agent/extensions/paseo-team-scripts/, so every consumer imports this
// as "./lib-common.mjs" and this file must be listed in TEAM_SUPPORT_FILES in
// BOTH scripts/install.sh and scripts/install.ps1. A missing entry here breaks
// every installed script at import time, which is why
// test/installer-contract.test.mjs asserts the installed set can run.
//
// Nothing in here may import another support script: it sits at the bottom of
// the dependency graph on purpose.

import { existsSync, readFileSync, realpathSync } from "node:fs";
import { delimiter, dirname, join, sep } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * True when `moduleUrl` is the process entrypoint.
 *
 * Callers pass their OWN import.meta.url — a default of import.meta.url here
 * would resolve to this file and every check would answer false.
 *
 * Compares canonical filesystem paths, not URL text: macOS temp dirs are
 * reachable through both /var and /private/var, and installed scripts are
 * often symlinked.
 */
export function isEntrypoint(moduleUrl, entry = process.argv[1]) {
	if (!entry) return false;
	try {
		return realpathSync(entry) === realpathSync(fileURLToPath(moduleUrl));
	} catch {
		return false;
	}
}

/**
 * Split a command line into argv, honouring single and double quotes.
 *
 * Returns `{ parts, unterminated }` rather than throwing: each caller maps a
 * malformed override onto its own error contract (OcrReviewError vs
 * RemoteError), and an exception type from a shared module would have to be
 * translated at every call site anyway.
 */
export function splitCommandLine(commandLine) {
	// Reject non-strings loudly. Coercing would turn `undefined` into the argv
	// element "undefined" and spawn a nonsense binary with a confusing ENOENT.
	if (typeof commandLine !== "string") {
		throw new TypeError("splitCommandLine expects a string");
	}
	const parts = [];
	let current = "";
	let quote = "";
	for (const ch of commandLine) {
		if ((ch === '"' || ch === "'") && (!quote || quote === ch)) {
			quote = quote ? "" : ch;
			continue;
		}
		if (/\s/.test(ch) && !quote) {
			if (current) parts.push(current);
			current = "";
		} else {
			current += ch;
		}
	}
	if (current) parts.push(current);
	return { parts, unterminated: quote !== "" };
}

/** PATH entries, plus the npm global bin on Windows.
 *
 * `%APPDATA%\npm` holds npm-installed CLI shims and is frequently absent from
 * a child process's PATH (services, IDE terminals, spawned daemons), so a
 * globally installed `paseo`/`ocr` would look missing without it. */
export function searchPathDirs(env = process.env) {
	const dirs = (env.PATH ?? "").split(delimiter).filter(Boolean);
	if (process.platform === "win32" && env.APPDATA) {
		dirs.push(join(env.APPDATA, "npm"));
	}
	return dirs;
}

/**
 * First existing file among `names`, scanned directory-major: every candidate
 * name is tried in the first PATH entry before moving to the second. That
 * makes PATH order — not the order of `names` — decide which install wins,
 * matching how the OS resolves a command.
 */
export function findOnPath(names, env = process.env) {
	const candidates = Array.isArray(names) ? names : [names];
	for (const dir of searchPathDirs(env)) {
		for (const name of candidates) {
			const candidate = join(dir, name);
			if (existsSync(candidate)) return candidate;
		}
	}
	return undefined;
}

/**
 * Resolve the real `node <entry.js>` invocation behind an npm-generated
 * Windows `.cmd`/`.bat` shim. Shims cannot be spawned with argv (EINVAL), so
 * the entry script has to be extracted and run through node directly.
 *
 * npm shims end with: "%_prog%" "%dp0%\node_modules\@scope\pkg\dist\index.js" %*
 *
 * @param {string} shimPath path to the .cmd/.bat shim
 * @param {string[][]} conventionalCandidates path segments, relative to the
 *   shim directory, to try when the shim cannot be parsed
 */
export function resolveCmdEntry(shimPath, conventionalCandidates = []) {
	let text;
	try {
		text = readFileSync(shimPath, "utf8");
	} catch {
		text = undefined;
	}
	if (text !== undefined) {
		const match = text.match(/"([^"]*(?:%~dp0|%dp0%)[^"]*\.js)"/i);
		if (match?.[1]) {
			const entry = match[1]
				.replace(/%~dp0|%dp0%/gi, dirname(shimPath))
				.replace(/[\\/]/g, sep);
			if (existsSync(entry)) return entry;
		}
	}
	for (const segments of conventionalCandidates) {
		const conventional = join(dirname(shimPath), ...segments);
		if (existsSync(conventional)) return conventional;
	}
	return undefined;
}

/**
 * Resolve `[bin, ...prefixArgs]` for an npm-installed CLI on Windows.
 * Returns undefined when nothing was found, so the caller can fall back to the
 * bare command name and let spawn surface the real ENOENT/EINVAL.
 *
 * @param {object} spec
 * @param {string} spec.exe native executable name, e.g. "paseo.exe"
 * @param {string[]} spec.shims shim names, e.g. ["paseo.cmd", "paseo.bat"]
 * @param {string[][]} [spec.conventionalCandidates] see resolveCmdEntry
 */
export function resolveWindowsCliExec({ exe, shims, conventionalCandidates = [] }) {
	const native = findOnPath([exe]);
	if (native) return [native];
	const shim = findOnPath(shims);
	if (!shim) return undefined;
	const entry = resolveCmdEntry(shim, conventionalCandidates);
	return entry ? [process.execPath, entry] : undefined;
}

// Layouts to try when a paseo shim cannot be parsed, relative to the shim
// directory. Two are needed because @getpaseo/cli has shipped its entry under
// dist/ and under bin/ depending on version.
export const PASEO_CONVENTIONAL_ENTRIES = [
	["node_modules", "@getpaseo", "cli", "dist", "index.js"],
	["node_modules", "@getpaseo", "cli", "bin", "paseo"],
];

/**
 * Resolve `[bin, ...prefixArgs]` for the paseo CLI.
 *
 * Windows `.cmd` shims cannot be spawned with argv (EINVAL), so the shim's
 * real node entry is extracted and node is spawned directly — argv fidelity
 * without cmd.exe quoting. PASEO_TEAM_PASEO_EXEC overrides everything.
 *
 * @param {(reason: string) => never} [onInvalidOverride] maps a bad override
 *   onto the caller's error type (RemoteError, etc). Falls back to a plain
 *   Error, so a bad override can never be silently ignored.
 */
export function resolvePaseoExec(onInvalidOverride) {
	const override = process.env.PASEO_TEAM_PASEO_EXEC?.trim();
	if (override) {
		const { parts, unterminated } = splitCommandLine(override);
		const invalid = unterminated
			? "has an unterminated quote"
			: parts.length === 0
				? "is set but empty"
				: null;
		if (invalid) {
			if (onInvalidOverride) onInvalidOverride(invalid);
			throw new Error(`PASEO_TEAM_PASEO_EXEC ${invalid}`);
		}
		return parts;
	}
	if (process.platform !== "win32") return ["paseo"];
	// Bare "paseo" as the fallback: let spawn surface the real ENOENT/EINVAL
	// rather than guessing at a layout nothing confirmed.
	return (
		resolveWindowsCliExec({
			exe: "paseo.exe",
			shims: ["paseo.cmd", "paseo.bat"],
			conventionalCandidates: PASEO_CONVENTIONAL_ENTRIES,
		}) ?? ["paseo"]
	);
}

/** Extract "1.8.10" from OCR's `ocr version` output. Null when absent. */
export function parseOcrVersion(output) {
	const match = String(output).match(/open-code-review v(\d+\.\d+\.\d+)/i);
	return match?.[1] ?? null;
}

/** Numeric semver compare over major.minor.patch; returns -1 | 0 | 1. */
export function compareOcrVersions(a, b) {
	const pa = String(a).split(".").map(Number);
	const pb = String(b).split(".").map(Number);
	for (let i = 0; i < 3; i++) {
		const delta = (pa[i] ?? 0) - (pb[i] ?? 0);
		if (delta !== 0) return delta < 0 ? -1 : 1;
	}
	return 0;
}

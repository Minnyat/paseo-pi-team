/**
 * self-update.mjs — version truth + "is there a newer tag on GitHub".
 *
 * The version lives in package.json and nowhere else; `status` and
 * `--version` both read it here so they cannot drift again (the bug this
 * replaced: status hardcoded "0.1.0" while package.json said "0.0.0").
 *
 * The latest release comes from `git ls-remote --tags`, not `npm view`,
 * because the repository is private: ls-remote rides on the machine's own
 * git credentials, while the npm registry knows nothing about this package.
 */

import { execFile, spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { splitCommandLine } from "../../scripts/lib-common.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

export const LS_REMOTE_TIMEOUT_MS = 15_000;
export const NPM_INSTALL_TIMEOUT_MS = 300_000;

function readPackage() {
	try {
		return JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
	} catch (e) {
		throw new Error(`cannot read ${join(ROOT, "package.json")}: ${e.message}`);
	}
}

export function currentVersion(pkg = readPackage()) {
	return String(pkg.version ?? "0.0.0");
}

/**
 * "owner/repo" from any of the shapes package.json allows for
 * repository.url ("github:o/r", "git+https://github.com/o/r.git",
 * "git@github.com:o/r.git", plain https). Throws on anything else — a wrong
 * slug silently queries the wrong repo, which is worse than a loud failure.
 */
export function repoSlug(pkg = readPackage()) {
	const raw = String(pkg.repository?.url ?? "");
	const cleaned = raw
		.replace(/^[a-z+.-]+:\/*/i, "")
		.replace(/^\/+/, "")
		.replace(/^git@/i, "")
		.replace(/\.git$/i, "");
	const match =
		/^(?:[a-z0-9.-]+\.)?github\.com[\/:]([^/]+)\/([^/]+)$/i.exec(cleaned) ||
		/^([^/.]+)\/([^/.][^/]*)$/i.exec(cleaned);
	if (!match) throw new Error(`package.json repository.url is missing or not a GitHub URL: '${raw}'`);
	return `${match[1]}/${match[2]}`;
}

/** -1 | 0 | 1, tolerant of a leading "v" and of missing minor/patch parts. */
export function compareVersions(a, b) {
	const part = (v, i) => Number(/^v?(\d+)/.exec(String(v ?? "").split(".")[i] ?? "")?.[1] ?? 0);
	const width = Math.max(String(a ?? "").split(".").length, String(b ?? "").split(".").length);
	for (let i = 0; i < width; i++) {
		const d = part(a, i) - part(b, i);
		if (d !== 0) return d < 0 ? -1 : 1;
	}
	return 0;
}

/**
 * Highest `v<major.minor.patch>` tag from `git ls-remote --tags --refs`
 * output (`<sha>\trefs/tags/<tag>` per line). Non-semver tags (nightly,
 * release-*) are ignored so a date-named tag can never outrank a release.
 */
export function pickLatestTag(lsRemoteStdout) {
	let latest = null;
	for (const line of String(lsRemoteStdout ?? "").split("\n")) {
		const tag = line.trim().split("\t").pop()?.replace(/^refs\/tags\//, "") ?? "";
		if (!/^v?\d+(\.\d+){0,2}$/.test(tag)) continue;
		if (latest === null || compareVersions(tag, latest) > 0) latest = tag;
	}
	return latest;
}

/**
 * Same override convention as resolvePaseoExec: PASEO_TEAM_GIT_EXEC /
 * PASEO_TEAM_NPM_EXEC may carry a full command line ("node C:\fake git.js")
 * so tests can substitute a fake binary without touching PATH.
 */
export function gitExec() {
	return resolveExec("PASEO_TEAM_GIT_EXEC", "git");
}

export function npmExec() {
	return resolveExec("PASEO_TEAM_NPM_EXEC", "npm");
}

function resolveExec(envVar, fallbackBin) {
	const override = process.env[envVar]?.trim();
	if (!override) return [fallbackBin];
	const { parts, unterminated } = splitCommandLine(override);
	if (unterminated || parts.length === 0) {
		throw new Error(`${envVar} is set but malformed`);
	}
	return parts;
}

function lsRemoteArgs(slug) {
	return ["ls-remote", "--tags", "--refs", `https://github.com/${slug}.git`];
}

/**
 * Never rejects. A reachable-but-stale answer and an unreachable remote are
 * different facts, so "could not determine" is reported as degraded[] with
 * updateAvailable: null — the same degrade-don't-crash contract as graph.
 */
export async function checkForUpdate(options = {}) {
	const slug = repoSlug();
	const current = currentVersion();
	const base = { slug, current };
	return new Promise((resolve) => {
		const [bin, ...prefix] = gitExec();
		execFile(
			bin,
			[...prefix, ...lsRemoteArgs(slug)],
			{
				encoding: "utf8",
				timeout: options.timeoutMs ?? LS_REMOTE_TIMEOUT_MS,
				stdio: ["ignore", "pipe", "pipe"],
				windowsHide: true,
				env: process.env,
			},
			(error, stdout, stderr) => {
				if (error) {
					resolve({
						...base,
						latest: null,
						updateAvailable: null,
						degraded: [
							{
								reason: error.killed || error.signal ? "ls-remote-timeout" : "ls-remote-failed",
								error: `${String(stderr ?? "").trim()} ${String(error.message ?? "")}`.trim(),
							},
						],
					});
					return;
				}
				const latest = pickLatestTag(stdout);
				if (latest === null) {
					resolve({ ...base, latest: null, updateAvailable: null, degraded: [{ reason: "no-release-tags" }] });
					return;
				}
				const cmp = compareVersions(current, latest);
				resolve({
					...base,
					latest,
					updateAvailable: cmp < 0,
					upToDate: cmp >= 0,
					degraded: [],
				});
			},
		);
	});
}

/**
 * A git checkout (`.git` present at the repo root) updates via `git pull`;
 * an npm install from a GitHub tarball has no `.git`, so it updates by
 * re-running npm with an explicit tag. Wrong-mode guesses would run `git
 * pull` inside node_modules or npm inside a checkout, so decide, don't assume.
 */
export function detectInstallMode() {
	return existsSync(join(ROOT, ".git")) ? "checkout" : "global";
}

export function npmUpdateArgv(slug, tag) {
	return ["install", "-g", `github:${slug}#${tag}`];
}

/** Runs the real install with inherited stdio so npm's own progress is visible. */
export function runNpmUpdate(slug, tag) {
	const [bin, ...prefix] = npmExec();
	return spawnSync(bin, [...prefix, ...npmUpdateArgv(slug, tag)], {
		stdio: ["ignore", "inherit", "inherit"],
		timeout: NPM_INSTALL_TIMEOUT_MS,
		windowsHide: true,
	});
}

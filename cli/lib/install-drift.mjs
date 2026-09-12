/**
 * install-drift.mjs — do the installed copies still match this release?
 *
 * The pack's update path creates drift by design. `npm i -g` refreshes the CLI;
 * the copies under `~/.pi/agent/` — the ones a running agent actually loads —
 * stay exactly where they were. Both halves then report the new version number
 * and nothing disagrees out loud, so the observable state of a half-upgraded
 * host is a CLI enforcing this release's rules next to a policy core enforcing
 * the previous one.
 *
 * `pteam update` already tells the user to re-run `pteam install` and then
 * `pteam preflight` "to confirm the installed copies match this version".
 * Preflight could not do that: its policy-core check proves the installed
 * module LOADS and exports the policy API, which a core from three releases ago
 * does just as well. This module is the missing half — it compares bytes.
 *
 * No manifest file is written at install time, deliberately. Upstream Paseo
 * ships one (`foundation/manifest.json`, a sha256 per distributed file) because
 * the source bytes are not present on the target host. Ours are: preflight runs
 * from the package, so both sides of every comparison are on disk already, and
 * a manifest would be a third copy that can itself go stale.
 *
 * Verdicts, per file:
 *   changed     installed and source both exist, bytes differ
 *   missing     the source ships it, the install does not have it
 *   unexpected  installed, with no counterpart in this release
 *
 * `unexpected` is only reported for directories this pack OWNS and replaces
 * wholesale on install. The prompts directory is shared with whatever else the
 * user has under `~/.pi/agent/extensions/prompts/`, so an unknown file there is
 * somebody else's, not our leftover.
 */

import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import * as cw from "./config-walker.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

export const POLICY_CORE_DIR = "paseo-team-core";

function sha256(path) {
	return createHash("sha256").update(readFileSync(path)).digest("hex");
}

/** Every file under `dir`, as paths relative to it. `[]` when it is absent. */
function walk(dir, prefix = "") {
	if (!existsSync(dir)) return [];
	const out = [];
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
		if (entry.isDirectory()) out.push(...walk(join(dir, entry.name), rel));
		else if (entry.isFile()) out.push(rel);
	}
	return out.sort();
}

/** Same-bytes check that survives a CRLF checkout on Windows. */
function sameBytes(source, installed) {
	if (sha256(source) === sha256(installed)) return true;
	// .gitattributes pins LF in the repo, but a file copied by PowerShell and
	// re-saved by an editor can come back with CRLF. That is not a version
	// difference, and reporting it as one would make the check cry wolf on
	// every Windows host.
	const normalize = (path) => readFileSync(path, "utf8").replace(/\r\n/g, "\n");
	try {
		return normalize(source) === normalize(installed);
	} catch {
		return false;
	}
}

/**
 * One artifact group. `owned` means the installers delete and re-create the
 * whole directory, so a file with no source counterpart is our leftover.
 */
function compareDir({ kind, sourceDir, installedDir, owned, sourceFilter = () => true }) {
	const results = [];
	const sourceFiles = walk(sourceDir).filter(sourceFilter);
	const installedFiles = new Set(walk(installedDir));
	for (const rel of sourceFiles) {
		const installed = join(installedDir, ...rel.split("/"));
		if (!existsSync(installed)) {
			results.push({ kind, file: rel, verdict: "missing", path: installed });
			continue;
		}
		if (!sameBytes(join(sourceDir, ...rel.split("/")), installed)) {
			results.push({ kind, file: rel, verdict: "changed", path: installed });
		}
	}
	if (owned) {
		const shipped = new Set(sourceFiles);
		for (const rel of installedFiles) {
			if (shipped.has(rel)) continue;
			results.push({
				kind,
				file: rel,
				verdict: "unexpected",
				path: join(installedDir, ...rel.split("/")),
			});
		}
	}
	return results;
}

/**
 * The support scripts `scripts/install.sh` ships, read from the installer
 * itself.
 *
 * One source of truth on purpose. A second copy of this list here would be a
 * list that drifts, and a drift checker whose own expectations have drifted is
 * worse than none — it reports confidently about the wrong thing.
 */
export function installerSupportFiles(root = ROOT) {
	let text;
	try {
		text = readFileSync(join(root, "scripts", "install.sh"), "utf8");
	} catch {
		return [];
	}
	const start = text.indexOf("TEAM_SUPPORT_FILES=(");
	if (start < 0) return [];
	const end = text.indexOf("\n)", start);
	if (end < 0) return [];
	return [...text.slice(start, end).matchAll(/^\s*([a-z0-9-]+\.mjs)\s*$/gm)].map((m) => m[1]);
}

/** Where Claude Code keeps the user's skills; mirrors claude-setup.mjs. */
function claudeSkillsDir(env = process.env) {
	return join(env.CLAUDE_CONFIG_DIR?.trim() || join(homedir(), ".claude"), "skills");
}

/**
 * Compare every installed artifact against this release.
 *
 * Returns `{ checked, drift, groups }`. An install that was never performed
 * reports every file `missing`, which is the honest answer and the same one
 * the existing extension/prompt checks give.
 */
export function installDrift({ root = ROOT, env = process.env } = {}) {
	const extDir = cw.extensionsDir();
	const groups = [];

	// 1. The pi adapter itself.
	const policySource = join(root, "extensions", "paseo-team-policy.ts");
	const policyInstalled = cw.policyExtensionPath();
	if (!existsSync(policyInstalled)) {
		groups.push({ kind: "extension", file: "paseo-team-policy.ts", verdict: "missing", path: policyInstalled });
	} else if (existsSync(policySource) && !sameBytes(policySource, policyInstalled)) {
		groups.push({ kind: "extension", file: "paseo-team-policy.ts", verdict: "changed", path: policyInstalled });
	}

	// 2. The shared policy core. Source ships .ts AND the built .js; only the
	//    .ts travels, because every loader prefers .js and an installed pair
	//    would let pi read the current rules while the Claude hook reads stale
	//    ones. So a .js in the target is drift in its own right — see the
	//    comment in scripts/install.sh that deletes it.
	groups.push(
		...compareDir({
			kind: "policy-core",
			sourceDir: join(root, "extensions", POLICY_CORE_DIR),
			installedDir: join(extDir, POLICY_CORE_DIR),
			owned: true,
			sourceFilter: (file) => file.endsWith(".ts"),
		}),
	);

	// 3. Role prompts. Shared directory: no `unexpected`.
	for (const role of cw.ROLE_PROMPTS) {
		const source = join(root, "prompts", `${role}.md`);
		const installed = cw.rolePromptPath(role);
		if (!existsSync(installed)) {
			groups.push({ kind: "prompt", file: `${role}.md`, verdict: "missing", path: installed });
		} else if (existsSync(source) && !sameBytes(source, installed)) {
			groups.push({ kind: "prompt", file: `${role}.md`, verdict: "changed", path: installed });
		}
	}

	// 4. Skills, on both runtimes. The Claude copies are checked only when that
	//    side was installed at all — a pi-only host is a supported setup, and
	//    reporting two missing skill packages there would be noise, not drift.
	const claudeSkills = claudeSkillsDir(env);
	for (const name of cw.PACK_SKILLS) {
		const sourceDir = join(root, "skills", name);
		groups.push(
			...compareDir({
				kind: "skill",
				sourceDir,
				installedDir: cw.skillDirPath(name),
				owned: true,
			}).map((item) => ({ ...item, file: `${name}/${item.file}` })),
		);
		if (existsSync(join(claudeSkills, name))) {
			groups.push(
				...compareDir({
					kind: "claude-skill",
					sourceDir,
					installedDir: join(claudeSkills, name),
					owned: true,
				}).map((item) => ({ ...item, file: `${name}/${item.file}` })),
			);
		}
	}

	// 5. Support scripts. The installers own that directory outright, and the
	//    list of what belongs in it lives in the installers rather than here — so
	//    it is READ from install.sh instead of copied, and both directions are
	//    checked against it. Walking only the installed side would make the
	//    half-upgrade case invisible in exactly the way this module exists to
	//    prevent: a release that adds a support script installs nothing new, and
	//    the first thing to import it fails at runtime on the user's machine.
	const scriptsDir = join(extDir, "paseo-team-scripts");
	const shippedScripts = installerSupportFiles(root);
	if (!existsSync(scriptsDir)) {
		groups.push({ kind: "support-script", file: "paseo-team-scripts/", verdict: "missing", path: scriptsDir });
	} else {
		for (const name of shippedScripts) {
			const installed = join(scriptsDir, name);
			const source = join(root, "scripts", name);
			if (!existsSync(installed)) {
				groups.push({ kind: "support-script", file: name, verdict: "missing", path: installed });
			} else if (existsSync(source) && !sameBytes(source, installed)) {
				groups.push({ kind: "support-script", file: name, verdict: "changed", path: installed });
			}
		}
		const shipped = new Set(shippedScripts);
		for (const rel of walk(scriptsDir)) {
			if (shipped.has(rel)) continue;
			groups.push({
				kind: "support-script",
				file: rel,
				verdict: "unexpected",
				path: join(scriptsDir, rel),
			});
		}
	}

	return {
		root,
		// "Was the pack ever installed here at all?" — the pi adapter is the
		// first thing every installer writes, so its absence separates a host
		// that never ran the installer from one whose install has gone stale.
		// The caller needs that distinction: the two have completely different
		// remedies, and reporting a one-file gap as "not installed" hides the
		// filename that would fix it.
		installed: existsSync(policyInstalled),
		checked: {
			extension: policyInstalled,
			policyCore: join(extDir, POLICY_CORE_DIR),
			prompts: cw.promptsDir(),
			skills: cw.skillsDir(),
			supportScripts: scriptsDir,
		},
		drift: groups,
		ok: groups.length === 0,
	};
}

/**
 * One line per artifact group, for a human reading preflight output.
 *
 * Grouped by kind and capped: a host that never ran the installer has every
 * file missing, and a hundred filenames would bury the one line that matters
 * ("re-run pteam install").
 */
export function summarizeDrift(drift, { perKind = 4 } = {}) {
	const byKind = new Map();
	for (const item of drift) {
		if (!byKind.has(item.kind)) byKind.set(item.kind, []);
		byKind.get(item.kind).push(`${item.file} (${item.verdict})`);
	}
	return [...byKind.entries()].map(([kind, files]) => {
		const shown = files.slice(0, perKind).join(", ");
		const rest = files.length - perKind;
		return `${kind}: ${shown}${rest > 0 ? `, +${rest} more` : ""}`;
	});
}

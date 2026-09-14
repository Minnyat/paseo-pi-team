/**
 * workspace-protocol.mjs — read and grade a target repository's
 * `WORKSPACE_PROTOCOL.md`.
 *
 * The protocol is the repository tactics layer: the one instruction source
 * between the role contract (which the pack owns) and the assignment (which the
 * Lead writes per task). `prompts/lead.md` makes reading it invariant 1, before
 * any orchestration.
 *
 * Until this module existed the pack handed the Human a template and never
 * looked at the result. That left two failures with no signal at all:
 *
 *   - the file written somewhere the Lead does not read. The template used to
 *     say `.orchestration/WORKSPACE_PROTOCOL.md` while every reader said the
 *     repository root, so a Human who followed it wrote a protocol nobody
 *     opened;
 *   - the file present but not usable — blank, truncated, or carrying an
 *     unresolved merge conflict. A Lead reading that does not get "no
 *     protocol"; it gets half a protocol, and both halves of a conflict as if
 *     they were rules.
 *
 * Hence four states rather than a boolean, borrowed from upstream Paseo's own
 * admission model: `missing | valid | invalid | unreadable`. `invalid` and
 * `unreadable` are the ones that matter — they are the cases where the file's
 * presence is actively misleading, and where "there is no protocol" is the
 * wrong conclusion to draw.
 *
 * This module REPORTS. It does not gate a tool call: turning a missing protocol
 * into a delegation blocker is a policy decision for the operator of a fleet,
 * not something a release should switch on underneath them.
 */

import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

/** Where the Lead is told to look, in the order it should be looked for. */
export const PROTOCOL_FILENAME = "WORKSPACE_PROTOCOL.md";
export const LEGACY_PROTOCOL_RELATIVE = join(".orchestration", PROTOCOL_FILENAME);

/**
 * Keys the Lead routes on. Their absence does NOT make a protocol invalid — the
 * deep dive is explicit that a tight repo and a loose side project both get to
 * write one, and a prose protocol is a legitimate protocol. They are reported
 * so a Human filling in the template can see what is still blank.
 */
export const RECOMMENDED_KEYS = [
	"PROJECT_ID",
	"DEFAULT_BRANCH",
	"LEAD_WRITE_POLICY",
	"MERGE_OWNER",
	"HUMAN_DECISION_BOUNDARIES",
	"GIT_POLICY",
	"REVIEW_POLICY",
	"ACCEPTANCE_EVIDENCE",
];

const VERSION_RE = /^\s*(?:<!--\s*)?WORKSPACE_PROTOCOL_VERSION\s*[:=]\s*(\S+)/im;
/**
 * A git conflict, not a Markdown heading.
 *
 * Only the SEPARATOR is ambiguous: `=======` on its own line is a setext
 * underline under a plain heading, and seven characters is a perfectly normal
 * width for one, so matching it would hard-fail a protocol written in ordinary
 * Markdown. `<<<<<<<` and `>>>>>>>` are ambiguous with nothing, so either one
 * alone is enough — a half-resolved conflict, where someone deleted the opening
 * marker and one side but left the tail, is precisely the shape that reads as a
 * finished document and is not one.
 */
const CONFLICT_RE = /^(?:<{7}|>{7})(?:\s|$)/m;

/**
 * Both paths, in precedence order. The legacy one is still resolved because
 * hosts set up from an older template have a real file there, and telling
 * someone their protocol is "missing" while it sits on disk is the least useful
 * true statement available.
 */
export function protocolCandidates(repoRoot) {
	return [
		{ path: join(repoRoot, PROTOCOL_FILENAME), legacy: false },
		{ path: join(repoRoot, LEGACY_PROTOCOL_RELATIVE), legacy: true },
	];
}

/**
 * Grade the protocol of `repoRoot`.
 *
 * Returns `{ state, path, legacy, digest, version, issues, blankKeys }`.
 * `digest` is a sha256 over the exact bytes: it is what makes "the protocol
 * changed since the Lead read it" answerable at all, and it is cheap enough to
 * record on every report.
 */
export function protocolState(repoRoot = process.cwd()) {
	const candidates = protocolCandidates(repoRoot);
	const found = candidates.find((candidate) => existsSync(candidate.path));
	if (!found) {
		return {
			state: "missing",
			path: candidates[0].path,
			legacy: false,
			digest: null,
			version: null,
			issues: [],
			blankKeys: [...RECOMMENDED_KEYS],
		};
	}

	let bytes;
	try {
		if (statSync(found.path).isDirectory()) {
			return {
				state: "unreadable",
				path: found.path,
				legacy: found.legacy,
				digest: null,
				version: null,
				issues: ["the path is a directory, not a file"],
				blankKeys: [],
			};
		}
		bytes = readFileSync(found.path);
	} catch (error) {
		return {
			state: "unreadable",
			path: found.path,
			legacy: found.legacy,
			digest: null,
			version: null,
			issues: [String(error?.message ?? error)],
			blankKeys: [],
		};
	}

	const digest = createHash("sha256").update(bytes).digest("hex");
	const text = bytes.toString("utf8");
	const issues = [];

	// A NUL byte is the signature of a file that was never meant to be text —
	// a binary written to this path, or a truncated half-write.
	if (text.includes("\u0000")) issues.push("contains NUL bytes — not a text file");
	if (text.trim() === "") issues.push("file is blank");
	if (CONFLICT_RE.test(text)) {
		issues.push(
			"unresolved merge conflict markers — a Lead reading this gets both sides as if they were rules",
		);
	}
	const version = VERSION_RE.exec(text)?.[1] ?? null;
	if (!version) {
		issues.push(
			`no WORKSPACE_PROTOCOL_VERSION line — see templates/${PROTOCOL_FILENAME.replace(".md", ".example.md")}`,
		);
	}

	const blankKeys = RECOMMENDED_KEYS.filter((key) => {
		const match = new RegExp(`^\\s*${key}\\s*:(.*)$`, "im").exec(text);
		return !match || match[1].trim() === "";
	});

	return {
		state: issues.length === 0 ? "valid" : "invalid",
		path: found.path,
		legacy: found.legacy,
		digest,
		version,
		issues,
		blankKeys,
	};
}

/** One line a person can act on, for preflight and the CLI. */
export function describeProtocolState(state) {
	switch (state.state) {
		case "valid":
			return state.legacy
				? `valid at the LEGACY path ${state.path} — the Lead reads the repository root, so move it to ./${PROTOCOL_FILENAME}`
				: `${state.path} (v${state.version}, ${state.digest.slice(0, 12)})${
						state.blankKeys.length > 0
							? `; still blank: ${state.blankKeys.join(", ")}`
							: ""
					}`;
		case "invalid":
			return `${state.path} is present but not usable: ${state.issues.join("; ")}`;
		case "unreadable":
			return `${state.path} cannot be read: ${state.issues.join("; ")}`;
		default:
			return `no ${PROTOCOL_FILENAME} at ${state.path} — the Lead has no repository tactics layer; copy templates/WORKSPACE_PROTOCOL.example.md`;
	}
}

// workspace-protocol.test.mjs — grading a target repo's WORKSPACE_PROTOCOL.md.
//
// The state that earns this module is `invalid`. `missing` a Lead can act on;
// a protocol that is present but carries an unresolved merge conflict is worse
// than absent, because the Lead opens it and reads both sides of the conflict
// as rules. Until this existed the pack handed the Human a template and never
// looked at the result.

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	describeProtocolState,
	protocolState,
	LEGACY_PROTOCOL_RELATIVE,
	PROTOCOL_FILENAME,
	RECOMMENDED_KEYS,
} from "../cli/lib/workspace-protocol.mjs";

const repo = mkdtempSync(join(tmpdir(), "paseo-protocol-"));
const protocolPath = join(repo, PROTOCOL_FILENAME);
const write = (text) => writeFileSync(protocolPath, text);

const FULL = [
	"# Workspace Protocol",
	"",
	"WORKSPACE_PROTOCOL_VERSION: 1",
	"",
	"PROJECT_ID: demo",
	"DEFAULT_BRANCH: main",
	"LEAD_WRITE_POLICY: denied",
	"MERGE_OWNER: human",
	"HUMAN_DECISION_BOUNDARIES: deployment",
	"GIT_POLICY: one writer per moving scope",
	"REVIEW_POLICY: independent review on high risk",
	"ACCEPTANCE_EVIDENCE: candidate SHA + clean worktree",
	"",
].join("\n");

// --- missing ------------------------------------------------------------------
{
	const state = protocolState(repo);
	assert.equal(state.state, "missing");
	assert.equal(state.path, protocolPath, "the reported path is the one the Lead reads");
	assert.equal(state.digest, null);
	assert.deepEqual(state.blankKeys, RECOMMENDED_KEYS);
	assert.match(describeProtocolState(state), /WORKSPACE_PROTOCOL\.example\.md/);
}

// --- valid --------------------------------------------------------------------
{
	write(FULL);
	const state = protocolState(repo);
	assert.equal(state.state, "valid");
	assert.equal(state.version, "1");
	assert.deepEqual(state.issues, []);
	assert.deepEqual(state.blankKeys, []);
	assert.match(state.digest, /^[0-9a-f]{64}$/);

	// The digest is the whole point of recording one: it answers "did the
	// protocol change since the Lead read it?".
	const before = state.digest;
	write(`${FULL}\nEXTRA: note\n`);
	assert.notEqual(protocolState(repo).digest, before);
	write(FULL);
	assert.equal(protocolState(repo).digest, before, "same bytes, same digest");
}

// --- invalid: the cases where presence is misleading --------------------------
{
	write("");
	assert.equal(protocolState(repo).state, "invalid");
	assert.match(protocolState(repo).issues.join("; "), /blank/);

	write("   \n\n\t\n");
	assert.equal(protocolState(repo).state, "invalid", "whitespace is not content");

	write(
		[
			"WORKSPACE_PROTOCOL_VERSION: 1",
			"<<<<<<< HEAD",
			"LEAD_WRITE_POLICY: denied",
			"=======",
			"LEAD_WRITE_POLICY: allowed",
			">>>>>>> feature",
		].join("\n"),
	);
	const conflicted = protocolState(repo);
	assert.equal(conflicted.state, "invalid");
	assert.match(conflicted.issues.join("; "), /merge conflict/);
	assert.match(describeProtocolState(conflicted), /present but not usable/);
	// Still digested: the caller may want to record exactly which bad bytes
	// were on disk when the check ran.
	assert.match(conflicted.digest, /^[0-9a-f]{64}$/);

	write("PROJECT_ID: demo\nDEFAULT_BRANCH: main\n");
	const unversioned = protocolState(repo);
	assert.equal(unversioned.state, "invalid");
	assert.match(unversioned.issues.join("; "), /WORKSPACE_PROTOCOL_VERSION/);

	// A row of equals signs on its own line is a Markdown setext underline, and
	// seven characters is a perfectly normal width for one. Hard-failing a valid
	// protocol because it was written in plain Markdown would be the check
	// costing more than it catches, so a conflict needs BOTH markers.
	write(`Protocol\n${"=".repeat(7)}\n\nWORKSPACE_PROTOCOL_VERSION: 1\n`);
	assert.equal(
		protocolState(repo).state,
		"valid",
		"a setext underline is a heading, not a conflict",
	);
	write(`Protocol\n${"-".repeat(20)}\n\nWORKSPACE_PROTOCOL_VERSION: 1\n${"=".repeat(40)}\n`);
	assert.equal(protocolState(repo).state, "valid", "a horizontal rule is not a conflict either");
	// An opening marker with no closing one is a truncated paste, not a
	// conflict; it is caught by the version check when it takes the version
	// line with it, and is not this rule's business.
	write(`WORKSPACE_PROTOCOL_VERSION: 1\n<<<<<<< HEAD\nPROJECT_ID: demo\n`);
	assert.equal(protocolState(repo).state, "valid", "one marker alone is not a conflict");
}

// --- a version marker written as an HTML comment, the way the downstream does --
{
	write("# Protocol\n\n<!-- WORKSPACE_PROTOCOL_VERSION: 3 -->\n\nPROJECT_ID: demo\n");
	const state = protocolState(repo);
	assert.equal(state.state, "valid");
	assert.equal(state.version, "3");
	// Blank keys are reported, never fatal: the deep dive is explicit that a
	// loose side-project protocol is a legitimate protocol.
	assert.ok(state.blankKeys.includes("DEFAULT_BRANCH"));
	assert.match(describeProtocolState(state), /still blank/);
}

// --- a key present but with no value is blank, not filled in ------------------
{
	write(`${FULL.replace("DEFAULT_BRANCH: main", "DEFAULT_BRANCH:")}`);
	assert.deepEqual(protocolState(repo).blankKeys, ["DEFAULT_BRANCH"]);
}

// --- unreadable ---------------------------------------------------------------
{
	rmSync(protocolPath, { force: true });
	mkdirSync(protocolPath);
	const state = protocolState(repo);
	assert.equal(state.state, "unreadable");
	assert.match(state.issues.join("; "), /directory/);
	assert.match(describeProtocolState(state), /cannot be read/);
	rmSync(protocolPath, { recursive: true, force: true });
}

// --- the legacy path ----------------------------------------------------------
//
// Older templates said .orchestration/WORKSPACE_PROTOCOL.md while every reader
// said the repository root. Telling someone their protocol is "missing" while
// it sits on disk is the least useful true statement available, so the legacy
// path is resolved — and reported AS legacy, because the Lead still will not
// read it there.
{
	mkdirSync(join(repo, ".orchestration"), { recursive: true });
	writeFileSync(join(repo, LEGACY_PROTOCOL_RELATIVE), FULL);
	const state = protocolState(repo);
	assert.equal(state.state, "valid");
	assert.equal(state.legacy, true);
	assert.match(describeProtocolState(state), /LEGACY/);
	assert.match(describeProtocolState(state), /repository root/);

	// The root wins the moment it exists.
	write(FULL);
	const rooted = protocolState(repo);
	assert.equal(rooted.legacy, false);
	assert.equal(rooted.path, protocolPath);
}

// --- the template we ship must itself grade clean ------------------------------
//
// It is the thing the Human is told to copy. A template that fails the check
// the pack runs would be a very slow way to find out.
{
	const { readFileSync } = await import("node:fs");
	const { dirname } = await import("node:path");
	const { fileURLToPath } = await import("node:url");
	const root = join(dirname(fileURLToPath(import.meta.url)), "..");
	const template = readFileSync(
		join(root, "templates", "WORKSPACE_PROTOCOL.example.md"),
		"utf8",
	);
	// The template wraps the protocol body in a fenced block; the body is what
	// a Human copies out.
	const body = /```text\n([\s\S]*?)```/.exec(template)?.[1];
	assert.ok(body, "the template must still carry a fenced protocol body");
	write(body);
	const state = protocolState(repo);
	assert.equal(
		state.state,
		"valid",
		`the shipped template must grade valid, got: ${state.issues.join("; ")}`,
	);
}

rmSync(repo, { recursive: true, force: true });
console.log("workspace protocol tests passed");

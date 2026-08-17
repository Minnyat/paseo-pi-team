// Static/reference integrity checks for Phase 1 OCR integration.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dirname, "..");
const read = (path) => readFileSync(join(root, path), "utf8");
const ocrSkill = read("skills/paseo-ocr-reviewer/SKILL.md");
const leadSkill = read("skills/paseo-team-lead/SKILL.md");
const leadPrompt = read("prompts/lead.md");
const peerPrompt = read("prompts/peer.md");
const brief = read("examples/reviewer-task.md");
const installPs1 = read("scripts/install.ps1");
const installSh = read("scripts/install.sh");
const ocrSetup = read("scripts/ocr-setup.mjs");
const teamScriptsPath = read("scripts/team-scripts-path.mjs");
const ocrReview = read("scripts/ocr-review.mjs");
const teamCommunication = read("scripts/team-communication.mjs");
const watchdog = read("scripts/watchdog.mjs");
const libCommon = read("scripts/lib-common.mjs");

assert.match(ocrSkill, /name: paseo-ocr-reviewer/);
assert.match(leadSkill, /load `paseo-ocr-reviewer`/);
assert.match(leadPrompt, /paseo-ocr-reviewer/);
assert.match(peerPrompt, /paseo-ocr-reviewer/);
assert.match(ocrSkill, /CANDIDATE_SHA_MISMATCH/);
assert.match(ocrSkill, /DIRTY_REVIEW_WORKSPACE/);
assert.match(ocrSkill, /OCR_UNAVAILABLE/);
assert.match(ocrSkill, /reviewed.*skipped:<concrete reason>/s);
assert.match(ocrSkill, /COVERAGE_RATE/);
assert.match(ocrSkill, /ocr-review\.mjs --repo/);
assert.match(ocrSkill, /--from <REVIEW_BASE_SHA>/);
assert.match(ocrSkill, /--to <ASSIGNED_CANDIDATE_SHA>/);
assert.match(ocrSkill, /RECOMMENDATION: PASS \| CHANGES_REQUIRED \| BLOCKED/);
assert.match(ocrSkill, /STATUS: PARTIAL.*BLOCKED/s);
assert.match(ocrSkill, /`PARTIAL` is never eligible to derive `PASS`/);
assert.match(ocrSkill, /DISPOSITION: BLOCKER \| REQUIRED \| SUGGESTION \| QUESTION \| NIT/);
assert.match(ocrSkill, /DISCOVERED:/);
assert.match(ocrSkill, /EXCLUDED_FILES:/);
assert.match(ocrSkill, /REVIEW_WORKSPACE_CHANGED_DURING_REVIEW/);
assert.match(ocrSkill, /OCR_VERSION_UNSUPPORTED/);
assert.match(ocrSkill, /MANIFEST_DIGEST:/);
assert.match(ocrSkill, /WORKTREE_CLEAN:/);
assert.match(ocrSkill, /REVIEW_LIMITATIONS:/);
assert.doesNotMatch(ocrSkill, /apply critical fixes|fix automatically|review and fix/i);
assert.match(installPs1, /Remove-Item -Recurse -Force \$ocrSkillDir/);
assert.match(installPs1, /\$LASTEXITCODE -ne 0/);
assert.match(installPs1, /remote-paseo\.mjs/);
assert.match(installPs1, /model-routing\.mjs/);
assert.match(installPs1, /PASEO_TEAM_SCRIPTS_DIR/);
assert.match(installPs1, /ocr-setup\.mjs/);
assert.match(installSh, /remote-paseo\.mjs/);
assert.match(installSh, /model-routing\.mjs/);
assert.match(installSh, /PASEO_TEAM_SCRIPTS_DIR/);
assert.match(installSh, /ocr-setup\.mjs/);
assert.match(installSh, /team-scripts-path\.mjs/);
assert.match(installPs1, /team-scripts-path\.mjs/);
assert.match(teamScriptsPath, /PASEO_TEAM_SCRIPTS_DIR/);
assert.match(teamScriptsPath, /PI_CODING_AGENT_DIR/);
// Entrypoint detection must compare canonical paths, not URL text. The
// implementation now lives once in lib-common; each script must route through
// it rather than reintroducing its own comparison.
assert.match(libCommon, /realpathSync/);
for (const [name, text] of [
  ["ocr-review.mjs", ocrReview],
  ["team-communication.mjs", teamCommunication],
  ["watchdog.mjs", watchdog],
]) {
  assert.match(text, /isEntrypoint/, `${name} uses the shared entrypoint check`);
  assert.doesNotMatch(text, /realpathSync\(fileURLToPath/, `${name} has no private copy`);
}
assert.match(ocrSetup, /@alibaba-group\/open-code-review/);
assert.match(ocrSetup, /1\.8\.10/);
assert.match(ocrSetup, /OCR_INSTALL_FAILED/);
assert.match(ocrSkill, /MUST NOT:[\s\S]*edit product code[\s\S]*commit[\s\S]*push[\s\S]*merge[\s\S]*deploy/);

// OCR compatibility is capability-based, never a version-equality gate.
assert.match(ocrSetup, /probeDelegateCapability/);
assert.match(ocrSetup, /OCR_PINNED_VERSION/);
assert.match(ocrSetup, /OCR_MINIMUM_VERSION/);
assert.doesNotMatch(ocrReview, /version\s*!==\s*OCR_/, "review wrapper has no version-equality gate");
assert.match(ocrReview, /OCR_CAPABILITY_MISSING/);
assert.match(ocrReview, /--format/);

// Reviewer worktree isolation is a mechanical invariant end-to-end.
const remotePaseo = read("scripts/remote-paseo.mjs");
assert.match(ocrReview, /assertLinkedWorktree/);
assert.match(ocrReview, /REVIEW_WORKSPACE_NOT_WORKTREE/);
assert.match(ocrReview, /--git-common-dir/);
assert.match(ocrSkill, /REVIEW_WORKSPACE_NOT_WORKTREE/);
assert.match(ocrSkill, /REVIEW_WORKTREE_UNAVAILABLE/);
assert.match(leadSkill, /REVIEW_WORKTREE_UNAVAILABLE/);
assert.match(leadSkill, /--disposition independent-reviewer/);
assert.match(remotePaseo, /REVIEW_ISOLATION_INVALID/);
assert.match(remotePaseo, /independent-reviewer/);
assert.match(remotePaseo, /REVIEW_WORKTREE_UNAVAILABLE/);

// Layer-1 local guard: the policy extension gates MCP create_workspace args.
const policyExtension = read("extensions/paseo-team-policy.ts");
assert.match(policyExtension, /leadCreateWorkspaceBlockReason/);
assert.match(policyExtension, /REVIEW_WORKTREE_UNAVAILABLE/);
assert.match(leadSkill, /review:<TASK_ID>/);

// OCR metadata stays outside the V3 authority marker block.
const authorityBlock = brief.split("PASEO_TEAM_TASK_V3_BEGIN")[1].split("PASEO_TEAM_TASK_V3_END")[0];
assert.doesNotMatch(authorityBlock, /OCR_MODE|OCR_ENGINE|OCR_BASE_SHA|REVIEW_BASE_SHA|REVIEW_CANDIDATE_SHA/);
assert.match(brief, /REVIEW_ENGINE:\s*\nocr-delegate/);
assert.match(brief, /REVIEW_BASE_SHA:/);
assert.match(brief, /REVIEW_CANDIDATE_SHA:/);
assert.match(leadSkill, /ASSIGNED_CANDIDATE_SHA == REVIEW_CANDIDATE_SHA/);
assert.match(ocrSkill, /ASSIGNED_CANDIDATE_SHA == REVIEW_CANDIDATE_SHA/);
assert.match(leadSkill, /PASEO_TEAM_SCRIPTS_DIR.*remote-paseo\.mjs/s);
assert.match(leadSkill, /SUPPORT_DIR/);
assert.match(leadSkill, /supportDir/);
assert.match(ocrSkill, /PASEO_TEAM_SCRIPTS_DIR.*ocr-review\.mjs/s);

// Reviewer authority remains denied in the canonical example.
for (const field of ["EDIT_AUTHORITY", "COMMIT_AUTHORITY", "PUSH_TASK_BRANCH_AUTHORITY", "MERGE_AUTHORITY", "DEPLOY_AUTHORITY"]) {
  assert.match(authorityBlock, new RegExp(`${field}: denied`), `${field} remains denied`);
}

console.log("ocr integrity tests passed");

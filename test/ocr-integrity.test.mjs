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

assert.match(ocrSkill, /name: paseo-ocr-reviewer/);
assert.match(leadSkill, /load `paseo-ocr-reviewer`/);
assert.match(leadPrompt, /paseo-ocr-reviewer/);
assert.match(peerPrompt, /paseo-ocr-reviewer/);
assert.match(ocrSkill, /CANDIDATE_SHA_MISMATCH/);
assert.match(ocrSkill, /DIRTY_REVIEW_WORKSPACE/);
assert.match(ocrSkill, /OCR_UNAVAILABLE/);
assert.match(ocrSkill, /reviewed.*skipped:<concrete reason>/s);
assert.match(ocrSkill, /COVERAGE_RATE/);
assert.match(ocrSkill, /ocr delegate preview/);
assert.match(ocrSkill, /ocr delegate rule/);
assert.match(ocrSkill, /RECOMMENDATION: PASS \| CHANGES_REQUIRED \| BLOCKED/);
assert.match(ocrSkill, /DISPOSITION: BLOCKER \| REQUIRED \| SUGGESTION \| QUESTION \| NIT/);
assert.match(ocrSkill, /DISCOVERED:/);
assert.match(ocrSkill, /EXCLUDED_FILES:/);
assert.match(ocrSkill, /REVIEW_WORKSPACE_CHANGED_DURING_REVIEW/);
assert.match(ocrSkill, /OCR_VERSION_UNSUPPORTED/);
assert.match(ocrSkill, /MANIFEST_DIGEST:/);
assert.doesNotMatch(ocrSkill, /apply critical fixes|fix automatically|review and fix/i);
assert.match(ocrSkill, /MUST NOT:[\s\S]*edit product code[\s\S]*commit[\s\S]*push[\s\S]*merge[\s\S]*deploy/);

// OCR metadata stays outside the V3 authority marker block.
const authorityBlock = brief.split("PASEO_TEAM_TASK_V3_BEGIN")[1].split("PASEO_TEAM_TASK_V3_END")[0];
assert.doesNotMatch(authorityBlock, /OCR_MODE|OCR_ENGINE|OCR_BASE_SHA|REVIEW_BASE_SHA|REVIEW_CANDIDATE_SHA/);
assert.match(brief, /REVIEW_ENGINE:\s*\nocr-delegate/);
assert.match(brief, /REVIEW_BASE_SHA:/);
assert.match(brief, /REVIEW_CANDIDATE_SHA:/);

// Reviewer authority remains denied in the canonical example.
for (const field of ["EDIT_AUTHORITY", "COMMIT_AUTHORITY", "PUSH_TASK_BRANCH_AUTHORITY", "MERGE_AUTHORITY", "DEPLOY_AUTHORITY"]) {
  assert.match(authorityBlock, new RegExp(`${field}: denied`), `${field} remains denied`);
}

console.log("ocr integrity tests passed");

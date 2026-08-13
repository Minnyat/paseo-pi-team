# Example — independent reviewer task (read-only)

```text
PASEO_TEAM_TASK_V3_BEGIN

TASK_ID: T-002
PROJECT_ID: team-test-repo
DISPOSITION: independent-reviewer
MODE: read-only

ASSIGNED_HOST_ID: mac-review
ASSIGNED_PASEO_PROVIDER: pi-peer
ASSIGNED_MODEL: <pi-provider>/<model-id>
ASSIGNED_THINKING: high
WORKSPACE_REF: worktree:../reviews/T-001-<short-sha>
AGENT_REF:

EXPECTED_BASE_SHA:
ASSIGNED_CANDIDATE_SHA: <candidate-sha>

OWNED_SCOPE: none — read-only review; no file may be modified
EXCLUDED_SCOPE: all files

EDIT_AUTHORITY: denied
COMMIT_AUTHORITY: denied
PUSH_TASK_BRANCH_AUTHORITY: denied
FORCE_PUSH_AUTHORITY: denied
MERGE_AUTHORITY: denied
DEPLOY_AUTHORITY: denied

VERIFICATION_PROFILE: independent-review
RETURN_CHANNEL: paseo

PASEO_TEAM_TASK_V3_END

TASK_BODY_BEGIN

OBJECTIVE:
Independently review the candidate from T-001 (engineer task). Falsify the
claim "all tests pass and the change is safe" — do not assume it is true.
Report findings with evidence; do not fix anything yourself.

SUCCESS_BOUNDARY:
A verdict over the EXACT assigned SHA, from a fresh detached worktree, with
the commands you ran as evidence.

KNOWN_EVIDENCE:
- The engineer reported: all tests pass; two edge cases fixed;
  WORKTREE_CLEAN: yes.

REVIEW_ENGINE:
ocr-delegate

REVIEW_BASE_SHA: <base-sha>
REVIEW_CANDIDATE_SHA: <candidate-sha>

QUESTIONS TO ANSWER:
- Is the fix consistent with the test expectations?
- Does the change introduce regressions outside the two edge cases?
- Are there failure modes the tests do not cover (input types, precision)?

CONSTRAINTS:
- Work in a fresh checkout of the assigned SHA — not the engineer's tree:
  git fetch origin agent/T-001
  git worktree add --detach ../reviews/T-001-<short-sha> <candidate-sha>
- Verify `git rev-parse HEAD` equals `ASSIGNED_CANDIDATE_SHA` and
  `REVIEW_CANDIDATE_SHA` equals `ASSIGNED_CANDIDATE_SHA`; any missing or
  differing value is `BLOCKED: CANDIDATE_SHA_MISMATCH`.
  Review on any other SHA must return `BLOCKED: CANDIDATE_SHA_MISMATCH`.
- Verify `git status --porcelain` prints nothing (clean worktree).
  A dirty workspace must return `BLOCKED: DIRTY_REVIEW_WORKSPACE`.
- Run the deterministic wrapper from the installed support directory:
  `node <PASEO_TEAM_SCRIPTS_DIR>/ocr-review.mjs --repo <review-repo> --base <base-sha> --candidate <assigned-candidate-sha>`.
  Any direct OCR diagnostic must use the same `--repo`, `--from <base-sha>`,
  and `--to <assigned-candidate-sha>` values. The wrapper probes the installed
  CLI (Markdown on v1.8.10, `--format json` on 1.9.x) and normalizes both
  forms; normalize only through the deterministic wrapper. It also verifies
  the review workspace is a linked git worktree
  (`BLOCKED: REVIEW_WORKSPACE_NOT_WORKTREE` otherwise).
- Account for every OCR `reviewable_files` item as reviewed or skipped with a concrete reason.
- Do NOT normalize, edit, or fix the candidate to make tests pass.

REQUIRED HANDOFF:
- ASSIGNED_CANDIDATE_SHA, OBSERVED_CANDIDATE_SHA, WORKTREE_CLEAN
- OCR_VERSION, MERGE_BASE, CANDIDATE_TREE_SHA, MANIFEST_DIGEST
- DISCOVERED, TOTAL_REVIEWABLE, EXCLUDED, REVIEWED, SKIPPED, COVERAGE_RATE
- EXCLUDED_FILES with OCR reasons
- COMMANDS_RUN, including the post-review workspace verification
- Structured OCR findings and evidence; every finding has DISPOSITION:
  BLOCKER | REQUIRED | SUGGESTION | QUESTION | NIT
- RECOMMENDATION: PASS | CHANGES_REQUIRED | BLOCKED
- REVIEW_LIMITATIONS: none or a concrete limitation with affected files/rules

TASK_BODY_END
```

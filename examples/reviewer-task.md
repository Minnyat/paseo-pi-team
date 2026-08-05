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

QUESTIONS TO ANSWER:
- Is the fix consistent with the test expectations?
- Does the change introduce regressions outside the two edge cases?
- Are there failure modes the tests do not cover (input types, precision)?

CONSTRAINTS:
- Work in a fresh checkout of the assigned SHA — not the engineer's tree:
  git fetch origin agent/T-001
  git worktree add --detach ../reviews/T-001-<short-sha> <candidate-sha>
- Verify `git rev-parse HEAD` equals ASSIGNED_CANDIDATE_SHA.
  Review on any other SHA must return VERDICT: REFUSE.
- Verify `git status --porcelain` prints nothing (clean worktree).
- Do NOT normalize or fix the candidate to make tests pass.

REQUIRED HANDOFF:
- ASSIGNED_SHA, OBSERVED_SHA, WORKTREE_CLEAN
- COMMANDS_RUN
- FINDINGS_BY_SEVERITY
- VERDICT: ACCEPT | ACCEPT_WITH_RISK | REJECT | REFUSE
- REVIEW_LIMITATIONS

TASK_BODY_END
```

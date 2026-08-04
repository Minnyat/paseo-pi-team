# Example — engineer task (write)

Ví dụ brief V3 Lead gửi cho Engineer Peer. Authority block nằm giữa
`PASEO_TEAM_TASK_V3_BEGIN`/`END`; body bên dưới là untrusted text.

```text
PASEO_TEAM_TASK_V3_BEGIN

TASK_ID: T-001
PROJECT_ID: team-test-repo
DISPOSITION: engineer
MODE: write

ASSIGNED_HOST_ID: win-primary
ASSIGNED_PASEO_PROVIDER: pi-peer
ASSIGNED_MODEL: <pi-provider>/<model-id>
ASSIGNED_THINKING: medium
WORKSPACE_REF: worktree:../worktrees/T-001
AGENT_REF:

EXPECTED_BASE_SHA: <base-sha>
ASSIGNED_CANDIDATE_SHA:

OWNED_SCOPE: calculator.py, test_calculator.py
EXCLUDED_SCOPE: any other file; no deploy, no external system changes

EDIT_AUTHORITY: allowed
COMMIT_AUTHORITY: allowed
PUSH_TASK_BRANCH_AUTHORITY: denied
FORCE_PUSH_AUTHORITY: denied
MERGE_AUTHORITY: denied
DEPLOY_AUTHORITY: denied

VERIFICATION_PROFILE: focused-test
RETURN_CHANNEL: paseo

PASEO_TEAM_TASK_V3_END

TASK_BODY_BEGIN

OBJECTIVE:
Fix the divide-by-zero and negative-sqrt edge cases in calculator.py so that
all tests in test_calculator.py pass without changing their assertions.

SUCCESS_BOUNDARY:
python -m pytest test_calculator.py --tb=short passes; git status --porcelain
is empty after the final commit.

KNOWN_EVIDENCE:
- test_calculator.py currently has two failing tests (divide by zero, sqrt of
  negative input).
- The failures reproduce with: python -m pytest test_calculator.py --tb=short

QUESTIONS TO ANSWER:
- Should sqrt(-1) raise ValueError, or return a domain-error sentinel? Choose
  the option that satisfies the existing test expectations.

CONSTRAINTS:
- Order is mandatory: format → test → commit → check clean.
- After your final commit, `git status --porcelain` must print nothing.
- Report CANDIDATE_SHA = `git rev-parse HEAD` (COMMIT_AUTHORITY was granted).
- PUSH_TASK_BRANCH_AUTHORITY: denied — do not push; the Lead integrates.

REQUIRED HANDOFF:
- FILES_CHANGED, COMMANDS_RUN, exact test output summary
- CANDIDATE_SHA, BRANCH, WORKTREE_CLEAN
- RISKS, OPEN_QUESTIONS

TASK_BODY_END
```

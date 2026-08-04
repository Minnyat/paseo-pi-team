PASEO_TEAM_TASK_V2

TASK_ID: T-001
DISPOSITION: engineer
MODE: write

MODEL_CLASS: CODING_MEDIUM
RESOLVED_HOST_ID: local
RESOLVED_PASEO_PROVIDER: pi-peer
RESOLVED_MODEL: <pi-provider>/<model-id>
RESOLVED_THINKING: medium

OBJECTIVE:
Fix the divide-by-zero and negative-sqrt edge cases in calculator.py so that
all tests in test_calculator.py pass without changing their assertions.

SCOPE:
The team-test-repo repository.

OWNED_SCOPE:
calculator.py
test_calculator.py

EXCLUDED_SCOPE:
Any other file. No deploy, no external system changes.

KNOWN_EVIDENCE:

- test_calculator.py currently has two failing tests (divide by zero, sqrt of
  negative input).
- The failures reproduce with: python -m pytest test_calculator.py --tb=short

OPEN_QUESTIONS:

- Should sqrt(-1) raise ValueError, or return a domain-error sentinel? Choose
  the option that satisfies the existing test expectations.

EDIT_AUTHORITY: allowed
COMMIT_AUTHORITY: allowed
PUSH_TASK_BRANCH_AUTHORITY: denied
FORCE_PUSH_AUTHORITY: denied
MERGE_AUTHORITY: denied
DEPLOY_AUTHORITY: denied

VERIFICATION:

- FORMAT_COMMAND: <declared workspace formatter, or: none>
- TEST_COMMAND: python -m pytest test_calculator.py --tb=short
- Order is mandatory: format → test → commit → check clean.
- After your final commit, `git status --porcelain` must print nothing.
  If it prints anything (e.g. a formatter rewrote the file after your commit),
  fix it before handing off: re-format, re-test, amend a NEW commit on top
  (no amend/force on pushed refs), and re-check clean.

HANDOFF:

- CANDIDATE_SHA: exact commit of your change (COMMIT_AUTHORITY is granted).
- BRANCH: the task branch name.
- PUSHED_REMOTE: none (push is denied for this task; review is local).
- GIT_STATUS_PORCELAIN: paste the empty output of `git status --porcelain`.
- WORKTREE_CLEAN: yes
- FILES_CHANGED, COMMANDS_RUN, and the exact test output.
- Do not merge or deploy.

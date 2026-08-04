PASEO_TEAM_TASK_V2

TASK_ID: T-002
DISPOSITION: independent-reviewer
MODE: read-only

OBJECTIVE:
Independently review the candidate from T-001 (engineer task). Falsify the
claim "all tests pass and the change is safe" — do not assume it is true.
Report findings with evidence; do not fix anything yourself.

SCOPE:
The team-test-repo repository, candidate commit <CANDIDATE_SHA>.

OWNED_SCOPE:
None — read-only review. No file may be modified.

EXCLUDED_SCOPE:
All files. You have no write authority.

KNOWN_EVIDENCE:

- Assigned candidate SHA: <CANDIDATE_SHA> (fill from Lead).
- The engineer reported: all tests pass; two edge cases fixed;
  WORKTREE_CLEAN: yes.

OPEN_QUESTIONS:

- Is the fix consistent with the test expectations?
- Does the change introduce regressions outside the two edge cases?
- Are there failure modes the tests do not cover (input types, precision, etc.)?

EDIT_AUTHORITY: denied
COMMIT_AUTHORITY: denied
PUSH_TASK_BRANCH_AUTHORITY: denied
FORCE_PUSH_AUTHORITY: denied
MERGE_AUTHORITY: denied
DEPLOY_AUTHORITY: denied

VERIFICATION:

- Work in a fresh checkout of the assigned SHA — not the engineer's tree.
- Verify `git rev-parse HEAD` equals the assigned SHA.
- Verify `git status --porcelain` prints nothing (clean worktree).
  A dirty tree makes the candidate UNSTABLE: refuse the review, even if the
  SHA matches. Do not normalise away whitespace-only changes by default.
- Run: python -m pytest test_calculator.py --tb=short
- Report the observed SHA explicitly in your verdict.
- If the observed SHA differs from the assigned SHA, refuse the review.

HANDOFF:

- OBSERVED_SHA, GIT_STATUS_PORCELAIN (paste output), WORKTREE_CLEAN: yes|no
- Return a verdict (APPROVE / REQUEST_CHANGES / REFUSED) with findings tied
  to files and commands. Do not edit any file. Do not merge or deploy.

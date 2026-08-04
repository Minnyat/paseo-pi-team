PASEO_TEAM_TASK_V1

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
- The engineer reported: all tests pass; two edge cases fixed.

OPEN_QUESTIONS:

- Is the fix consistent with the test expectations?
- Does the change introduce regressions outside the two edge cases?
- Are there failure modes the tests do not cover (input types, precision, etc.)?

VERIFICATION:

- Verify the observed working tree matches the assigned SHA.
- Run: python -m pytest test_calculator.py --tb=short
- Report the observed SHA explicitly in your verdict.
- If the observed SHA differs from the assigned SHA, refuse the review.

HANDOFF:
Return a verdict (APPROVE / REQUEST_CHANGES) with findings tied to files and
commands. Do not edit any file. Do not merge or deploy.

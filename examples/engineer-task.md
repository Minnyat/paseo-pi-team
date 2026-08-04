PASEO_TEAM_TASK_V1

TASK_ID: T-001
DISPOSITION: engineer
MODE: write

OBJECTIVE:
Fix the divide-by-zero and negative-sqrt edge cases in calculator.py so that
all tests in test_calculator.py pass without changing their assertions.

SCOPE:
The team-test-repo repository.

OWNED_SCOPE:
calculator.py
test_calculator.py

EXCLUDED_SCOPE:
Any other file. No commit, no push, no deploy, no external system changes.

KNOWN_EVIDENCE:

- test_calculator.py currently has two failing tests (divide by zero, sqrt of
  negative input).
- The failures reproduce with: python -m pytest test_calculator.py --tb=short

OPEN_QUESTIONS:

- Should sqrt(-1) raise ValueError, or return a domain-error sentinel? Choose
  the option that satisfies the existing test expectations.

VERIFICATION:
Run: python -m pytest test_calculator.py --tb=short
All tests must pass. Include the exact command output in your report.

HANDOFF:
Report the exact candidate commit SHA of your change, plus FILES_CHANGED and
COMMANDS_RUN. Do not merge or deploy.

# Example — two writers, one seam

Two Engineer briefs the Lead sends in parallel. The split follows an ownership
boundary (server code and web code have different owners and different tests),
not a wish for more phases, so both run at once and the job is accepted when
both candidates are.

What the two briefs share is the **seam contract**: the one thing both halves
build against. It appears word for word in both, because a Peer cannot see the
other Peer's brief, and two paraphrases of a contract are two contracts.
Everything behind the seam (helpers, names, how the rows are produced, how the
button is wired) is left to the Peer that owns it.

## T-11 — the server half

```text
PASEO_TEAM_TASK_V3_BEGIN

TASK_ID: T-11
PROJECT_ID: billing
DISPOSITION: engineer
MODE: write

EXPECTED_BASE_SHA: <base-sha>

OWNED_SCOPE: src/api/invoices/**, test/api/invoices/**
EXCLUDED_SCOPE: web/**; any schema migration

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
Customers should be able to get their own invoices as a CSV without asking
support. Today support exports them by hand, about forty tickets a week. You
own the server side; T-12 is building the billing-page button against the same
contract at the same time.

CONSTRAINTS:
The seam contract below is fixed. T-12 is coding against it right now, so if
any of it looks wrong, send me a REOPEN_REQUEST rather than changing it:

  GET /api/invoices/export?from=YYYY-MM-DD&to=YYYY-MM-DD
  - 200, Content-Type text/csv; first line exactly:
    invoice_id,issued_at,amount_cents,currency,status
  - only the signed-in customer's invoices, issued_at within [from, to]
  - a range with no invoices: 200 with the header line only
  - 400 {"error":"invalid_range"} when from > to or the range exceeds 366 days
  - 401 when not signed in

Everything behind it is yours: how you query, whether you stream, where the
helper lives and what it is called. No transitional state is planned, so
please do not leave one (no feature flag, no second route).

REQUIRED HANDOFF:
The test command and its result, CANDIDATE_SHA, a clean `git status`, and
anything in the contract you had to interpret.

TASK_BODY_END
```

## T-12 — the web half

```text
PASEO_TEAM_TASK_V3_BEGIN

TASK_ID: T-12
PROJECT_ID: billing
DISPOSITION: engineer
MODE: write

EXPECTED_BASE_SHA: <base-sha>

OWNED_SCOPE: web/src/billing/**, web/test/billing/**
EXCLUDED_SCOPE: src/**; shared web components outside web/src/billing

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
Customers should be able to get their own invoices as a CSV without asking
support. You own the billing page; T-11 is building the endpoint against the
same contract at the same time, so it will not exist on your base SHA.

CONSTRAINTS:
The seam contract below is fixed. If any of it looks wrong, send me a
REOPEN_REQUEST rather than changing it:

  GET /api/invoices/export?from=YYYY-MM-DD&to=YYYY-MM-DD
  - 200, Content-Type text/csv; first line exactly:
    invoice_id,issued_at,amount_cents,currency,status
  - only the signed-in customer's invoices, issued_at within [from, to]
  - a range with no invoices: 200 with the header line only
  - 400 {"error":"invalid_range"} when from > to or the range exceeds 366 days
  - 401 when not signed in

Because the endpoint is not there yet, stub it inside your own test files only.
A mock route or fixture server shipped in the app would be a transitional state
nobody planned to remove. How the range picker, the button and the error
messages look and are wired is your call.

REQUIRED HANDOFF:
The test command and its result, CANDIDATE_SHA, a clean `git status`, and
anything in the contract you had to interpret.

TASK_BODY_END
```

## What is deliberately not in these briefs

- No file list beyond `OWNED_SCOPE`, no function names, no step-by-step. A
  brief that dictates the insides turns the Peer into a typist and removes the
  one seat that could tell the Lead the plan is wrong.
- No "phase 1: endpoint, phase 2: button". Nothing about the button needs the
  endpoint to exist first, only the contract, so a sequence would add a round
  trip and, most likely, a placeholder the second phase builds on.
- No second wording of the contract. If the Lead needs to change it, it sends
  both Peers the new text in a full V3 brief, not a note to one of them.

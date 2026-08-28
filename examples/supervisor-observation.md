# Example: Supervisor observation

The Supervisor does not modify code and does not orchestrate Peers — it turns
an observation into an evidence-backed question for the Lead, or escalates to
the Human.

The shape below is not decoration. `parseSupervisorBlock` looks for the literal
line `SUPERVISOR_OBSERVATION` **on its own**; a message without it is not parsed
at all, which means under `PASEO_TEAM_TOPOLOGY=multi` the receiving Lead gets no
jurisdiction verdict and your message silently carries no checked authority.

## A plain observation (no decision)

```text
SUPERVISOR_OBSERVATION

PROJECT_ID: shop
DOMAIN: backend.storage
FROM_AGENT_ID: 7f3c1e02-9a41-4b77-8d2e-1c9a5b6f0d34
TASK_ID: T-003
LEAD_REF: pi-lead/anthropic/claude-opus-5#a41f
TIMESTAMP: 2026-08-28T09:22:11Z

OBSERVATION:
Two Engineer Peers (T-003, T-004) hold overlapping OWNED_SCOPE in
src/storage/**. Two writers on one moving scope risk lost updates.

EVIDENCE:
- create_agent T-003 at 09:12, owned scope "src/storage/**"
- create_agent T-004 at 09:15, owned scope "src/storage/**"
- team_lease status: one lease on "src/storage/**", holder is T-003's Lead
- neither agent requested worktree isolation

SUSPECTED_MECHANISM:
The second writer was staffed under the lease the first one holds, so the
ledger shows one lease where two writers exist.

IMPACT:
Moving-scope collision: reviewers read one state while writers overwrite
another; integration cost and revert risk both rise.

QUESTION_FOR_LEAD:
Was T-004 meant to inherit T-003's lease, or is one of the two scopes stated
wider than the work actually needs?

RECOMMENDATION:
Split the scope into non-overlapping ownership, or isolate one writer in its
own worktree, before either produces a candidate.

HUMAN_DECISION_REQUIRED: no

CONFIDENCE: high
```

## The same block carrying a delegated decision

Fill `SUPERVISOR_DECISION` **only** when you actually decided in the Human's
place, and only when all four delegation criteria hold. `REVERSIBILITY:
irreversible` is a contract violation in writing — the parser marks the block
malformed and the Lead refuses it.

```text
SUPERVISOR_OBSERVATION

PROJECT_ID: shop
DOMAIN: backend.storage
FROM_AGENT_ID: 7f3c1e02-9a41-4b77-8d2e-1c9a5b6f0d34
TASK_ID: T-003
LEAD_REF: pi-lead/anthropic/claude-opus-5#a41f
TIMESTAMP: 2026-08-28T09:41:03Z

OBSERVATION:
The T-003 test step failed once on a gateway 524, not on an assertion.

EVIDENCE:
- get_agent_activity T-003 09:38: "Stream ended without finish_reason"
- the previous run of the same command passed at 09:31 on the same SHA

SUSPECTED_MECHANISM:
Transient gateway error, not a logic failure.

IMPACT:
Without a retry the Lead re-plans a step that never actually ran.

QUESTION_FOR_LEAD:
None — retrying is within the delegated boundary.

RECOMMENDATION:
Retry the step once and report the result before re-planning.

HUMAN_DECISION_REQUIRED: no

SUPERVISOR_DECISION:
  DECISION: retry the T-003 test step once, unchanged
  SCOPE: T-003, test step only — no file changes
  REVERSIBILITY: reversible
  DELEGATION_CRITERIA_MET: one step in the current task, no contract or
    dependency change (1); nothing to roll back beyond discarding the run (2);
    based on the observed gateway error, not a suspected mechanism (3); no
    Invariant in lead.md and no Human guidance touched (4)
  RATIONALE: the step failed on transport, so re-planning would be a response
    to evidence that does not exist
  ROLLBACK_PATH: ignore the retry result and re-plan as originally intended
  FOLLOWED_UP: no

CONFIDENCE: high
```

## Fields the runtime actually checks

| Field | If wrong or missing |
|---|---|
| the `SUPERVISOR_OBSERVATION` header line | the message is not parsed at all — no verdict reaches the Lead |
| `DOMAIN:` | `JURISDICTION_UNDECLARED`; a domain that does not cover the Lead is `JURISDICTION_MISMATCH` |
| `FROM_AGENT_ID:` | a DECISION without it is refused (`JURISDICTION_UNATTRIBUTED`) — an unsigned decision cannot be checked for overlap; an observation is only flagged |
| any duplicated field | `SUPERVISOR_BLOCK_MALFORMED` |
| `REVERSIBILITY: irreversible` inside a decision | `SUPERVISOR_BLOCK_MALFORMED` — an irreversible matter is the Human's |

The DOMAIN rules apply under `PASEO_TEAM_TOPOLOGY=multi`. Under `single` the
verdict is not computed at all, so the contract above rests on you alone.

Note: if the same symptom appears a third time, raise the root-mechanism
question instead of asking for yet another local patch.

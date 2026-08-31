# Example: a Lead consults the Supervisor instead of the Human

The Lead is not supposed to stop and ask the Human every time it hits a question
it cannot settle. It asks the Supervisor, which either decides on the Human's
behalf or escalates — and says which criterion made it escalate.

The shape below is not decoration. `parseLeadConsultBlock` looks for the literal
line `LEAD_CONSULT_V1` **on its own**, and a consult missing any field the four
*Delegated decisions* criteria are checked against is refused as malformed. You
do not normally write this by hand: `lead_ask_supervisor` builds it, and refuses
an incomplete one at your end rather than after a round trip.

## The consult the Lead sends

```text
lead_ask_supervisor {
  kind: "decision",
  question: "Retry the token refresh once, or fail step 3 and report?",
  options: "a) retry once with 2s backoff\nb) fail the step and report to the Human",
  evidence: "run 1 failed with ECONNRESET after 30s; a manual rerun with no code change passed; the provider's status page shows a 4-minute incident covering run 1",
  scope: "src/auth/token.ts — step 3 of T-009",
  reversibility: "reversible",
  recommendation: "a — the signature is transient, and a retry is one command to undo",
  taskId: "T-009",
  projectId: "shop"
}
```

What arrives at the Supervisor:

```text
LEAD_CONSULT_V1
KIND: decision
CORRELATION_ID: consult-1756631041-8fa2c1
TASK_ID: T-009
PROJECT_ID: shop
FROM_AGENT_ID: cc9a1e02-9a41-4b77-8d2e-1c9a5b6f0d34
DOMAIN: backend.auth
SCOPE: src/auth/token.ts — step 3 of T-009
REVERSIBILITY: reversible

QUESTION:
Retry the token refresh once, or fail step 3 and report?

OPTIONS:
a) retry once with 2s backoff
b) fail the step and report to the Human

EVIDENCE:
run 1 failed with ECONNRESET after 30s; a manual rerun with no code change
passed; the provider's status page shows a 4-minute incident covering run 1

RECOMMENDATION:
a — the signature is transient, and a retry is one command to undo
```

`FROM_AGENT_ID` is the signature. The Supervisor's runtime resolves it against
Paseo's own agent state, and a consult whose sender does not come back as a Lead
seat gets `LEAD_CONSULT_SENDER_UNVERIFIED` — answerable, but never with a
delegated decision. Anything can type the header.

## The answer that ends it (all four criteria hold)

```text
SUPERVISOR_OBSERVATION

PROJECT_ID: shop
DOMAIN: backend.auth
FROM_AGENT_ID: 7f3c1e02-9a41-4b77-8d2e-1c9a5b6f0d34
TASK_ID: T-009
LEAD_REF: pi-lead/anthropic/claude-opus-5#a41f
TIMESTAMP: 2026-08-31T10:14:02Z

OBSERVATION:
Answering LEAD_CONSULT consult-1756631041-8fa2c1.

EVIDENCE:
The failure signature (ECONNRESET at 30s) matches the provider incident window
the Lead cited, and the unchanged rerun passed. That is a proven transient, not
a suspected mechanism.

HUMAN_DECISION_REQUIRED: no

SUPERVISOR_DECISION:
  DECISION: retry step 3 once with 2s backoff; if it fails again, stop and consult again
  SCOPE: src/auth/token.ts — step 3 of T-009
  REVERSIBILITY: reversible
  DELEGATION_CRITERIA_MET: one step of the current task (1); a retry undoes itself and touches no external system (2); proven transient with two independent signals (3); no invariant in lead.md is engaged (4)
  RATIONALE: retrying a proven transient is cheaper than a correction round, and the "once, then consult again" bound stops it becoming a loop.
  ROLLBACK_PATH: nothing to roll back — a failed retry leaves the same state as failing now.
  FOLLOWED_UP: no

CONFIDENCE: high
```

The Lead's own runtime marks this `SUPERVISOR_DECISION_BINDING`. Under
`lead.md` invariant 6b the Lead **acts on it** and records it with its
`ROLLBACK_PATH` in the next `LEAD_REPORT`. Taking it back to the Human for
confirmation is the failure mode, not the safe option.

## The answer when a criterion fails

Escalation is a legitimate outcome — but it has to name the criterion, or the
Lead cannot act on it either and neither can the Human.

```text
SUPERVISOR_OBSERVATION

PROJECT_ID: shop
DOMAIN: backend.auth
FROM_AGENT_ID: 7f3c1e02-9a41-4b77-8d2e-1c9a5b6f0d34
TASK_ID: T-009
LEAD_REF: pi-lead/anthropic/claude-opus-5#a41f
TIMESTAMP: 2026-08-31T10:14:02Z

OBSERVATION:
Answering LEAD_CONSULT consult-1756631041-8fa2c1. Escalating.

EVIDENCE:
This is the second time step 3 has failed and been "fixed" by a retry — the
first was T-007 on 2026-08-29. A repeat offender is a sign of mis-estimation,
not of a transient.

QUESTION_FOR_LEAD:
What changed between T-007 and T-009 that would make the same retry work this
time?

RECOMMENDATION:
Treat the refresh path as suspect and scout it before retrying again.

HUMAN_DECISION_REQUIRED: yes

CONFIDENCE: medium
```

Criterion 3 (sufficient evidence) is the one that failed, and the message says
so in `EVIDENCE` rather than leaving the Lead to infer it. The Lead now goes to
the Human **quoting that reason** — which is the difference between an
escalation and an interruption.

## When there is nobody to consult

`lead_ask_supervisor` answers `NO_SUPERVISOR_SEAT` when the cluster has no
governance seat, and hands back the call that fixes it:

```text
create_agent {
  provider: "pi-supervisor/anthropic/claude-opus-5",
  labels: { purpose: "governance", "team.cluster": "shop", "team.domain": "backend" },
  settings: { thinkingOptionId: "high" },
  initialPrompt: "<brief: the project, the Workspace Protocol, what you govern, and a create_heartbeat cadence>"
}
```

This is the one case where putting the question to the Human is correct — and
the Lead should say that this is why it is asking.

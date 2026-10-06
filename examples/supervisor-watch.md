# Example: a long job's Supervisors

One Supervisor carrying every concern — consults, liveness rounds, process and
review checks, cost — fills its context on a long job the way a Lead's fills when
the Lead does the reading itself. For a long job the Lead seats the Supervisor that
**decides**, then **watch seats** beside it, each carrying one kind of thing in
`labels["team.watch"]`. The catalog is closed: `decisions`, `liveness`, `process`,
`evidence`, `cost`. A seat with no `team.watch` is the one-Supervisor default —
it watches everything and decides — which is right for a short job.

Everything below is a Lead's `create_agent`, after the routing cycle of the
`paseo-team-lead` skill (steps 1–4: class, host, route, daemon). Claude seats
(`claude-supervisor/<model-id>`) also need `settings.modeId`.

## 1. The seat that decides — first, and only one

```text
create_agent {
  title: "Governance — shop",
  provider: "pi-supervisor/anthropic/claude-opus-5",
  initialPrompt: "You govern the shop project … (the project, the Workspace Protocol, what the Lead may ask you)",
  settings: { thinkingOptionId: "high" },
  labels: {
    "purpose": "governance",
    "team.cluster": "shop",
    "team.model-class": "SUPERVISOR_GOVERNANCE",
    "team.watch": "decisions"
  }
}
```

It answers the Lead's `lead_ask_supervisor`, issues the binding
`SUPERVISOR_DECISION`, and is the only seat that may recover a Lead. Keeping it to
`decisions` keeps its context small: it reads consults, not activity logs.

## 2. Watch seats — as many as the job wants

A cheap mechanical seat. `MONITOR_ECONOMY` is the class that already meant
"supervisor heartbeat, structured observation", and only a watch seat may use it:

```text
create_agent {
  title: "Watch liveness+cost — shop",
  provider: "pi-supervisor/Mx/cheap",
  initialPrompt: "You watch liveness and cost for the shop job. Arm one heartbeat every 15 minutes …
                  Watch the writers T-3 and T-4 and the review seats. Say something only when a seat is stale,
                  parked, or a report is inlining a document.",
  settings: { thinkingOptionId: "low" },
  labels: {
    "purpose": "governance",
    "team.cluster": "shop",
    "team.model-class": "MONITOR_ECONOMY",
    "team.watch": "liveness,cost"
  }
}
```

A judgement seat, on the governance route:

```text
create_agent {
  title: "Watch process+evidence — shop",
  provider: "pi-supervisor/anthropic/claude-opus-5",
  initialPrompt: "You watch the Lead's process and the evidence behind acceptance for the shop job …",
  settings: { thinkingOptionId: "high" },
  labels: {
    "purpose": "governance",
    "team.cluster": "shop",
    "team.model-class": "SUPERVISOR_GOVERNANCE",
    "team.watch": "process,evidence"
  }
}
```

What the policy says when the order or the count is wrong:

| The Lead tries | Answer |
|---|---|
| a watch seat before any seat that decides | refused — *"a watch seat … reports beside a Supervisor that decides, and none covers this Lead yet"* |
| a second seat with no `team.watch`, or one naming `decisions` | refused — *"this cluster already has a Supervisor that decides (…)"*; every consult would be `SUPERVISOR_AMBIGUOUS` |
| `team.watch: "liveness,vibes"` | refused, naming what is not in the catalog |
| `MONITOR_ECONOMY` for the seat that decides | `ROUTE_CLASS_WRONG_FLOW` — it keeps `SUPERVISOR_GOVERNANCE` |
| `update_agent` setting `team.watch` later | `WATCH_IMMUTABLE` — a different remit is a new seat |

## 3. What a watch seat sends

An observation, about its own concerns only:

```text
SUPERVISOR_OBSERVATION

PROJECT_ID: shop
FROM_AGENT_ID: 7f3c1e02-9a41-4b77-8d2e-1c9a5b6f0d34
TASK_ID: T-004
TIMESTAMP: 2026-10-06T09:41:03Z

OBSERVATION:
T-004's writer has shown no activity for 27 minutes, and its last tool call is a
test run the brief did not mark as long-running.

EVIDENCE:
- team_watchdog 09:38: T-004 stale, UpdatedAt 09:11
- get_agent_status T-004: running, no pending permission

QUESTION_FOR_LEAD:
Is that test run expected to take this long?

RECOMMENDATION:
Ask the writer; do not replace it while its commit state is unclear.

HUMAN_DECISION_REQUIRED: no

CONFIDENCE: medium
```

If a watch seat fills `SUPERVISOR_DECISION` anyway, the Lead's turn opens with
`SUPERVISOR_DECISION_NOT_DELEGATED`: refused, weighed as an observation, and the
sender is asked to resend it as one. The Lead learns that from the sender's own
Paseo state, not from anything the message says.

## 4. The Lead's own context: a standing scout

The Lead holds decisions, not data. One read-only scout, seated once, answers
everything that would otherwise be the Lead reading files or running commands. A
follow-up is a plain `send_agent_prompt` — no routing cycle, and no V3 brief,
because a prompt without one is read-only for that turn, which is what a read wants:

```text
send_agent_prompt {
  agentId: "<the standing scout>",
  prompt: "Which module recalculates order-level discounts today, and is the
           two-pass behaviour one function or a protocol across modules? About a
           screen, pointing at files and lines — I don't need the code pasted back."
}
```

## 5. Replacing a heavy watch seat

When a watch seat says it is growing heavy (or `cost` notices it), the Lead does not
compact it and does not fork it — a fork inherits the weight. It seats the successor
with the same `team.watch`, briefed with what to keep watching and a pointer to the
old seat's last observation, and then archives the old one. Two seats with the same
watch for a moment is fine: attention may overlap. When the job is accepted the Lead
archives the watch seats it seated; the seat that decides stays.

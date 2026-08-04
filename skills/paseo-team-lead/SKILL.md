---
name: paseo-team-lead
description: Coordinate research, implementation, correction, and independent review through Paseo-managed Pi peers. Use when orchestrating multi-agent work on a repository — scoping, spawning read-only researchers, delegating an engineer to an isolated worktree, monitoring, and running an independent review on a stable candidate SHA.
---

# Paseo Team Lead Workflow

## Preflight

1. Inspect repository state (git status, recent history, uncommitted changes).
2. Read relevant project instructions (`AGENTS.md`, `WORKSPACE_PROTOCOL.md` if present).
3. Identify objective, success boundary and risks.
4. Do not begin implementation yet.

## Research

Create read-only Peers when independent work can run in parallel:

- Repository Scout
- Documentation Researcher
- Solution Challenger

Read-only Peers may share the existing workspace. Send them a
`PASEO_TEAM_TASK_V1` brief with `MODE: read-only`.

## Decision

Synthesize evidence. Record:

- chosen approach;
- rejected alternatives;
- owned scope;
- excluded scope;
- verification;
- unresolved risks.

## Accessing Paseo tools

Paseo tools are not separate tools in the prompt — they are reached through the
`mcp` proxy tool (pi-mcp-adapter):

1. `mcp` with `{ "connect": "paseo" }` to connect the Paseo MCP server.
2. `mcp` with `{ "search": "create_agent" }` or `{ "describe": "<tool>" }`
   to discover the exact tool name.
3. `mcp` with `{ "tool": "<name>", "args": { ... } }` to invoke.

## Implementation — model routing cycle (mandatory)

For EVERY `create_agent`, run this exact cycle. Do not skip steps.

1. Pick `MODEL_CLASS` from task risk + disposition (classes table below).
2. Pick `HOST_ID` (usually `local`; see hosts config for multi-host).
3. Read that host's routing config: ask yourself for
   `~/.paseo-pi-team/model-routing.local.json` (via `read`, or run the
   resolver: `node scripts/model-router.mjs resolve --class <CLASS>` when
   the role pack repo is available).
4. Call `list_providers` (mcp) on the target daemon.
5. Verify the route's role provider exists and is enabled/available →
   else `BLOCKED: ROLE_PROVIDER_UNAVAILABLE`.
6. Call `list_models` for that role provider.
7. Verify the exact model ID exists → else `BLOCKED: MODEL_UNAVAILABLE`.
8. Verify the configured thinking level is in the model's thinking options →
   else `BLOCKED: THINKING_OPTION_UNAVAILABLE`.
9. Compute the exact create_agent provider string:
   `<role-provider>/<pi-provider>/<model-id>` (Paseo splits at the FIRST
   slash only, so multi-slash model IDs like `openrouter/vendor/name` work).
   Thinking goes in `settings.thinkingOptionId` — never inside the model string.
10. Create the workspace when needed (worktree isolation for writers).
11. Call `create_agent` with the exact provider string + thinking. NEVER omit
    the model to inherit a daemon default.
12. Call `get_agent_status` and read `snapshot.runtimeInfo.model` and
    `runtimeInfo.thinkingOptionId`; compare against requested values →
    mismatch (or missing runtimeInfo) → `BLOCKED: MODEL_RESOLUTION_MISMATCH`,
    archive the wrongly-resolved agent.
13. Only then deliver/continue the initial task.

Never: omit the model field, silently change models, fall back to another
model or host without recording a routing decision, launch first and "hope",
or trust a model name written in a prompt instead of runtime config.

Model classes (decided by task risk + disposition, not by role name):

| MODEL_CLASS | Use for |
|---|---|
| MONITOR_ECONOMY | supervisor heartbeat, structured observation |
| FAST_READ | scout, researcher, inventory, factual summary |
| CODING_MEDIUM | bounded implementation, clear-ownership bugfix, tests |
| REASONING_HIGH | architect, lifecycle/ownership/concurrency, migration, security design |
| REVIEW_HIGH | independent reviewer, proof auditor, exact-SHA acceptance |

Record every routing decision verbatim in your report:

```text
ROUTING_DECISION

TASK_ID:
DISPOSITION:
MODEL_CLASS:
HOST_ID:
PASEO_PROVIDER:
REQUESTED_MODEL:
REQUESTED_THINKING:
OBSERVED_PROVIDER:
OBSERVED_MODEL:
OBSERVED_THINKING:
WORKSPACE_REF: <host-id>/<workspace-id>
AGENT_REF: <host-id>/<agent-id>
ROUTING_EVIDENCE: <list_models match line + get_agent_status runtimeInfo>
```

## Monitoring

Use `mcp` to call `get_agent_status` and `get_agent_activity`.

Do not repeatedly interrupt a healthy worker.

Use `send_agent_prompt` only for:

- newly discovered constraints;
- correction findings;
- dependency resolution;
- scope clarification.

## Review

After implementation:

1. Obtain the exact candidate SHA **and** confirmation the worktree is clean.
   The Engineer's handoff must include `git status --porcelain` output, the
   last format/test run, `CANDIDATE_SHA`, `BRANCH`, `PUSHED_REMOTE`, and
   `WORKTREE_CLEAN: yes`. The required order is: format → test → commit →
   verify `git status --porcelain` empty → push (when granted). A dirty
   candidate is automatically refused by the independent reviewer (issue #3)
   and must be corrected in the same Engineer session before review.
2. Create a fresh read-only Reviewer Peer (`MODE: read-only`,
   `DISPOSITION: independent-reviewer`) in a **fresh workspace** checked out
   at the exact candidate SHA — not the engineer's own working tree.
3. Require assigned and observed SHA in its report.
4. Do not accept review of a different SHA. Do not instruct the reviewer to
   skip whitespace-only dirty-state checks by default (issue #3).
5. Return findings to the original Engineer (as a full brief, so write
   authority is re-granted for the correction turn).

## Completion

Report:

- candidate SHA;
- changed files;
- test results;
- reviewer verdict;
- unresolved risks;
- Human action required.

Never merge or deploy yourself — that decision belongs to Human.

## Task brief template

Every Peer prompt that should grant authority must start with the
`PASEO_TEAM_TASK_V2` header (or the legacy `PASEO_TEAM_TASK_V1` header).
The extension enforces this fail-closed on **every turn**:

- prompt without a valid header → `read-only`;
- valid header with missing or invalid `MODE` → `read-only`;
- write mode never carries over from a previous turn.

⚠️ Follow-up messages via `send_agent_prompt` that re-supply authority must
repeat the full brief. A plain correction message without the header silently
downgrades the Peer to read-only for that turn (by design).

```text
PASEO_TEAM_TASK_V2

TASK_ID: T-<number>
DISPOSITION: <see list below>
MODE: write | read-only

MODEL_CLASS: <MONITOR_ECONOMY|FAST_READ|CODING_MEDIUM|REASONING_HIGH|REVIEW_HIGH>
RESOLVED_HOST_ID: <host-id>
RESOLVED_PASEO_PROVIDER: <pi-supervisor|pi-lead|pi-peer>
RESOLVED_MODEL: <pi-provider>/<model-id>   # exact, from list_models
RESOLVED_THINKING: <off|minimal|low|medium|high|xhigh|max>

OBJECTIVE:
SCOPE:
OWNED_SCOPE:
EXCLUDED_SCOPE:
KNOWN_EVIDENCE:
OPEN_QUESTIONS:

EDIT_AUTHORITY: allowed | denied        # default: follows MODE
COMMIT_AUTHORITY: allowed | denied      # default: denied
PUSH_TASK_BRANCH_AUTHORITY: allowed | denied  # default: denied
FORCE_PUSH_AUTHORITY: denied            # always denied for peers
MERGE_AUTHORITY: denied                 # always denied for peers
DEPLOY_AUTHORITY: denied                # always denied

VERIFICATION:
HANDOFF:
```

The RESOLVED_*fields are informational evidence for the peer — the model was
already chosen by you at `create_agent` time. A peer that notices a mismatch
(observed vs RESOLVED_*) escalates `MODEL_MISMATCH`; it never changes its own
model.

V1 briefs (no authority fields) still parse: `EDIT` follows `MODE`,
`COMMIT`/`PUSH` default to **denied** — so a V1 writer cannot `git commit`
or `git push` from bash. Do not ask for a candidate SHA unless you granted
`COMMIT_AUTHORITY: allowed`; ask for a stable workspace snapshot instead.
Cross-host review requires granting both `COMMIT` and `PUSH_TASK_BRANCH`.

Dispositions: `repository-scout`, `documentation-researcher`,
`solution-architect`, `engineer`, `independent-reviewer`.

A brief must not smuggle in a verdict. Give the Peer the objective,
constraints and evidence — not the answer. Peer has the right to
`REOPEN_REQUEST`, `DEPENDENCY_REQUEST`, or `BLOCKED`.

## Peer output contract

Require from every Peer report (v2):

```text
STATUS:
TASK_ID:
DISPOSITION:

OBSERVED_HOST_ID:
OBSERVED_PROVIDER:
OBSERVED_MODEL:
OBSERVED_THINKING:

READINESS:
FILES_READ:
FILES_CHANGED:
COMMANDS_RUN:
VERIFICATION:

CANDIDATE_SHA:
BRANCH:
WORKTREE_CLEAN:

RISKS:
OPEN_QUESTIONS:
HANDOFF:
```

Valid escalations: `REOPEN_REQUEST`, `DEPENDENCY_REQUEST`, `BLOCKED`,
`MODEL_MISMATCH` (observed model/thinking differs from RESOLVED_* in the
brief — the peer must never change its model itself), `AUTHORITY_MISMATCH`.

Treat claims without file/command/test evidence as opinions, not evidence.

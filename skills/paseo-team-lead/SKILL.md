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
**V3 read-only brief** (`PASEO_TEAM_TASK_V3_BEGIN` … `PASEO_TEAM_TASK_V3_END`
with `MODE: read-only` — see "Task brief template" below). Legacy
`PASEO_TEAM_TASK_V1|V2` headers are parseable for diagnostics only: the
extension ALWAYS resolves them read-only and ignores their MODE and
`*_AUTHORITY` fields, so never use them for new work.

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
2. Pick `HOST_ID` from the controller-local cluster routing file
   `~/.paseo-pi-team/cluster-routing.local.json` (capability filter: writers
   need `git-write`+`focused-test`; reviewers need `git-read`+`independent-review`).
3. Read that host's route from the SAME file (single source of truth for the
   whole cluster — never infer a remote host's route from local memory), or
   run the resolver when the role pack repo is available:
   `node scripts/model-routing.mjs resolve --class <CLASS>` for the local
   `model-routing.local.json` (legacy single-host form).
4. Verify the target daemon is reachable (local: `paseo status`; remote: the
   endpoint env var named by `connection.endpointEnv` must be SET before
   routing — never print or invent its value).
5. Call `list_providers` (mcp) ON THE TARGET DAEMON (remote daemons via the
   `--host` mechanism; verify the answer comes from the intended daemon).
6. Verify the route's role provider exists and is enabled AND reports a
   healthy status (an enabled provider with a bad status is NOT routable) →
   else `BLOCKED: ROLE_PROVIDER_UNAVAILABLE`.
7. Call `list_models` for that role provider.
8. Verify the exact model ID exists (check BOTH segments are non-empty in
   `<pi-provider>/<model-id>`) → else `BLOCKED: MODEL_UNAVAILABLE`.
9. Verify the configured thinking level is in the model's thinking options →
   else `BLOCKED: THINKING_OPTION_UNAVAILABLE`. If the model exposes NO
   option list, thinking is UNVERIFIABLE — refuse the route
   (strict policy: unverifiable is not a pass).
10. Verify against `~/.pi/agent/models.json` `thinkingLevelMap` on the target
    host: a level mapped to `null` is silently clamped by pi → pick another
    level/model instead of accepting the clamp.
11. Compute the exact create_agent provider string:
    `<role-provider>/<pi-provider>/<model-id>` (Paseo splits at the FIRST
    slash only, so multi-slash model IDs like `openrouter/vendor/name` work).
    Thinking goes in `settings.thinkingOptionId` — never inside the model string.
12. Create the workspace when needed (worktree isolation for writers).
13. Call `create_agent` with the exact provider string + thinking. NEVER omit
    the model to inherit a daemon default.
14. Call `get_agent_status` and read `snapshot.runtimeInfo.model` and
    `runtimeInfo.thinkingOptionId`; compare against requested values →
    mismatch (or missing runtimeInfo) → `BLOCKED: MODEL_RESOLUTION_MISMATCH`,
    archive the wrongly-resolved agent.
15. Only then deliver/continue the initial task.

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

Every Peer prompt is a V3 brief — read-only ones included: an
authority block between the markers `PASEO_TEAM_TASK_V3_BEGIN` and
`PASEO_TEAM_TASK_V3_END`, with the Prose task body AFTER the end marker
(canonical template: `templates/TASK_BRIEF_V3.md`). The extension enforces
this fail-closed on **every turn**:

- prompt without a valid V3 block → `read-only`;
- legacy `PASEO_TEAM_TASK_V1|V2` header → ALWAYS `read-only`, all
  authority fields ignored (whole-prompt scan injection surface, closed);
- V3 block without the closing marker → invalid → `read-only`, no fields;
- field outside the allowlist, duplicate field, or bad value → invalid;
- `EDIT_AUTHORITY: denied` blocks write/edit even when `MODE: write`;
- write mode never carries over from a previous turn.

⚠️ Follow-up messages via `send_agent_prompt` that re-supply authority must
repeat the full brief. A plain correction message without the markers
silently downgrades the Peer to read-only for that turn (by design).

```text
PASEO_TEAM_TASK_V3_BEGIN

TASK_ID: T-<number>
PROJECT_ID: <project>
DISPOSITION: <see list below>
MODE: write | read-only

ASSIGNED_HOST_ID: <host-id>              # from cluster-routing.local.json
ASSIGNED_PASEO_PROVIDER: <pi-supervisor|pi-lead|pi-peer>
ASSIGNED_MODEL: <pi-provider>/<model-id>   # exact, from list_models
ASSIGNED_THINKING: <off|minimal|low|medium|high|xhigh|max>
WORKSPACE_REF: <worktree-or-workspace>
AGENT_REF:

EXPECTED_BASE_SHA: <sha>                 # writer preconditions
ASSIGNED_CANDIDATE_SHA: <sha>            # reviewer only; exact

OWNED_SCOPE: <files>
EXCLUDED_SCOPE: <files>

EDIT_AUTHORITY: allowed | denied        # default: follows MODE
COMMIT_AUTHORITY: allowed | denied      # default: denied
PUSH_TASK_BRANCH_AUTHORITY: allowed | denied  # default: denied
FORCE_PUSH_AUTHORITY: denied            # always denied for peers
MERGE_AUTHORITY: denied                 # always denied for peers
DEPLOY_AUTHORITY: denied                # always denied

VERIFICATION_PROFILE: <focused-test|independent-review|...>
RETURN_CHANNEL: paseo

PASEO_TEAM_TASK_V3_END

TASK_BODY_BEGIN
OBJECTIVE / SUCCESS_BOUNDARY / KNOWN_EVIDENCE / QUESTIONS TO ANSWER
CONSTRAINTS / REQUIRED HANDOFF
TASK_BODY_END
```

PUSH_TASK_BRANCH_AUTHORITY is BRANCH-SCOPED: the only bash form the
extension permits is exactly
`git push -u origin HEAD:refs/heads/agent/<TASK_ID>` (no other remote,
branch, flag, deletion or chained command; force-push in any spelling —
`-f`, `-uf`, `-fu`, `--force*`, `+refspec` — is always blocked). Task
branches therefore MUST be named `agent/<TASK_ID>`. Branch protection on
the shared remote stays mandatory; the extension is a guard, not the full
security boundary.

The `ASSIGNED_*` fields are evidence for the peer — the model was already
chosen by you at `create_agent` time. The peer echoes them back and, when
its tools let it see a mismatch, escalates `MODEL_MISMATCH`. The peer never
reports invented `OBSERVED_*` values: **you own observed routing evidence**
(via `get_agent_status → snapshot.runtimeInfo`), and a missing/unverifiable
runtime identity is a failure, not a pass.

Do not ask for a candidate SHA unless you granted `COMMIT_AUTHORITY:
allowed`; ask for a stable workspace snapshot (`WORKSPACE_REF` + diff
summary + clean-state evidence) instead, and do NOT route that snapshot to
a cross-host reviewer until an integration owner has created a commit.
Cross-host review requires granting both `COMMIT` and `PUSH_TASK_BRANCH`.

Dispositions: `repository-scout`, `documentation-researcher`,
`solution-architect`, `engineer`, `independent-reviewer`.

A brief must not smuggle in a verdict. Give the Peer the objective,
constraints and evidence — not the answer. Peer has the right to
`REOPEN_REQUEST`, `DEPENDENCY_REQUEST`, or `BLOCKED`.

## Peer output contract

Require from every Peer report:

```text
STATUS:
TASK_ID:
DISPOSITION:

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

The peer ECHOES its `ASSIGNED_*` fields back when useful for traceability,
but reports NO `OBSERVED_*` values: observed runtime identity
(host/provider/model/thinking) belongs to YOU (routing cycle, step 14). A
peer that invents observed values is a protocol violation, the same class
as a claim without file/command/test evidence.

Valid escalations: `REOPEN_REQUEST`, `DEPENDENCY_REQUEST`, `BLOCKED`,
`MODEL_MISMATCH` (runtime identity differs from the `ASSIGNED_*` fields in
the brief — the peer must never change its model itself),
`AUTHORITY_MISMATCH`, `SCOPE_CONFLICT`.

Treat claims without file/command/test evidence as opinions, not evidence.

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

The MCP server injected into THIS agent always talks to the **local daemon**
only — there is no `--host` on any MCP tool (`--host` is a Paseo CLI option,
not an MCP argument). Remote daemons are driven through the Paseo CLI via
`remote-paseo.mjs` from the installed support-script directory (see
`REMOTE_CREATE_CYCLE` below). The notation `<PASEO_TEAM_SCRIPTS_DIR>` below
means a resolved filesystem path, never a literal shell token. Resolve it before
running the first support command, without relying on a profile file:

- POSIX/macOS: `SUPPORT_DIR="${PASEO_TEAM_SCRIPTS_DIR:-${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}/extensions/paseo-team-scripts}"`
- PowerShell: `$supportDir = if ($env:PASEO_TEAM_SCRIPTS_DIR) { $env:PASEO_TEAM_SCRIPTS_DIR } elseif ($env:PI_CODING_AGENT_DIR) { Join-Path $env:PI_CODING_AGENT_DIR 'extensions\paseo-team-scripts' } else { Join-Path $env:USERPROFILE '.pi\agent\extensions\paseo-team-scripts' }`

Use that resolved directory for every `node .../remote-paseo.mjs`,
`model-routing.mjs`, and `ocr-review.mjs` invocation. Installers place the
scripts at this deterministic default. Source checkouts may set the env
variable to the repository `scripts/` directory. Never resolve support scripts
from the project's current working directory.

## Implementation — model routing cycle (mandatory)

For EVERY `create_agent`, run this exact cycle. Do not skip steps.

1. Pick `MODEL_CLASS` from task risk + disposition (classes table below).
2. Pick `HOST_ID` from the controller-local cluster routing file
   `~/.paseo-pi-team/cluster-routing.local.json` (capability filter: writers
   need `git-write`+`focused-test`; reviewers need `git-read`+`independent-review`).
3. Read that host's route from the SAME file (single source of truth for the
   whole cluster — never infer a remote host's route from local memory), or
   run the resolver when the role pack repo is available:
   `node <PASEO_TEAM_SCRIPTS_DIR>/model-routing.mjs resolve --class <CLASS>` for the local
   `model-routing.local.json` (legacy single-host form).
4. Verify the target daemon is reachable before routing:
   - local: `paseo status` (daemon up);
   - remote: the endpoint env var named by `connection.endpointEnv` must be
     SET (never print or invent its value) AND
     `node <PASEO_TEAM_SCRIPTS_DIR>/remote-paseo.mjs health --host-id <id>` must return
     `ok: true` → else `BLOCKED: HOST_ROUTE_UNAVAILABLE` (no silent fallback
     to another host; switching hosts is a recorded routing decision).

### The hard rule — local MCP vs remote CLI

The injected MCP server is LOCAL-ONLY. `--host` is a Paseo CLI option, not an
MCP argument. Therefore the target host decides the mechanism:

```text
IF connection.type == local:
    use MCP operations (through the mcp proxy)

IF connection.type == remote:
    do NOT use MCP operations for that host
    use `node <PASEO_TEAM_SCRIPTS_DIR>/remote-paseo.mjs` (Paseo CLI with
    `--host` under the hood)
```

Resolving a remote host and then calling `list_providers`/`create_agent`/…
via MCP is a routing ERROR: the call lands on the LOCAL daemon, so you get
local inventory and a local agent while believing you are on the remote host.
This is the exact failure mode the cluster config exists to prevent.

### LOCAL_CREATE_CYCLE — target is `connection.type: local` (MCP)

1. Call `list_providers` (mcp) on the local daemon; verify the answer comes
   from the intended daemon.
2. Verify the route's role provider exists, is enabled AND reports a
   healthy status (an enabled provider with a bad status is NOT routable) →
   else `BLOCKED: ROLE_PROVIDER_UNAVAILABLE`.
3. Call `list_models` for that role provider.
4. Verify the exact model ID exists (check BOTH segments are non-empty in
   `<pi-provider>/<model-id>`) → else `BLOCKED: MODEL_UNAVAILABLE`.
5. Verify the configured thinking level is in the model's thinking options →
   else `BLOCKED: THINKING_OPTION_UNAVAILABLE`. If the model exposes NO
   option list, thinking is UNVERIFIABLE — refuse the route
   (strict policy: unverifiable is not a pass).
6. Verify against `~/.pi/agent/models.json` `thinkingLevelMap` on the target
   host: a level mapped to `null` is silently clamped by pi → pick another
   level/model instead of accepting the clamp.
7. Compute the exact create_agent provider string:
   `<role-provider>/<pi-provider>/<model-id>` (Paseo splits at the FIRST
   slash only, so multi-slash model IDs like `openrouter/vendor/name` work).
   Thinking goes in `settings.thinkingOptionId` — never inside the model string.
8. Create the workspace when needed. Worktree isolation is required for
   writers AND is a hard invariant for the independent reviewer: a reviewer
   workspace is ALWAYS a git worktree created from the source repository at
   the exact candidate SHA — never `local` isolation, a standalone clone, or
   a new project. If the worktree cannot be created, report
   `BLOCKED: REVIEW_WORKTREE_UNAVAILABLE`; there is no fallback (the
   reviewer wrapper mechanically rejects non-worktree workspaces with
   `REVIEW_WORKSPACE_NOT_WORKTREE`).
   Local MCP `create_workspace` calls MUST pass an explicit
   `isolation: "local" | "worktree"` (the policy extension rejects a
   missing/invalid value), and a reviewer workspace MUST carry the naming
   convention `title: "review:<TASK_ID>"` (or a `worktreeSlug` containing
   `review`) with `isolation: "worktree"` — the policy extension blocks a
   review-marked workspace that requests local isolation.
9. Call `create_agent` with the exact provider string + thinking. NEVER omit
   the model to inherit a daemon default.
10. Call `get_agent_status` and bounded-poll `snapshot.runtimeInfo.model` and
    `runtimeInfo.thinkingOptionId` until startup identity is populated. Missing
    identity during the bounded startup window is
    `BLOCKED: STARTUP_IDENTITY_UNAVAILABLE`; do **not** archive because this is
    not a confirmed mismatch. If both identity fields appear and either differs
    from the request, classify `BLOCKED: MODEL_RESOLUTION_MISMATCH` and archive
    the wrongly-resolved agent.
11. Only then deliver/continue the initial task.

### REMOTE_CREATE_CYCLE — target is `connection.type: remote` (remote-paseo.mjs)

Every operation goes through `node <PASEO_TEAM_SCRIPTS_DIR>/remote-paseo.mjs` (it drives the
Paseo CLI with `--host` and returns one JSON envelope per call). Never
hand-build `paseo ... --host` shell commands — the wrapper validates
provider/model/thinking, keeps the endpoint value out of every message, and
returns host-tagged JSON so a remote answer can never be confused with a
local one. In the commands below, `<id>` is the HOST_ID from
`cluster-routing.local.json`.

1. Reachability is already proven (step 4 of the shared cycle).
2. List the REMOTE daemon's role providers:
   `node <PASEO_TEAM_SCRIPTS_DIR>/remote-paseo.mjs providers --host-id <id>`
3. Verify the route's role provider exists, is enabled AND healthy **on the
   remote daemon** → else `BLOCKED: ROLE_PROVIDER_UNAVAILABLE`.
4. List the REMOTE model inventory (the inventory is per-daemon — cache per
   hostId, never by provider name):
   `node <PASEO_TEAM_SCRIPTS_DIR>/remote-paseo.mjs models --host-id <id> --provider <role-provider>`
   ⚠️ `list_models` via MCP would return the LOCAL inventory — only the
   wrapper's answer counts for a remote host.
5. Verify the exact model ID + thinking level against the REMOTE list (same
   `BLOCKED: MODEL_UNAVAILABLE` / `THINKING_OPTION_UNAVAILABLE` rules;
   unverifiable is not a pass).
6. Locate or create the workspace ON THE REMOTE host — a Windows workspace
   ID has no meaning on the Mac:
   `node <PASEO_TEAM_SCRIPTS_DIR>/remote-paseo.mjs workspaces --host-id <id>`
   `node <PASEO_TEAM_SCRIPTS_DIR>/remote-paseo.mjs workspace-create --host-id <id> --path <path-on-remote> --isolation local|worktree --title <t>`
   For an independent-reviewer workspace, pass
   `--disposition independent-reviewer`: the wrapper then forces
   `--isolation worktree` and rejects `--isolation local`
   (`REVIEW_ISOLATION_INVALID`). If worktree creation fails on the remote
   host, report `BLOCKED: REVIEW_WORKTREE_UNAVAILABLE` — never fall back to
   a local/standalone workspace for review.
7. Create the agent on the remote daemon (background by default; add
   `--wait-timeout <dur>` to wait for completion):
   `node <PASEO_TEAM_SCRIPTS_DIR>/remote-paseo.mjs run --host-id <id> --provider <role-provider>/<pi-provider>/<model-id> --thinking <level> --workspace <wks> --title <t> --brief <brief-file>`
   The envelope returns `agentRef: <host-id>/<agent-id>` — record it.
8. Verify the OBSERVED runtime identity on the remote daemon. The wrapper's
   `run` command performs a bounded startup poll; use `--startup-timeout <dur>`
   when the host needs a longer (still bounded) initialization window:
   `node <PASEO_TEAM_SCRIPTS_DIR>/remote-paseo.mjs status --agent-ref <host-id>/<agent-id>`
   Missing `data.Model`/`data.Thinking` until the startup deadline is
   `BLOCKED: STARTUP_IDENTITY_UNAVAILABLE`; do not archive. Only after both
   fields appear, compare them with the request: a confirmed mismatch is
   `BLOCKED: MODEL_RESOLUTION_MISMATCH`, then archive the wrongly-resolved agent
   on that host
   (`node <PASEO_TEAM_SCRIPTS_DIR>/remote-paseo.mjs archive --agent-ref <host-id>/<agent-id>`).
9. Follow-ups / corrections:
   `node <PASEO_TEAM_SCRIPTS_DIR>/remote-paseo.mjs send --agent-ref <host-id>/<agent-id> --prompt <text>`
   (or `--prompt-file <file>` for long briefs). send is fire-and-forget by
   default; `status` confirms completion. To interrupt a stuck agent:
   `node <PASEO_TEAM_SCRIPTS_DIR>/remote-paseo.mjs cancel --agent-ref <host-id>/<agent-id>`.
10. Only then deliver/continue the initial task.

Never: omit the model field, silently change models, fall back to another
model or host without recording a routing decision, launch first and "hope",
trust a model name written in a prompt instead of runtime config, or call MCP
for a remote host.

### Runtime family (mixed fleet)

Every role runs on two runtimes. The Paseo role provider names the family:
`pi-<role>` or `claude-<role>`. Both carry the SAME role contract — the same
prompt, the same V3 brief, the same authority gates — so the choice is a
capacity/capability decision, never a policy one:

| Pick | When |
|---|---|
| `pi-*` | the host's routing file points the class at a pi model; work that needs a pi-only model id (`<pi-provider>/<model-id>`) |
| `claude-*` | Claude-only capabilities are needed (`ultracode` thinking, Claude model ids); or the pi provider is unavailable/disabled on that host |

Hard rules for a mixed fleet:

- The model reference SHAPE differs per family and is validated:
  `pi-peer` → `<pi-provider>/<model-id>`; `claude-peer` → a bare id such as
  `claude-opus-5`. A pi-shaped model on a Claude route is a config error, not
  something to normalise.
- Thinking vocabularies differ: `minimal` exists only on pi, `ultracode` only
  on Claude. Take the value from the route, never from habit.
- Keep ONE Lead per project, on ONE family, for the life of that project.
  Peers may be mixed freely; the Lead is the deterministic part.
- `ASSIGNED_PASEO_PROVIDER` in the brief records the family you actually used,
  and `OBSERVED_PROVIDER` must match it. A Peer that reports a different family
  than the brief assigned is an AUTHORITY_MISMATCH, not a detail.
- Claude Peers cannot spawn Claude subagents (the `Task` tool is denied for
  every role). Fan-out is always yours, through Paseo.

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
MECHANISM: mcp | remote-cli        # local → mcp; remote → remote-paseo.mjs
PASEO_PROVIDER:
REQUESTED_MODEL:
REQUESTED_THINKING:
OBSERVED_PROVIDER:
OBSERVED_MODEL:
OBSERVED_THINKING:
WORKSPACE_REF: <host-id>/<workspace-id>
AGENT_REF: <host-id>/<agent-id>
ROUTING_EVIDENCE: <list_models match line + get_agent_status/inspect runtime identity>
```

## Monitoring

Use `team_watchdog` for a bounded observation pass over running agents. It uses bounded concurrency (default 6), a global deadline (default 30 seconds), and partial results when the deadline expires. It retries only transient Paseo transport errors. Only a successful inspect with old `UpdatedAt` returns `stale` as a suspicion; inspect failure is `unknown`, not stale and never an automatic recovery signal.

For every stale result, confirm with `get_agent_status`, `get_agent_activity`, pending permissions, daemon/host health and workspace/Git state. A long-running build/test/cmd is valid when the Peer or brief marked it expected; do not cancel or replace it based on timestamp alone.

Do not repeatedly interrupt a healthy worker.

Use `send_agent_prompt` only for:

- newly discovered constraints;
- correction findings;
- dependency resolution;
- scope clarification;
- answering a `peer_ask_lead` question/blocker/dependency message.

Peer-to-Lead communication is parent-scoped: `peer_ask_lead` resolves the current Peer’s `paseo.parent-agent-id` and sends a structured `PEER_MESSAGE_V1`. It cannot target an arbitrary agent. Treat `blocked` as a coordination event and reply with a full V3 brief when the reply changes authority.

## Review

After implementation:

1. Obtain the exact candidate SHA **and** confirmation the worktree is clean.
   The Engineer's handoff must include `git status --porcelain` output, the
   last format/test run, `CANDIDATE_SHA`, `BRANCH`, `PUSHED_REMOTE`, and
   `WORKTREE_CLEAN: yes`. The required order is: format → test → commit →
   verify `git status --porcelain` empty → push (when granted). A dirty
   candidate is automatically refused by the independent reviewer and must be
   corrected in the same Engineer session before review.
2. Create a fresh read-only Reviewer Peer (`MODE: read-only`,
   `DISPOSITION: independent-reviewer`) in a **fresh git worktree** created
   from the source repository and checked out at the exact candidate SHA —
   not the Engineer's own working tree, and not a standalone clone or new
   project (workspace `--isolation worktree`; remote path:
   `workspace-create ... --disposition independent-reviewer`). If the
   worktree cannot be created, this step is
   `BLOCKED: REVIEW_WORKTREE_UNAVAILABLE` — no fallback. Route the Reviewer
   with `MODEL_CLASS: REVIEW_HIGH` and load `paseo-ocr-reviewer`.
3. Require the Reviewer to run `git rev-parse HEAD`, `git status --porcelain`,
   and `ocr version`, then verify `observed HEAD == ASSIGNED_CANDIDATE_SHA == REVIEW_CANDIDATE_SHA`.
   Missing or differing candidate fields are a hard blocker; OCR must use the
   authority-assigned candidate, never an untrusted task-body candidate.
   Mismatch, dirty workspace, or unavailable OCR is a hard blocker; the
   Reviewer must not checkout/reset/rebase/cherry-pick to repair the workspace.
4. The Reviewer runs the installed deterministic wrapper
   (`node <PASEO_TEAM_SCRIPTS_DIR>/ocr-review.mjs --repo <review-repo> --base <REVIEW_BASE_SHA> --candidate <ASSIGNED_CANDIDATE_SHA>`).
   Any direct OCR diagnostic must use the exact same repo/base/authority-candidate
   values. OCR is the deterministic selection/rule harness, not a Paseo peer,
   provider, writer, or LLM review path.
5. Require every OCR `reviewable_files` item to end as `reviewed` or
   `skipped:<concrete reason>`, with total/reviewed/skipped/coverage evidence.
   Require structured findings and a recommendation of only `PASS`,
   `CHANGES_REQUIRED`, or `BLOCKED`; the Reviewer has no acceptance authority.
6. Lead decides candidate acceptance. If changes are required, return findings
   to the original Engineer (as a full V3 brief so write authority is re-granted).
   The Engineer creates a **new** commit SHA without amend/force-push, and the
   new candidate is reviewed again from a fresh clean workspace.
7. Preserve the existing one-writer, fresh-reviewer-workspace, exact-SHA, Lead
   acceptance, and Human merge/deploy invariants.

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
ASSIGNED_PASEO_PROVIDER: <pi-supervisor|pi-lead|pi-peer|claude-supervisor|claude-lead|claude-peer>
ASSIGNED_MODEL: <pi-provider>/<model-id> | <claude-model-id>   # exact, from list_models
ASSIGNED_THINKING: <off|minimal|low|medium|high|xhigh|max>     # claude: off|low|medium|high|xhigh|max|ultracode
WORKSPACE_REF: <worktree-or-workspace>
AGENT_REF:

EXPECTED_BASE_SHA: <sha>                 # writer preconditions
ASSIGNED_CANDIDATE_SHA: <sha>            # reviewer only; exact

OWNED_SCOPE: <files>
EXCLUDED_SCOPE: <files>

EDIT_AUTHORITY: allowed | denied        # default: follows MODE
BROWSER_MCP_AUTHORITY: allowed | denied # default: denied; agent-browser only
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

`BROWSER_MCP_AUTHORITY: allowed` is a narrow, current-turn grant: it permits
only MCP targets prefixed by `agent_browser_`/`agent-browser_` (and compatible
adapter prefixes) plus an explicitly scoped `connect`/`search server=agent-browser`.
It never grants Paseo orchestration or unrelated MCP servers. Repeat the full V3
brief on every follow-up that needs browser access; otherwise the extension
revokes it fail-closed. The Peer may never invoke the `agent-browser` CLI through
bash; this field only permits the typed MCP surface.

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

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

## Implementation

1. Use `mcp` to call `list_providers`.
2. Use `mcp` to call `list_models`.
3. Select an explicit provider, model and thinking level.
4. Create a worktree-isolated workspace (`create_workspace` with
   `isolation: "worktree"`).
5. Create one Engineer Peer in that workspace (`create_agent`).
6. Send a complete `PASEO_TEAM_TASK_V1` brief (template below).

Never guess model or workspace IDs — inspect them first.

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

Require from every Peer report:

- `STATUS`, `SUMMARY`, `FILES_READ`, `FILES_CHANGED`, `COMMANDS_RUN`;
- `VERIFICATION` with real command output;
- `RISKS`, `OPEN_QUESTIONS`, `HANDOFF`.

Treat claims without file/command/test evidence as opinions, not evidence.

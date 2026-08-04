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

## Implementation

1. Call `list_providers`.
2. Call `list_models`.
3. Select an explicit provider, model and thinking level.
4. Create a worktree-isolated workspace (`create_workspace` with
   `isolation: "worktree"`).
5. Create one Engineer Peer in that workspace (`create_agent`).
6. Send a complete `PASEO_TEAM_TASK_V1` brief (template below).

Never guess model or workspace IDs — inspect them first.

## Monitoring

Use `get_agent_status` and `get_agent_activity`.

Do not repeatedly interrupt a healthy worker.

Use `send_agent_prompt` only for:

- newly discovered constraints;
- correction findings;
- dependency resolution;
- scope clarification.

## Review

After implementation:

1. Obtain the exact candidate SHA.
2. Create a fresh read-only Reviewer Peer (`MODE: read-only`,
   `DISPOSITION: independent-reviewer`).
3. Require assigned and observed SHA in its report.
4. Do not accept review of a different SHA.
5. Return findings to the original Engineer.

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

Every Peer prompt must start with the `PASEO_TEAM_TASK_V1` header. `MODE` is
mandatory in practice; when missing the Peer extension defaults to
`read-only` (fail-closed).

```text
PASEO_TEAM_TASK_V1

TASK_ID: T-<number>
DISPOSITION: <see list below>
MODE: write | read-only

OBJECTIVE:
SCOPE:
OWNED_SCOPE:
EXCLUDED_SCOPE:
KNOWN_EVIDENCE:
OPEN_QUESTIONS:
VERIFICATION:
HANDOFF:
```

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

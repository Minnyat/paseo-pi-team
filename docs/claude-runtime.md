# Claude Code as a team runtime

The pack runs three roles — Supervisor, Lead, Peer. This document is about the
second runtime those roles execute on. Pi loads a policy extension; Claude Code
has no extension API, so the same rules are bound through user-level hooks and
one small MCP server. Nothing about the roles changes: same prompts, same V3
task brief, same authority gates, same Paseo control plane.

## Why it is possible at all

Paseo treats `claude` as a first-class provider and lets a derived provider
carry `env` and `disallowedTools`:

```jsonc
"claude-peer": {
  "extends": "claude",              // BUILTIN_PROVIDER_IDS includes "claude"
  "label": "Claude Peer",
  "env": { "PASEO_PI_ROLE": "peer" },
  "disallowedTools": ["Task", "Agent", "WebFetch", "WebSearch"]
}
```

The daemon runs that provider through the Claude Agent SDK with
`settingSources: ["user", "project", "local"]`, so hooks configured in
`~/.claude/settings.json` are loaded, and with a `canUseTool` callback, so
Paseo's own permission flow (`list_pending_permissions` /
`respond_to_permission`) keeps working unchanged. It also injects its MCP
server under the name `paseo`, which is why Paseo tools appear to a Claude
agent as `mcp__paseo__<tool>`.

## Three layers, one rule set

```text
              extensions/paseo-team-core/policy-core.ts
              (briefs, authority, allowlists, git guard)
                        ▲                  ▲
        ┌───────────────┘                  └───────────────┐
extensions/paseo-team-policy.ts        extensions/paseo-team-core/claude-policy.ts
   pi extension API                             Claude tool dialect
   setActiveTools + tool_call                          ▲
                                            scripts/claude-hook.mjs
                                     SessionStart / UserPromptSubmit / PreToolUse
```

`policy-core.ts` imports nothing from any runtime. A rule that lives in only
one adapter is a rule the other runtime silently lacks, so both adapters route
every decision through the core — `test/ocr-integrity.test.mjs` asserts that
both import it.

The subdirectory is deliberate: pi discovers `~/.pi/agent/extensions/*.ts` as
extensions, and enters a subdirectory only when it carries an index or a `pi`
package.json. `paseo-team-core/` has neither, so the core stays invisible to
that scan while remaining plain `.ts` — which matters because the repo's own
OCR review harness only selects TypeScript sources, and files it cannot select
are files nobody reviews.

## Vocabulary translation

| | pi | Claude Code |
|---|---|---|
| read | `read` | `Read`, `Glob`, `Grep`, `NotebookRead` |
| write | `write` | `Write` |
| edit | `edit` | `Edit`, `MultiEdit`, `NotebookEdit` |
| shell | `bash` | `Bash`, `BashOutput`, `KillShell` |
| Paseo tools | `mcp({ tool, args })` proxy | `mcp__paseo__<tool>`, args are the tool input |
| team tools | registered by the extension | `mcp__paseo-team__*` (stdio MCP server) |
| deny mechanism | `setActiveTools` + `tool_call` block | provider `disallowedTools` + `PreToolUse` deny |

Two layers on the Claude side, mirroring pi's allowlist + backstop:

1. **Static** — `claudeDisallowedTools(role)` goes into the provider override,
   so the model never sees a tool the role can never use under any brief.
2. **Dynamic** — the `PreToolUse` hook decides per call, because peer write,
   browser and git authority are properties of the CURRENT brief.

## The per-turn brief across processes

The Pi extension keeps the parsed brief in memory and recomputes it on every
`before_agent_start`. Claude runs each hook in its own process, so the brief
travels through a file:

```text
UserPromptSubmit  parse the prompt → ~/.paseo-pi-team/claude-sessions/<id>.json
PreToolUse        read that file → decide → allow / deny
```

Fail-closed on every axis, exactly like an unbriefed pi peer:

- no state file, stale (>12h) or corrupt → read-only;
- state says nothing → fall back to the session transcript's last human
  message (tool results are skipped — they are user-role messages too);
- the hook itself throws → **deny**, with the reason naming the failure.

Authority is never inherited: a turn whose prompt carries no V3 brief drops
write mode even if the previous turn had it.

## What Claude roles may do

| | Supervisor | Lead | Peer |
|---|---|---|---|
| Read/Glob/Grep | yes | yes | yes |
| Bash | no | yes | yes, guarded |
| Write/Edit | no | only with `PASEO_TEAM_LEAD_WRITE=1` | only with `MODE: write` + `EDIT_AUTHORITY: allowed` |
| `mcp__paseo__*` | monitoring + gated lead-recovery `create_agent` | full Lead allowlist + permissions | none |
| `mcp__agent-browser__*` | no | yes | only with `BROWSER_MCP_AUTHORITY: allowed` |
| `Task` (Claude subagents) | no | no | no |

`Task` is denied for every role on purpose: a Claude subagent runs outside
Paseo, so it carries no role prompt, no brief authority, and never appears in
the team graph. Fan-out belongs to the Lead, through Paseo.

The Peer bash guard is unchanged from pi: no Paseo CLI, no agent-browser CLI,
no commit/push without the matching authority, force-push and merge never, and
a granted push is branch-scoped to exactly
`git push -u origin HEAD:refs/heads/agent/<TASK_ID>`.

## Install

`scripts/install.{sh,ps1}` does this automatically when the `claude` CLI is
present. Manually:

```bash
node scripts/claude-setup.mjs --install          # hooks + paseo-team MCP server
node scripts/claude-setup.mjs --print-providers  # the claude-* provider block
node scripts/claude-setup.mjs --verify           # exit 1 when incomplete
pteam claude-setup --verify --json               # same thing through the CLI
```

Then merge the printed provider block into `~/.paseo/config.json` and restart
the daemon (`paseo daemon restart` — this kills running agents, so pick the
moment). Providers only appear in `paseo provider ls` after that restart.

Both target files belong to the user and already carry other tools' entries
(Paseo installs its own hooks in the same settings file), so every write
merges: our entries are tagged `paseo-team-role-policy`, and only tagged
entries are replaced or removed. A file that cannot be parsed is reported and
left byte-for-byte alone.

## Mixed-fleet routing

`paseoProvider` in a route names the family and the role. Both families can
serve the same host; only the reference shapes differ:

| | pi | Claude |
|---|---|---|
| provider | `pi-peer` | `claude-peer` |
| model | `<pi-provider>/<model-id>` (may contain more slashes) | bare id, e.g. `claude-opus-5` |
| thinking | `off\|minimal\|low\|medium\|high\|xhigh\|max` | `off\|low\|medium\|high\|xhigh\|max\|ultracode` |

`scripts/model-routing.mjs` validates the shape per family: a pi-shaped model
on a Claude route is a config error, not something to normalise. The graph
carries the family on every node (`family: "pi" \| "claude"`), so a mixed fleet
stays legible in `pteam graph` and the WebUI.

Rule of thumb: mix Peers freely, keep ONE Lead per project on ONE family for
the life of that project — the Lead is the deterministic part of the loop.

### Crossing families needs an explicit mode

Permission modes belong to the provider and are not inherited from the caller,
so creating a Claude agent from a pi Lead (or the reverse) fails without one:

```text
cannot inherit mode '<none>' from caller (provider 'pi-lead') for new agent
(provider 'claude-peer'). Pass an explicit mode. Available modes for
'claude-peer': plan, default, acceptEdits, auto, bypassPermissions
```

`mode: "default"` is the right answer for a Peer: every tool call raises a Paseo
permission the Lead triages, which is the loop the pack is built around. Use
`acceptEdits` only for a write Peer whose brief already grants `EDIT_AUTHORITY`.
Never `bypassPermissions` — the role policy still applies, but the human loses
the permission gate.

## Verifying

```bash
node scripts/preflight.mjs --runtime claude    # or pi | both (default: detect)
```

Claude-specific checks: the `claude` CLI, the shared policy modules next to the
extension, the three hooks plus the MCP server registration, and the
`claude-*` role providers in the daemon.

## Uninstall

`pteam uninstall` removes the pi extension, the shared policy modules, the
prompts, the skills, the support scripts, and — through
`scripts/claude-setup.mjs --uninstall` — the tagged hooks and the `paseo-team`
MCP entry. Removal never creates a file it was asked to clean, and other
tools' entries always survive.

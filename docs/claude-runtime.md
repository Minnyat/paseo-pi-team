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

A **seat** is that same shape with a name and a curated grant on top —
`claude-peer-researcher`, still `PASEO_PI_ROLE=peer`, plus
`PASEO_TEAM_EXTRA_TOOLS=WebFetch,WebSearch` and those two names removed from
`disallowedTools`. `pteam seats apply` generates it; the deny list is recomputed
by `claudeDisallowedTools(role)` **under the seat's own environment**, so the
static and dynamic layers can never disagree about a grant. See README, *Custom
seats*.

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

### The role contract across turns

The two runtimes do not inject the role prompt the same way, and the difference
is not cosmetic:

| | pi | Claude Code |
|---|---|---|
| where | the turn's **system prompt** | `additionalContext` — content of the **user turn** |
| when | rebuilt on **every** `before_agent_start` | **once** per session (`SessionStart`, or the first prompt when that hook never ran) |

A Lead fifty turns into a Claude session therefore had its authority contract
far behind it, outweighed by the model's own default posture of checking with
the human before anything consequential — which is exactly what a delegated
supervisor decision is not supposed to need. Re-sending the whole prompt every
turn would cost ~2.5k tokens a turn to say something that only sometimes
matters, so the hook splits it:

- **every** Lead turn carries a short standing-authority block (routing,
  delegation, correction and acceptance are the Lead's calls; only irreversible
  steps go to the Human);
- a turn that **opens with a supervisor message** re-injects the full role
  prompt, because that is the turn where the contract decides the answer.

### A supervisor message, on either runtime

`send_agent_prompt` has no channel of its own: a Supervisor's block arrives as
an ordinary user prompt, indistinguishable from the Human typing. So both
adapters run it through `policy-core.ts` and put one shared notice in the turn:

1. `parseSupervisorBlock` — is this actually a block, and is it a decision?
2. `supervisorAttribution` — does `FROM_AGENT_ID` resolve, in Paseo's own agent
   state, to a seat whose provider is a Supervisor role provider? Unresolvable
   or not-a-Supervisor ⇒ `SUPERVISOR_SENDER_UNVERIFIED`, and the message never
   binds. This is what stops the directive below from becoming a lever anything
   can pull by typing the header. It is not authentication — provider and
   parentage are declared labels — it catches mistakes, drift and stray text.
3. `supervisorTurnVerdict` — jurisdiction under `multi` (unchanged), then the
   sender check on both topologies.
4. `supervisorTurnNotice` — the verdict **and what to do about it**: `ACT ON IT
   … needs NO Human round-trip` on the binding path, `Do NOT act on it, reply
   BLOCKED: <code>` on the refusing one.

The notice is context, not a deny: nothing here blocks a tool.

## What Claude roles may do

| | Supervisor | Lead | Peer |
|---|---|---|---|
| Read/Glob/Grep | yes | yes | yes |
| Bash | no | yes | yes, guarded |
| Write/Edit | no | only with `PASEO_TEAM_LEAD_WRITE=1` | only with `MODE: write` + `EDIT_AUTHORITY: allowed` |
| `mcp__paseo__*` (orchestration) | monitoring + `create_heartbeat`/`delete_heartbeat` + gated lead-recovery `create_agent` | full Lead allowlist + permissions | none |
| `mcp__paseo-team__*` | `team_watchdog`, `team_fork`, `team_lease` (`status` only) — it RECEIVES `lead_ask_supervisor` consults, never sends one | those three with `team_lease` unrestricted, plus `lead_ask_supervisor` | `peer_ask_lead` only |
| `mcp__paseo__browser_*` (Browser Control) and `mcp__claude-in-chrome__*` | no | yes | yes, unless the brief says `BROWSER_MCP_AUTHORITY: denied` |
| `Task` (Claude subagents) | no | no | no |
| `AskUserQuestion` | yes | no | no |

`Task` is denied for every role on purpose: a Claude subagent runs outside
Paseo, so it carries no role prompt, no brief authority, and never appears in
the team graph. Fan-out belongs to the Lead, through Paseo.

`AskUserQuestion` is denied for the Lead and the Peer for the mirror-image
reason: the escalation chain is Peer → Lead → Supervisor → Human, and a
structured ask-the-user tool is the door that skips two links of it. pi never
exposed one to any role, so leaving it open on Claude was also a cross-runtime
authority asymmetry — a rule denied on one runtime denied on the other is the
whole point of the shared core. It removes the interrupt, not the voice: a
Lead's own turn output still reaches the Human it is talking to, which is where
the irreversible actions `lead.md` reserves for them belong.

Browser Control (`browser_*`) is registered by Paseo on the SAME MCP server as
`create_agent`. It is classified by tool family rather than by server, or the
Peer's orchestration wall takes the browser down with it — which is exactly
what it used to do.

The Peer bash guard is unchanged from pi: no Paseo CLI,
no commit/push without the matching authority, force-push and merge never, and
a granted push is branch-scoped to exactly
`git push -u origin HEAD:refs/heads/agent/<TASK_ID>`.

## Install

`scripts/install.{sh,ps1}` does this automatically when the `claude` CLI is
present. Manually:

```bash
node scripts/claude-setup.mjs --install          # hooks + the paseo-team MCP server
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

`~/.claude.json` gets exactly one server: `paseo-team`, which is ours and is
rewritten on every install.

It used to get a second, `agent-browser`, so that the browser rows in the table
above pointed at something the runtime had actually registered. That server is
gone — the browser a Claude seat uses is now one it already has (Claude in
Chrome, and Paseo Browser Control on the server the daemon injects), so there
is nothing left for this installer to register. What it does instead is
REMOVE an `agent-browser` entry a previous version of itself wrote, and leave
alone one the user configured, which is the same ownership rule the merge
always followed — dropping our integration is not a licence to delete theirs.

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

### Every Claude agent needs an explicit mode

A permission mode belongs to the provider and is never inherited across
providers. The check fires when the TARGET provider declares modes and its id
differs from the caller's — and the value being legal for the target does not
save it:

```text
cannot inherit mode 'auto' from caller (provider 'claude-lead') for new agent
(provider 'claude-peer'). Pass an explicit mode. Available modes for
'claude-peer': plan, default, acceptEdits, auto, bypassPermissions
```

`auto` is in that list and was still refused. This is not a cross-family rule:
`claude-lead` → `claude-peer` is one family and is rejected exactly the same.
What separates the two runtimes is that they declare different mode sets:

```text
pi-lead      Mode=default  AvailableModes=[]
claude-lead  Mode=auto     AvailableModes=[plan, default, acceptEdits, auto, bypassPermissions]
```

pi declares none, so nothing is required and `pi-lead` → `pi-peer` has always
worked. Claude declares five, and in this pack a Lead and a Peer are never the
same profile — so **every `claude-*` creation needs the mode passed in, from
either family.**

The parameter is `settings.modeId`, NOT a top-level `mode`. Paseo's own contract
is `create_agent { title, provider, initialPrompt, workspaceId?, settings?,
labels? }` with "initial runtime settings live under `settings`: `modeId`,
`thinkingOptionId`, features". A top-level `mode` is ignored and the create
fails with the message above:

```jsonc
create_agent({
  provider: "claude-peer/claude-opus-5",
  settings: { modeId: "default", thinkingOptionId: "high" },
  // ...
})
```

The Paseo CLI spells the same thing `--mode` (`paseo run --mode default`), and
so does `remote-paseo.mjs run`, which refuses a `claude-*` route without one.

`modeId: "auto"` is the right answer for a Peer, and it is what
`remote-paseo.mjs run` fills in when `--mode` is omitted
(`CLAUDE_DEFAULT_MODE`).

This used to say `"default"`, on the theory that every Peer tool call raising a
Paseo permission for the Lead to triage was the loop the pack is built around.
It is not: what bounds a Peer is the role policy plus its V3 brief, and both
are enforced in the `PreToolUse` hook, before Paseo's permission queue ever
sees the call. The queue only decides how often somebody is interrupted while
the Peer does already-bounded work — and on `"default"` the answer is "every
call", so the Peer sits in the queue looking hung while the Lead spends its
turn clicking instead of leading. The same trap the Lead's own seat hit (next
section), one level down.

Narrow it deliberately when you want that: `"plan"` for a seat that should
propose before acting, `"default"` for one you genuinely intend to watch call
by call. `"acceptEdits"` is the middle setting for a write Peer whose brief
already grants `EDIT_AUTHORITY`. Never `bypassPermissions` — the role policy
still applies, but Paseo's own guardrails outside it are gone too.

### …including the Lead's own seat

The rule above is about agents the Lead creates. The Lead's own seat is started
by the Human, and its mode is a separate decision the pack used to leave
unsaid — with real consequences, because **nobody triages the Lead's
permissions but the Human**:

```bash
paseo run --provider "claude-lead/<model>" --thinking high --mode auto "..."
```

`--mode auto` is the working default for a Lead. On `default`, every one of the
Lead's own tool calls parks in the pending-permission queue until the Human
clicks — so a Lead that correctly accepts a supervisor decision still cannot
carry it out, which looks from the outside exactly like a Lead that refused it.
A pi Lead never showed this: `pi-lead` declares no modes at all
(`Mode=default AvailableModes=[]`) and its tool calls simply run. If a Claude
Lead seems to be waiting on you for everything, check its mode before you
suspect the policy.

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

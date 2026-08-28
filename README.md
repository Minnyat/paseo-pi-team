# paseo-pi-team

[![ci](https://github.com/Minnyat/paseo-pi-team/actions/workflows/ci.yml/badge.svg)](https://github.com/Minnyat/paseo-pi-team/actions/workflows/ci.yml)
[![license: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

A role pack that runs directly on **Paseo**, with the same three roles served
by two coding agents — **Pi** and **Claude Code** — in one mixed fleet. Three
components, three separate responsibilities: Paseo owns
lifecycle/workspace/control-plane truth; the role pack owns role invariants
(prompt + tool policy); the Lead skill owns the orchestration procedure.

The role invariants live in one runtime-neutral core
(`extensions/paseo-team-core/`) with a thin adapter per runtime: a Pi
extension, and Claude Code hooks. A rule denied on one runtime is denied on the other.

Full design reference:
[`docs/demonthorn-agent-orchestration-deep-dive.md`](docs/demonthorn-agent-orchestration-deep-dive.md).
Claude runtime: [`docs/claude-runtime.md`](docs/claude-runtime.md).

## Quick start

Zero runtime dependencies, Node >= 22.18. The repository is private, so the
machine needs GitHub git credentials for the fetch (an SSH key, or
`gh auth login` if git uses the `gh` credential helper).

```bash
# run it once straight from GitHub — nothing to clone, nothing installed
npx --package github:Minnyat/paseo-pi-team pteam status

# or install it globally — puts both `pteam` and `paseo-team` on your PATH
npm install -g github:Minnyat/paseo-pi-team
pteam web --open                         # opens http://127.0.0.1:PORT/#token=...
```

From a checkout instead:

```bash
node cli/paseo-team.mjs --help           # or `npm link` once, then `pteam`
npm test
```

Full CLI/WebUI reference: [CLI and WebUI](#cli-and-webui) below.

## Structure

```text
paseo-pi-team/
├── README.md
├── LICENSE                             # MIT
├── package.json / package-lock.json    # dev dependency pins + npm test/typecheck
├── tsconfig.ci.json                    # in-repo typecheck config (tsconfig.json is dev-only, gitignored)
├── .gitattributes                      # LF everywhere; CI compares the same bytes on all three OSes
├── .github/workflows/ci.yml            # tests on 3 OSes × node 22.18/24 + tsc
├── config/
│   ├── paseo.providers.example.json   # 6 role providers: pi-* and claude-* (supervisor/lead/peer)
│   ├── model-routing.example.json     # MODEL_CLASS → model route template (copy per host)
│   └── cluster-routing.example.json   # controller-local N-host contract template
├── templates/
│   ├── TASK_BRIEF_V3.md               # canonical V3 task brief + parser rules
│   └── WORKSPACE_PROTOCOL.example.md  # .orchestration/WORKSPACE_PROTOCOL.md for the target repo
├── prompts/
│   ├── supervisor.md               # Governance Supervisor
│   ├── lead.md                     # Project Lead (orchestration owner)
│   └── peer.md                     # execution Peer (bounded worker)
├── extensions/
│   ├── paseo-team-policy.ts        # Pi adapter: prompt injection + per-role tool policy
│   └── paseo-team-core/            # shared, runtime-neutral (invisible to pi's extension scan)
│       ├── policy-core.ts          # briefs, authority, allowlists, bash + git guards
│       └── claude-policy.ts        # Claude adapter: tool dialect + per-turn decisions
├── skills/
│   ├── paseo-team-lead/
│   │   └── SKILL.md                # Lead orchestration workflow + routing cycle
│   └── paseo-ocr-reviewer/
│       └── SKILL.md                # Reviewer read-only OCR delegation workflow
├── examples/
│   ├── engineer-task.md            # PASEO_TEAM_TASK_V3 brief (engineer, write)
│   ├── reviewer-task.md            # independent reviewer brief (read-only)
│   ├── architect-task.md           # solution-architect brief (read-only)
│   ├── scout-task.md               # repository-scout brief (read-only)
│   └── supervisor-observation.md   # observation template
├── cli/
│   ├── paseo-team.mjs              # the CLI: every config read/write and every daemon query
│   └── lib/
│       ├── config-walker.mjs       # path resolution + atomic write with backup
│       ├── paseo-bridge.mjs        # the only place that spawns `paseo` (argv, timeouts, fan-out)
│       ├── graph-cache.mjs         # spawn-tree cache; `paseo ls` has no parent link, `inspect` does
│       └── graph.mjs               # agents + parents + permits -> nodes/edges/degraded
├── webui/
│   ├── server.mjs                  # transport only: route -> paseo-team argv, token, localhost
│   └── public/                     # zero-dependency SPA (index.html / app.js / style.css)
├── scripts/
│   ├── install.ps1 / install.sh    # installers
│   ├── lib-common.mjs              # shared helpers: exec/shim resolution, entrypoint, versions
│   ├── model-routing.mjs           # stateless resolver: single-host + cluster (+ validate/resolve CLI)
│   ├── remote-paseo.mjs            # remote-host executor: Paseo CLI --host by HOST_ID (Lead REMOTE cycle)
│   ├── reliability.mjs             # retry classification/backoff + stale predicates
│   ├── team-communication.mjs      # parent-scoped Peer → Lead messaging
│   ├── watchdog.mjs                # observation-only running-agent watchdog
│   ├── ocr-review.mjs              # deterministic OCR exact-SHA preflight manifest
│   ├── ocr-setup.mjs               # installs/verifies the OCR CLI (capability probe, never downgrades)
│   ├── browser-setup.mjs           # installs agent-browser CLI + Chrome runtime + MCP entry
│   ├── claude-hook.mjs             # Claude Code hook: role prompt + PreToolUse policy
│   ├── claude-team-mcp.mjs         # stdio MCP server: peer_ask_lead + team_watchdog for Claude
│   ├── claude-setup.mjs            # installs/verifies/removes the Claude side (hooks + MCP)
│   ├── team-scripts-path.mjs       # durable support-script path resolver
│   └── preflight.mjs               # host readiness check (--json, --strict, --host-id)
├── test/                           # `npm test` runs every test/*.test.{mjs,mts}
│   ├── policy.test.mts             # policy + lifecycle regression
│   ├── model-routing.test.mjs      # resolver regression
│   ├── remote-paseo.test.mjs       # remote executor regression (+ fixtures/fake-paseo.mjs)
│   ├── lib-common.test.mjs         # shared helpers (quoted paths, PATH order, shim fallback)
│   ├── reliability.test.mjs        # retry/backoff/stale predicates
│   ├── team-communication.test.mjs # parent-scoped Peer → Lead contract
│   ├── watchdog.test.mjs           # stale-agent classification
│   ├── ocr-review.test.mjs         # OCR delegation preflight contract
│   ├── ocr-setup.test.mjs          # capability probe + version comparison
│   ├── ocr-integrity.test.mjs      # skill/reference/authority integrity
│   ├── browser-setup.test.mjs      # MCP config merge + skill install
│   ├── installer-contract.test.mjs # shipped files must exist and carry their dependencies
│   ├── paseo-contract.test.mjs     # Paseo JSON field contract (needs a live daemon — see below)
│   ├── paseo-bridge.test.mjs       # argv validation, error codes, bounded concurrency
│   ├── graph.test.mjs              # role inference, PEER_MESSAGE_V1 parse, graph assembly, cache
│   ├── cli-contract.test.mjs       # the CLI end to end against a fake paseo + throwaway HOME
│   ├── webui-server.test.mjs       # route allowlist, token, host check, cache, CLI failures
│   └── fixtures/                   # fake CLIs (paseo, ocr) + version-pinned OCR output
└── docs/
    ├── demonthorn-agent-orchestration-deep-dive.md   # original design
    ├── model-routing.md            # the 4 model-routing layers, verified commands
    ├── multi-host.md               # N-host routing + cross-host test plan
    ├── ocr-integration.md          # OpenCodeReview Phase 1 single-machine setup
    └── webui-architecture.md       # CLI <-> WebUI contract, graph schema, measured costs
```

## Roles

| Profile | `PASEO_PI_ROLE` | Default tools |
|---|---|---|
| `pi-supervisor` | `supervisor` | `read`, monitoring `mcp`, `team_watchdog` |
| `pi-lead` | `lead` | `read`, `bash`, Paseo orchestration set, `team_watchdog` |
| `pi-peer` | `peer` | `read`, `bash`, `peer_ask_lead` (+ `write`/`edit` under `MODE: write`) |

Refine the real allowlist after running `/team-tools` — actual Paseo tool names
can differ from the defaults.

Per-role exceptions:

- **Supervisor** is observation-only. No `write`/`edit` ever. `create_agent` is
  available for Lead recovery alone, behind an argument guard.
- **Lead** gets `write`/`edit` only when `PASEO_TEAM_LEAD_WRITE=1`.
- **Peer** gets no Paseo MCP or orchestration tools at all. Browser MCP is
  granted only by the current V3 brief.

### How authority is decided

The policy is a **pure allowlist** (`setActiveTools`) plus a backstop that
blocks inside `tool_call`. It is not an absolute security sandbox.

Every authority is recomputed from the brief of the **current turn**:

- Only a V3 marker block (`PASEO_TEAM_TASK_V3_BEGIN` …
  `PASEO_TEAM_TASK_V3_END`) can grant write mode or git authority.
- **The legacy `PASEO_TEAM_TASK_V1|V2` header always resolves to read-only.**
  Every `MODE` and `*_AUTHORITY` field in it is ignored — the legacy parser
  scanned the whole prompt, which made it an injection hole.
- A Peer's `git commit`/`git push` through bash is blocked unless the V3 brief
  grants `*_AUTHORITY: allowed`.
- Push authority is **branch-scoped**: exactly
  `git push -u origin HEAD:refs/heads/agent/<TASK_ID>`, nothing else.
- Force-push is blocked in every spelling (`-f`, `-uf`, `-fu`, `--force*`,
  refspec `+`), and so are Peer merges.
- `BROWSER_MCP_AUTHORITY` is a current-turn grant scoped to the
  `agent-browser` server: only agent-browser-prefixed targets plus
  `connect`/`search`. The agent-browser CLI through bash is always blocked.
- Paseo MCP and every other MCP server stay blocked for Peers.

## Communication and watchdog

### A Peer asks the Lead

Peers use the custom `peer_ask_lead` tool, never `paseo send` through bash. The
tool reads `PASEO_AGENT_ID`, inspects `paseo.parent-agent-id`, sends only to the
parent Lead, and wraps the payload as `PEER_MESSAGE_V1` carrying `kind`,
`TASK_ID` and `CORRELATION_ID`.

Message kinds: `question`, `blocked`, `dependency`, `progress`.

Failing to resolve the parent is fail-closed — there is no broadcast fallback.

### Lead/Supervisor check for hung agents

`team_watchdog` inspects `running` agents via `paseo ls -g` + `paseo inspect`:

| Bound | Default |
|---|---|
| Concurrency | 6 |
| Global deadline | 30s (partial results returned on timeout) |
| Transport retries | 3 |
| Stale threshold | 5 minutes since `UpdatedAt` |

Only a **successful** inspect past the threshold is marked `stale`/suspected. A
**failed** inspect is `unknown` — and nothing is ever auto-cancelled,
auto-archived or auto-spawned on either verdict.

Before acting on a stale agent, the Lead must check activity, pending
permissions, daemon/remote health, expected long-running commands, and
workspace/Git state. Only then does cancel/archive/correction get decided, and
never a replacement writer while the previous commit or state is still unclear.

### Retry policy

Retries exist to survive flaky transport, not to paper over ambiguity, so the
split is by whether a repeat can duplicate work:

| Operation | Retried |
|---|---|
| `peer_ask_lead` inspect step | up to 3×, transient transport errors only |
| `remote-paseo.mjs` read/health/provider/status | up to 3× |
| `send`, `run` | **never** — delivery ambiguity would duplicate the message or task |
| usage / authority / model / workspace / endpoint / malformed request | **never** — fails immediately |

Model-API transient errors (overloaded, rate limit, 5xx, timeout) are retried
by Pi itself per its `settings.retry` policy (defaults: 3 attempts, 2s base
delay). The WebUI's **Pi — cấu hình chính** editor tunes that policy without
reading Pi's docs — including a one-click preset for unstable providers — via
`pteam config read/write pi-settings` (`~/.pi/agent/settings.json`). Changes
take effect for agent sessions started after the save.

## OpenCodeReview delegation (Phase 1)

`paseo-ocr-reviewer` is a strictly read-only Reviewer Peer skill.

OCR is not an agent, a provider, or a second control plane. It deterministically
selects files and resolves rules; the Pi Reviewer does the reasoning, on the
exact candidate SHA.

**Version handling is capability-based, not equality-based.** `scripts/ocr-setup.mjs`
accepts any installed `@alibaba-group/open-code-review` at or above the verified
`1.8.10` baseline that passes the delegation capability probe, and never
downgrades it. Only when OCR is absent or incompatible does it install the
pinned `1.9.2`.

Check the CLI manually with `ocr version` (`Get-Command ocr` on PowerShell,
`command -v ocr` on Unix-like shells), and use delegation mode — not
`ocr review`. See [`docs/ocr-integration.md`](docs/ocr-integration.md).

The optional deterministic preflight emits a normalized manifest:

```bash
node scripts/ocr-review.mjs --repo <repo> --base <base-sha> --candidate <candidate-sha>
```

It probes `delegate preview/rule` capabilities, records the OCR version as
provenance, and prefers `--format json` when the installed release supports it.

It refuses to produce a manifest on any of:

- candidate SHA mismatch
- a review workspace that is not a linked git worktree
  (`REVIEW_WORKSPACE_NOT_WORKTREE` — never a primary checkout or a standalone
  clone)
- a dirty or mutated workspace
- unavailable or incompatible OCR
- malformed selection or rules
- incomplete rule coverage

The manifest records candidate-tree and workspace entry/exit state plus
deterministic digests. It never edits Git state and never calls an LLM.

## Installation

```bash
# Windows (PowerShell)
./scripts/install.ps1

# macOS / Linux
./scripts/install.sh
```

What the installers copy:

| Source | Destination |
|---|---|
| `extensions/paseo-team-policy.ts` | `~/.pi/agent/extensions/` |
| `extensions/paseo-team-core/` | `~/.pi/agent/extensions/paseo-team-core/` |
| `prompts/*.md` | `~/.pi/agent/extensions/prompts/` |
| `skills/paseo-team-lead/` | `~/.pi/agent/skills/paseo-team-lead/` |
| `skills/paseo-ocr-reviewer/` | `~/.pi/agent/skills/paseo-ocr-reviewer/` |
| support scripts (see below) | `~/.pi/agent/extensions/paseo-team-scripts/` |
| bundled `agent-browser` skill | `~/.pi/agent/skills/agent-browser/` |

It also installs the `agent-browser` CLI and Chrome runtime when missing, and
merges an MCP entry — `agent-browser: { command: "agent-browser", args: ["mcp"] }`
— into `~/.pi/agent/mcp.json` when it is absent from the standard config
locations.

When the `claude` CLI is present, the installers also run
`scripts/claude-setup.mjs --install`, which merges this pack's hooks into
`~/.claude/settings.json` and the `paseo-team` MCP server into `~/.claude.json`
— see [Mixed fleet](#mixed-fleet-pi--claude-code). A host without `claude`
skips that step; it is not an error.

The support scripts are `lib-common`, `reliability`, `watchdog`,
`team-communication`, `ocr-review`, `remote-paseo`, `model-routing`,
`team-scripts-path`, `claude-hook` and `claude-team-mcp`. They are copied **flat**, so every import between them
must stay `./<name>.mjs`. `installer-contract.test.mjs` guards that: every
shipped file must exist, and every support script it imports must be shipped
too.

### agent-browser browser MCP

The installer probes four things:

- `agent-browser --version`
- `agent-browser doctor --offline --quick`
- the bundled skill (`agent-browser skills path agent-browser`)
- the standard MCP config locations

Whatever is missing, it then repairs: installs OCR (current pin `1.9.2`, keeping
any `>= 1.8.10` that passes the capability probe), runs `npm install -g
agent-browser` followed by `agent-browser install` (`--with-deps` on Linux),
copies the skill, and merges the `agent-browser` entry into
`~/.pi/agent/mcp.json` without overwriting other servers.

Re-running the installer is safe.

The Lead grants access to a Peer through a V3 brief field:

```text
BROWSER_MCP_AUTHORITY: allowed
```

The default is `denied`, and the grant does not persist across turns. Once
granted, the Peer may only search/connect the `agent-browser` server and call
targets prefixed `agent_browser_` / `agent-browser_` (plus the compatible
normalized prefixes); Paseo MCP and other servers stay off-limits.
`node scripts/preflight.mjs --json` covers the CLI, Chrome/runtime, skill and
MCP entry checks.

#### Launch mode vs. CDP attach mode

By default the MCP entry is `args: ["mcp"]` — **launch mode**. agent-browser
starts its own browser, which carries no cookies and no logged-in sessions.
That emptiness is what makes a per-turn `BROWSER_MCP_AUTHORITY` grant a real
bound: the worst a granted Peer can do is browse as a stranger.

**Attach mode** points agent-browser at a browser that is already running,
through the Chrome DevTools Protocol:

```bash
scripts/install.sh --attach-cdp-port 9222
# or, directly:
node scripts/browser-setup.mjs --install --attach-cdp-port 9222
```

That writes `args: ["--cdp", "9222", "mcp"]` (agent-browser takes `--cdp` as a
global flag, before the subcommand). It is faster and reuses the profile's auth
— which is exactly the cost: a Peer holding the grant inherits **every session
open in that profile**, and agent-browser refuses `--allowed-domains` while CDP
is in use, so per-domain restriction is off the table too. Point it at a
dedicated automation profile, never your daily browser.

The rules around it:

- **Opt-in, explicit port, no env fallback.** A setting this consequential has
  to be visible in the command that caused it.
- **Existing MCP entries are still never rewritten.** If one already exists with
  a different target, the installer *fails* rather than silently ignoring the
  flag — re-running `--attach-cdp-port` on an already-installed host is an
  error you can see, not a no-op you cannot.
- **Preflight probes it.** `agent-browser-cdp` reports launch mode, or dials
  `127.0.0.1:<port>/json/version` and fails when nothing answers, so a dead
  attach target surfaces as host unreadiness instead of a browser call dying
  mid-turn. `agent-browser-cdp-exposure` warns when the same port also answers
  on a non-loopback address — a browser started with
  `--remote-debugging-address=0.0.0.0` is unauthenticated remote control of
  that profile for anyone on the network.

### Paseo inspect contract test

Because `peer_ask_lead` and the watchdog depend on JSON fields Paseo exposes,
the repo carries a contract test that runs against a live daemon. It stays out
of ordinary CI because it needs an existing agent; run it explicitly with a
chosen agent ID:

```bash
PASEO_CONTRACT_AGENT_ID=<real-agent-id> node test/paseo-contract.test.mjs
```

It verifies the agent appears in `paseo ls -g --json` and that `Id`, `Status`,
`UpdatedAt`, `PendingPermissions` and `ParentAgentId` are present in
`paseo inspect --json`. A missing field or a changed schema fails loudly.

### Required: pi-mcp-adapter (pinned)

Paseo tools reach the pi agent over MCP, and pi has no built-in MCP, so the
adapter must be installed at **the exact verified version**:

```bash
pi install npm:pi-mcp-adapter@2.19.0
```

Paseo then detects the adapter and passes `--mcp-config` when launching agents.
The Paseo MCP server lifecycle defaults to `lazy`, so tools are called through
the **`mcp` proxy tool**: `{ "connect": "paseo" }` → `{ "search": ... }` /
`{ "describe": ... }` → `{ "tool": "<name>", "args": { ... } }`. The role pack
policy already allows `mcp` for Lead/Supervisor and blocks it for Peers.

> If the machine ran an older experiment that left `paseo-role-bootstrap.ts` in
> `~/.pi/agent/extensions/`, delete it or rename it to `.disabled` — this
> extension replaces it, and both together inject duplicate prompts.

### Paseo configuration

The installers **do not merge** `~/.paseo/config.json` — do it by hand, so the
change stays under your control:

1. Merge `config/paseo.providers.example.json` into `~/.paseo/config.json`
   (`agents.providers.pi-*` and `claude-*` + `daemon.mcp.injectIntoAgents: true`
   — required for agents to receive Paseo orchestration tools). Regenerate the
   `claude-*` block from the code with
   `pteam claude-setup --print-providers`, so the static tool policy in the
   config can never drift from the policy the hook enforces.
2. Restart the Paseo daemon (this kills every running agent — do it when
   ready). Derived providers do NOT appear in `paseo provider ls` until then.
3. Run `/reload` in pi to load the new extension.

With no `PASEO_PI_ROLE`, both adapters are passive: they inject nothing and
restrict nothing, so the pack is safe to install globally on a machine that
also runs plain pi or plain Claude Code.

### Mixed fleet (Pi + Claude Code)

The same three roles run on either coding agent. The Paseo provider names the
family and the role — `pi-peer`, `claude-lead`, … — and one rule set covers
both: `extensions/paseo-team-core/` holds every decision, with a Pi extension
and a set of Claude Code hooks as adapters.

```bash
pteam claude-setup --install           # hooks + paseo-team MCP server
pteam claude-setup --print-providers   # the claude-* block for ~/.paseo/config.json
pteam claude-setup --verify --json     # exit 1 when incomplete
node scripts/preflight.mjs --runtime both
```

Practical differences to know when routing:

| | pi | Claude |
|---|---|---|
| model reference | `<pi-provider>/<model-id>` | bare id, e.g. `claude-opus-5` |
| thinking | `off\|minimal\|low\|medium\|high\|xhigh\|max` | `off\|low\|medium\|high\|xhigh\|max\|ultracode` |
| team tools | `peer_ask_lead`, `team_watchdog` | `mcp__paseo-team__*` |
| Paseo tools | `mcp({ tool, args })` | `mcp__paseo__<tool>` |
| subagents | n/a | `Task` denied for every role — fan-out belongs to the Lead |

Mix Peers freely; keep one Lead per project on one family. Full architecture,
fail-closed behaviour and the install contract:
[`docs/claude-runtime.md`](docs/claude-runtime.md).

### Model routing (required for every create_agent)

For the 4-layer architecture and the no-silent-fallback mechanism see
[`docs/model-routing.md`](docs/model-routing.md). In short:

1. Per host (layer 1, never committed): pi + credentials + `~/.pi/agent/models.json`
   when using a custom provider.
2. Copy `config/model-routing.example.json` →
   `~/.paseo-pi-team/model-routing.local.json` and fill in the host's REAL model
   IDs from `paseo provider models pi-peer --json` (5 classes:
   `MONITOR_ECONOMY`, `FAST_READ`, `CODING_MEDIUM`, `REASONING_HIGH`,
   `REVIEW_HIGH`).
3. Cross-host: copy `config/cluster-routing.example.json` →
   `~/.paseo-pi-team/cluster-routing.local.json` on the CONTROLLER — a single
   file describing connection/required/capabilities/limits/routes for every
   host. Remote endpoints are referenced by **env var name** only, never by
   value. See [`docs/multi-host.md`](docs/multi-host.md). (The
   `hosts.local.json` host registry has been removed; the cluster file is the
   only source of hosts.)
4. The Lead passes an exact model into every `create_agent` as
   `pi-peer/<pi-provider>/<model-id>` + `settings.thinkingOptionId`, then checks
   it against `get_agent_status` runtimeInfo — any mismatch is
   `BLOCKED: MODEL_RESOLUTION_MISMATCH`, with no fallback. The Lead, not the
   Peer, owns observed routing evidence.
5. **Remote hosts** go through `remote-paseo.mjs`, never through MCP — see
   below.

### Reaching a remote host

The MCP injected into an agent always points at the LOCAL daemon: `--host` is a
CLI option, not an MCP argument. So every remote operation goes through

```text
<PASEO_TEAM_SCRIPTS_DIR>/remote-paseo.mjs
```

which reads the cluster file by HOST_ID, runs the Paseo CLI with `--host`,
never prints the endpoint, and returns a JSON envelope carrying `hostId`.

Covered operations: `health`, `providers`, `models`, `workspaces`,
`workspace-create`, `run`, `status`, `send`, `cancel`, `archive`.

`PASEO_TEAM_SCRIPTS_DIR` is an optional override — the installer's deterministic
default (`~/.pi/agent/extensions/paseo-team-scripts`) applies after a
shell/daemon restart. See [`docs/multi-host.md`](docs/multi-host.md) and the
Lead skill (LOCAL_CREATE_CYCLE vs REMOTE_CREATE_CYCLE).

### Compatibility matrix (verified 2026-08-04)

| Component | Version | Notes |
|---|---|---|
| Paseo CLI/daemon | 0.2.5 | `create_agent` schema, split-first-slash, runtimeInfo |
| Pi | 0.83.0 | `--model` (pattern), `--thinking` (7 levels), models.json |
| pi-mcp-adapter | 2.19.0 | **pinned**; lazy lifecycle, tool names prefixed `paseo_` |
| Node | ≥ 22.18 | type stripping on by default; CI runs 22.18 and 24 on ubuntu/windows/macos |

### Preflight

```bash
node scripts/preflight.mjs            # human-readable
node scripts/preflight.mjs --json     # machine-readable, exit 1 when any check fails
node scripts/preflight.mjs --strict --host-id <host-id>
                                      # cross-host gate: missing cluster config,
                                      # missing required remote endpoint env, or
                                      # unverifiable thinking → FAIL (never warn-as-pass)
```

Checks: node/git/paseo + version pins, the daemon, the adapter (pin), the
extension, the shared policy modules, role prompts, the role providers of every
runtime in scope, routing config (single-host + cluster contract), each route
against the real inventory, provider status, empty model segments, pi's
per-model `thinkingLevelMap` (a `null` level means the level gets clamped),
endpoint env vars, and repository state (a writer host must be clean in strict
mode). No secret is ever printed.

`--runtime pi|claude|both` selects which families the host is expected to
serve; with no flag it detects them from the installed CLIs, so a Claude-only
host is not reported as a broken pi host. In Claude scope it also verifies the
three hooks and the `paseo-team` MCP registration.

## CLI and WebUI

`pteam` (long alias: `paseo-team`) is the pack's CLI and the single writer for
everything the pack configures. The WebUI is an extension of that CLI, not an application beside
it: it maps an HTTP route onto a fixed `pteam` argv, spawns it, and renders
the JSON. It never touches a file and never calls `paseo` itself, so anything
you see in the browser can be reproduced in a terminal — the UI prints the exact
command behind every panel.

Install and quick start: see [Quick start](#quick-start) at the top of this
README.

```bash
node cli/paseo-team.mjs --help          # or `npm link` once, then `pteam`
pteam status                            # paths + presence, machine readable
pteam graph                             # agents, spawn tree, pending permits
pteam permits list
pteam web --port 4321 --open            # prints http://127.0.0.1:PORT/#token=...
```

The web server binds `127.0.0.1`, requires a per-run bearer token (handed to the
page through the URL fragment so it never reaches a server log), and checks
`Origin`/`Host` against DNS rebinding. `--no-token` exists for a throwaway demo
and says so loudly: this UI can approve permission requests.

Two different things are called "permission", and the UI keeps them apart:

- **Runtime permit** — one tool call is blocked right now and a human has to
  answer: `paseo-team permits list|allow|deny`, delegating to `paseo permit`.
  Every decision is appended to `~/.paseo-pi-team/permit-audit.jsonl` *before*
  the daemon is asked, so a decision that was made stays visible even if the
  delegate call then fails.
- **Policy authority** — what a role may do at all: the allowlists in
  `extensions/paseo-team-policy.ts`, `PASEO_TEAM_LEAD_WRITE`,
  `PASEO_TEAM_EXTRA_TOOLS`, and the V3 brief authority fields. The UI shows this
  read-only; there is no "grant everything" button.

Cost note, because it shapes the whole design: every `paseo` invocation costs
~3s of process startup on Windows regardless of the query. `paseo-team graph`
therefore batches a whole snapshot per call, caches the spawn tree in
`~/.paseo-pi-team/graph-cache.json` (`paseo ls` does not carry the parent link —
only `inspect` does), and spends at most `--max-inspect` lookups per run. A cold
cache fills over a few polls; a warm one answers in ~3.8s. Anything that could
not be collected is reported in `degraded[]` rather than quietly missing.

See `docs/webui-architecture.md` for the full contract, the graph schema, and
what is still missing (agent-to-agent message edges, multi-host).

## Debug commands

| Command | Purpose |
|---|---|
| `/team-role` | Prints the current role, peerMode, and the allow/deny policy. |
| `/team-tools` | Prints the whole tool registry: name, source, active/inactive, role. Writes `~/.pi/team-tools.txt`. |

Use `/team-tools` to settle the real allowlist — actual Paseo tool names can
differ from the defaults. Extra per-profile tools can be added with
`PASEO_TEAM_EXTRA_TOOLS="tool-a,tool-b"`.

## Proof-of-concept (single machine, Windows first)

The POC scenario uses any scratch repo **outside** the role pack (the original
was a `calculator.py` + `test_calculator.py` with a deliberate bug). The role
pack ships no test repo — create an equivalent scratch repo anywhere.

| # | Test | Expected |
|---|---|---|
| 1 | `PASEO_PI_ROLE=lead pi`, ask it to list providers/models | Lead sees Paseo tools and reports which ones it used |
| 2 | `PASEO_PI_ROLE=peer pi`, ask "Create another agent to inspect the repository" | `create_agent` absent or blocked; Peer returns `DEPENDENCY_REQUEST` |
| 3 | Ask the Supervisor to fix `calculator.py` | Refuses, sends an observation instead |
| 4 | Lead creates a Scout: read-only Peer, same workspace | Lead receives the completion notification |
| 5 | Lead creates an Engineer with `--isolation worktree` | Engineer fixes the bug, runs tests, reports the SHA |
| 6 | Independent Reviewer: `MODE: read-only` + `DISPOSITION: independent-reviewer` | Verifies the exact SHA, returns a verdict, fixes nothing |

## First-release completion criteria

```text
[x] pi-supervisor receives the right prompt
[x] pi-lead receives the right prompt
[x] pi-peer receives the right prompt

[x] Lead sees Paseo orchestration tools (via the mcp proxy, 60 tools)
[x] Supervisor sees monitoring tools only (fail-closed allowlist)
[x] Peer cannot see or call orchestration tools

[x] Read-only Peer does not modify files
[x] Engineer Peer can write inside an isolated workspace
[x] Lead is notified when a Peer finishes
[x] Lead can send a correction with send_agent_prompt (verified supervisor → lead; same tool)
[x] Reviewer runs as a fresh, read-only session
[x] The workflow completes with Paseo + the Pi extension + the Lead skill alone
```

Result on Windows, 2026-08-04, model `Minnyat/deepseek-v4-flash` — all 6 passed:

- **T1** Lead listed providers/models through mcp.
- **T2** Peer refused to spawn an agent and returned `REOPEN_REQUEST`.
- **T3** Supervisor was blocked from editing code and routed the task to the
  Lead with `send_agent_prompt`. The first run exposed a terminal-bypass hole
  through mcp, since patched with a fail-closed allowlist.
- **T4** Scout ran read-only and sent a completion notification.
- **T5** Engineer fixed 2 bugs in a worktree, 3/3 tests passing, reported the
  SHA, and the Lead verified it.
- **T6** The independent reviewer REFUSED because the working tree was dirty,
  even though the SHA matched — protocol over convenience.

## Development

Dev dependencies are pinned in `package.json` + `package-lock.json`, and CI
installs exactly that lockfile with `npm ci`:

```bash
npm ci              # installs @earendil-works/pi-coding-agent, @types/node, typescript
npm test            # runs every test/*.test.{mjs,mts}
npm run typecheck   # tsc --noEmit -p tsconfig.ci.json
npm run check       # both
```

Node **22.18+ or 23.6+** runs `.ts`/`.mts` directly thanks to type stripping
being on by default. Run a single suite when narrowing something down:

```bash
node test/policy.test.mts          # policy + per-turn lifecycle regression
node test/model-routing.test.mjs   # routing resolver regression
node test/remote-paseo.test.mjs    # remote executor regression (fake CLI)
node test/lib-common.test.mjs      # shared helpers: exec resolution, shims, versions
```

The root `tsconfig.json` is dev-only and machine-specific, so it is gitignored;
CI and `npm run typecheck` use the in-repo `tsconfig.ci.json`.

Smoke-test extension loading without an LLM (prints the mode):

```bash
PASEO_PI_ROLE=lead pi -e ./extensions/paseo-team-policy.ts -p "/team-tools"
```

## Design principles (summarized from the deep dive)

- Paseo is the only control plane: agent/workspace state is always read from
  Paseo, including in multi-host setups.
- The git commit SHA is the anchor between writer and reviewer.
- A Peer is an independent co-worker, not a function call; a brief carries no
  disguised verdict, and the Peer may answer `REOPEN_REQUEST` /
  `DEPENDENCY_REQUEST` / `BLOCKED`.
- One writer per moving scope; worktree isolation whenever writers run in
  parallel.
- The Supervisor is a governance plane: it observes, never edits code, and never
  directs Peers.
- Model and workspace IDs must be inspected (`list_providers`, `list_models`),
  never guessed.

## License

[MIT](LICENSE).

`package.json` keeps `"private": true` on purpose: this role pack installs via
`scripts/install.{sh,ps1}`, never through `npm install`, so the flag guards
against an accidental `npm publish`. It does not restrict use — the MIT license
governs that.

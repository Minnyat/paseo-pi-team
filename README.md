# paseo-pi-team

[![ci](https://github.com/Minnyat/paseo-pi-team/actions/workflows/ci.yml/badge.svg)](https://github.com/Minnyat/paseo-pi-team/actions/workflows/ci.yml)
[![license: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

A role pack that runs directly on **Paseo + Pi**. Three components, three
separate responsibilities: Paseo owns lifecycle/workspace/control-plane truth;
the Pi extension owns role invariants (prompt + tool policy); the Lead skill
owns the orchestration procedure.

Full design reference:
[`docs/demonthorn-agent-orchestration-deep-dive.md`](docs/demonthorn-agent-orchestration-deep-dive.md).

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
│   ├── paseo.providers.example.json   # 3 Pi profiles: supervisor / lead / peer
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
│   └── paseo-team-policy.ts        # injects the prompt and applies the per-role tool policy
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
│   └── fixtures/                   # fake CLIs (paseo, ocr) + version-pinned OCR output
└── docs/
    ├── demonthorn-agent-orchestration-deep-dive.md   # original design
    ├── model-routing.md            # the 4 model-routing layers, verified commands
    ├── multi-host.md               # N-host routing + cross-host test plan
    └── ocr-integration.md          # OpenCodeReview Phase 1 single-machine setup
```

## Roles

| Profile | `PASEO_PI_ROLE` | Tool policy (default; refine after running `/team-tools`) |
|---|---|---|
| `pi-supervisor` | `supervisor` | `read` + monitoring `mcp` + `team_watchdog` (observation-only); `create_agent` only for Lead recovery, behind an argument guard. No `write`/`edit`. |
| `pi-lead` | `lead` | Pi `read`/`bash` + Paseo discovery/workspace/monitoring/orchestration/permissions + `team_watchdog`. `write`/`edit` only when `PASEO_TEAM_LEAD_WRITE=1`. |
| `pi-peer` | `peer` | `MODE: write` → `read`/`write`/`edit`/`bash` + `peer_ask_lead`; `MODE: read-only` → `read`/`bash` + `peer_ask_lead`. Peers get no Paseo MCP/orchestration; browser MCP is granted only by the current V3 brief. |

The policy is a **pure allowlist** (`setActiveTools`) plus a backstop that
blocks inside `tool_call`. It is not an absolute security sandbox. Every
authority is recomputed from the brief of the **current turn**: only a V3
marker block (`PASEO_TEAM_TASK_V3_BEGIN` … `PASEO_TEAM_TASK_V3_END`) can grant
write mode or git authority; **the legacy `PASEO_TEAM_TASK_V1|V2` header always
resolves to read-only** (every `MODE` and `*_AUTHORITY` field is ignored — the
legacy parser scanned the whole prompt and was an injection hole). A Peer's
`git commit`/`git push` through bash is blocked unless the V3 brief grants
`*_AUTHORITY: allowed`; push authority is **branch-scoped** (exactly
`git push -u origin HEAD:refs/heads/agent/<TASK_ID>`); force-push in every
spelling (`-f`, `-uf`, `-fu`, `--force*`, refspec `+`) and Peer merges are
always blocked. `BROWSER_MCP_AUTHORITY` is a current-turn grant: only
agent-browser-prefixed targets and `connect/search` are scoped to the
`agent-browser` server, and the agent-browser CLI through bash is always
blocked. Paseo MCP and every other MCP server stay blocked.

## Communication and watchdog

### A Peer asks the Lead

Peers use the custom `peer_ask_lead` tool, not `paseo send` through bash. The tool reads `PASEO_AGENT_ID`, inspects `paseo.parent-agent-id`, sends only to the parent Lead, and wraps the payload as `PEER_MESSAGE_V1` with `kind`, `TASK_ID` and `CORRELATION_ID`. The inspect step retries up to 3 times with backoff, and only for transient transport errors; `send` is never retried, because delivery ambiguity can create duplicates. Message kinds: `question`, `blocked`, `dependency`, `progress`. Failing to resolve the parent is fail-closed, and there is no broadcast.

### Lead/Supervisor check for hung agents

The custom `team_watchdog` tool checks `running` agents via `paseo ls -g` + `paseo inspect` with bounded concurrency (default 6), a global deadline (default 30s), partial results on timeout, and up to 3 transport retries. Only a successful inspect whose `UpdatedAt` is past the threshold (default 5 minutes) is marked `stale`/**suspected**; a failed inspect is **unknown**, and nothing is auto-cancelled, auto-archived or auto-spawned.

Recovery is mandatory-by-checklist: inspect activity, pending permissions, daemon/remote health, expected long-running commands, and workspace/Git state — only then does the Lead decide cancel/archive/correction. Never create a replacement writer while the previous commit/state is still unclear.

### Transport retries

`remote-paseo.mjs` retries up to 3 times for read/health/provider/status operations; `run` and `send` are never retried, to avoid duplicate tasks or messages. Usage, authority, model, workspace, endpoint and malformed-request errors fail immediately.

## OpenCodeReview delegation (Phase 1)

`paseo-ocr-reviewer` is a strictly read-only Reviewer Peer skill. The
installer automatically installs and verifies the OCR CLI
`@alibaba-group/open-code-review` (capability-based: any installed release at
or above the verified `1.8.10` baseline that passes the delegation capability
probe is accepted as-is and never downgraded; when OCR is absent or
incompatible the installer installs the pinned `1.9.2`). OCR is not an
agent/provider or second control plane: it deterministically selects files and
resolves rules, while the Pi Reviewer performs reasoning on the exact candidate
SHA. The installer runs `scripts/ocr-setup.mjs` to install/verify the CLI;
check it manually with `ocr version` (PowerShell:
`Get-Command ocr`; Unix-like shells: `command -v ocr`) and use delegation mode,
not `ocr review`. See [`docs/ocr-integration.md`](docs/ocr-integration.md).

The optional deterministic preflight emits a normalized manifest:

```bash
node scripts/ocr-review.mjs --repo <repo> --base <base-sha> --candidate <candidate-sha>
```

It probes `delegate preview/rule` capabilities (recording the OCR version as
provenance, preferring `--format json` when the installed release supports it)
and blocks candidate mismatch, non-worktree review workspaces
(`REVIEW_WORKSPACE_NOT_WORKTREE` — the reviewer must run in a linked git
worktree, never a primary checkout or standalone clone), dirty/mutated
workspaces, unavailable/incompatible OCR, malformed selection/rules, and
incomplete rule coverage. Its manifest includes candidate-tree/workspace
entry-exit state and deterministic digests. It never edits Git state or calls
an LLM.

## Installation

```bash
# Windows (PowerShell)
./scripts/install.ps1

# macOS / Linux
./scripts/install.sh
```

What the installers copy:

- `extensions/paseo-team-policy.ts` → `~/.pi/agent/extensions/`
- `prompts/*.md` → `~/.pi/agent/extensions/prompts/`
- `skills/paseo-team-lead/` → `~/.pi/agent/skills/paseo-team-lead/`
- `skills/paseo-ocr-reviewer/` → `~/.pi/agent/skills/paseo-ocr-reviewer/`
- support scripts (`lib-common`, `reliability`, `watchdog`, `team-communication`,
  `ocr-review`, `remote-paseo`, `model-routing`, `team-scripts-path`) →
  `~/.pi/agent/extensions/paseo-team-scripts/` — copied **flat**, so every
  import between them must stay `./<name>.mjs`. `installer-contract.test.mjs`
  guards this: every shipped file must exist, and every support script it
  imports must be shipped too.
- `agent-browser` CLI + Chrome runtime (when missing), bundled skill → `~/.pi/agent/skills/agent-browser/`
- MCP entry `agent-browser: { command: "agent-browser", args: ["mcp"] }` → `~/.pi/agent/mcp.json` when absent from the standard config locations

### agent-browser browser MCP

The installer checks `agent-browser --version`,
`agent-browser doctor --offline --quick`, the bundled skill
(`agent-browser skills path agent-browser`) and the standard MCP configs. When
something is missing it installs OCR `@alibaba-group/open-code-review` (current
pin `1.9.2`; an installed `>= 1.8.10` that passes the capability probe is kept
as-is and never downgraded), runs `npm install -g agent-browser` and
`agent-browser install` (`--with-deps` on Linux), copies the skill, then merges
the `agent-browser` entry into `~/.pi/agent/mcp.json` without overwriting other
servers. Re-running the installer is safe.

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
   (`agents.providers.pi-*` + `daemon.mcp.injectIntoAgents: true` — required for
   agents to receive Paseo orchestration tools).
2. Restart the Paseo daemon (this kills every running agent — do it when ready).
3. Run `/reload` in pi to load the new extension.

With no `PASEO_PI_ROLE`, the extension is passive: it injects nothing and
restricts nothing, so it is safe to install globally on a machine that also
runs plain pi.

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
5. **Remote hosts**: the MCP injected into an agent always points at the LOCAL
   daemon — `--host` is a CLI option, not an MCP argument. The Lead uses
   `<PASEO_TEAM_SCRIPTS_DIR>/remote-paseo.mjs` (the installer copies the support
   scripts to `~/.pi/agent/extensions/paseo-team-scripts`; the environment
   variable is an optional override, since the deterministic default applies
   after a shell/daemon restart). It reads the cluster file by HOST_ID, runs the
   Paseo CLI with `--host`, never prints the endpoint, and returns a JSON
   envelope carrying `hostId` — for every remote operation:
   `health/providers/models/workspaces/workspace-create/run/status/send/cancel/archive`.
   See `docs/multi-host.md` and the Lead skill (LOCAL_CREATE_CYCLE vs
   REMOTE_CREATE_CYCLE).

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

Checks: node/git/paseo/pi + version pins, the daemon, the adapter (pin), the
extension, role prompts, the 3 role providers, routing config (single-host +
cluster contract), each route against the real inventory, provider status, empty
model segments, pi's per-model `thinkingLevelMap` (a `null` level means the
level gets clamped), endpoint env vars, and repository state (a writer host must
be clean in strict mode). No secret is ever printed.

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

1. **Lead sees Paseo tools** — `PASEO_PI_ROLE=lead pi`, ask it to list providers/models and report the tool names it used.
2. **Peer cannot spawn agents** — `PASEO_PI_ROLE=peer pi`, ask "Create another agent to inspect the repository" → `create_agent` is absent or blocked, and the Peer returns `DEPENDENCY_REQUEST`.
3. **Supervisor cannot edit code** — ask it to fix `calculator.py` → it refuses and sends an observation.
4. **Lead creates a Scout** — a read-only Peer in the same workspace; the Lead receives the completion notification.
5. **Lead creates an Engineer in a worktree** — workspace `--isolation worktree`; the Engineer fixes the bug, runs tests, reports the SHA.
6. **Independent Reviewer** — `MODE: read-only` + `DISPOSITION: independent-reviewer`; verifies the exact SHA, returns a verdict, and fixes nothing itself.

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

POC result on Windows (2026-08-04, model Minnyat/deepseek-v4-flash): all 6
tests PASSED — T1 lead listed providers/models through mcp; T2 peer refused to
spawn an agent and returned REOPEN_REQUEST; T3 supervisor was blocked from
editing code (the first run exposed a terminal-bypass hole through mcp, since
patched with a fail-closed allowlist) and routed the task to the Lead with
send_agent_prompt; T4 scout ran read-only and sent a completion notification;
T5 engineer fixed 2 bugs in a worktree, 3/3 tests passing, reported the SHA,
and the lead verified it; T6 the independent reviewer REFUSED because the
working tree was dirty even though the SHA matched — protocol over convenience.

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

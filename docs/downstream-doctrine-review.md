# What `webplode/paseo-doctrine-downstream` has that we don't

A review of [`webplode/paseo-doctrine-downstream`](https://github.com/webplode/paseo-doctrine-downstream)
(`paseo 0.7.2-paseo.63`, read at commit `20b717f`) against this role pack, and what is
worth taking from it.

## What that repo is

It is the Paseo product itself — the downstream distribution that ships the daemon,
the WebUI, the CLI and a bundled **Foundation** (doctrine + role contracts + skills),
as host-native installers. It is not a role pack; it is the thing a role pack runs on.
So almost nothing in it is code we can reuse. What it has is a *more mature version of
the same problem we are solving*: binding three roles (Lead / Peer / Supervisor) to
coding agents so the binding survives compact, resume and a fresh turn.

Two structural differences shape everything below:

- **They enforce in the daemon, we enforce in the runtime.** They materialize an
  immutable `RoleBinding` server-side and compose it into a `LaunchContract`; we inject
  a prompt through a Pi extension and Claude Code hooks. Theirs cannot be edited by the
  caller; ours can be edited by anyone with write access to `~/.pi/agent/`.
- **They own the lifecycle, we borrow it.** They can fail a launch closed. Our strongest
  move is to refuse a tool call and tell the seat why.

That means we should copy their *invariants and receipts*, not their architecture.

---

## 1. Defects in this repo that the comparison exposed

### 1.1 `WORKSPACE_PROTOCOL.md` lives in two different places

`templates/WORKSPACE_PROTOCOL.example.md:3` tells the Human to put the file at
`.orchestration/WORKSPACE_PROTOCOL.md`, and `README.md:60` repeats it. But
`prompts/lead.md:64` tells the Lead to read "the target repo's `WORKSPACE_PROTOCOL.md`"
and `skills/paseo-team-lead/SKILL.md:11` says the same. Nothing resolves the two paths,
so a Human who follows the template writes a protocol the Lead never reads, and neither
side reports anything.

Both the doctrine we ship (`docs/demonthorn-agent-orchestration-deep-dive.md:746`) and
the downstream (`docs/native-role-binding.md`, "Repository tiếp tục sở hữu exact **root**
`WORKSPACE_PROTOCOL.md` v3") put the file at the repository root. The template is the
odd one out.

Fixed in this change: the template now names the repository root, with
`.orchestration/WORKSPACE_PROTOCOL.md` kept as a documented legacy fallback.

### 1.2 A Claude Lead is told to load a skill that is never installed

`prompts/lead.md:64-66` makes it invariant #1: read the protocol, "then load the
`paseo-team-lead` skill". On Pi that works — `scripts/install.sh:97` copies both skills
into `~/.pi/agent/skills/`. On Claude Code it cannot: `scripts/claude-setup.mjs` writes
hooks into `~/.claude/settings.json` and an MCP server into `~/.claude.json`, and never
writes `~/.claude/skills/`. `Skill` is allowed for every role
(`extensions/paseo-team-core/claude-policy.ts:96`), so the tool call is permitted and
simply finds nothing.

The README's claim is that the two runtimes serve the same three roles and that "a rule
denied on one runtime is denied on the other". This is the inverse: a *capability*
present on one runtime and absent on the other. A Claude Lead orchestrates without the
932-line procedure its prompt assumes it has read.

The downstream hit the same wall and solved it by not trusting the provider's skill
loader at all: the daemon embeds the exact mandatory package bytes into the durable role
instruction (`docs/skill-system.md`, "daemon đồng thời embed exact active
`beads-issue-tracker` package vào immutable RoleBinding cho mọi provider, nên mandatory
checkpoint không phụ thuộc provider-native skill loader").

**Fixed.** `scripts/claude-setup.mjs` now installs the pack's skills into
`~/.claude/skills/` on `--install`, removes them on `--uninstall`, and reports a missing
one from `--verify` as an incomplete install. See §2.1 for the gate that had to land in
the same change.

### 1.3 `pteam preflight` does not check what its own message promises

`cli/paseo-team.mjs:964` tells the user to run `pteam preflight` "to confirm the installed
copies match this version". Preflight does not do that. Its `policy-core` check
(`scripts/preflight.mjs:358-391`) proves the installed module *loads and exports the
policy API* — a genuinely good check, and better than presence — but a policy core from
three releases ago loads and exports exactly the same API. Nothing compares bytes.

This matters because the pack's own update path creates drift by design: `npm i -g`
refreshes the CLI, the copies under `~/.pi/agent/` stay put, and both halves then report
the new version number (the comment at `cli/paseo-team.mjs:955-962` says so explicitly).

**Fixed.** `cli/lib/install-drift.mjs` hashes every installed artifact against the
package preflight is running from, and preflight reports it as `install-drift` — a
warning by default, a failure under `--strict`. See §2.2 for why it compares bytes
directly instead of writing a manifest.

---

## 2. Mechanisms worth adopting, ranked

### 2.1 A role → skill admission manifest (high value, ~half a day)

Downstream ships two of them — `skills/role-admission.json` for product skills and
`foundation/dist/skills/role-bundles.json` for Foundation role skills — with the same
three-state vocabulary:

| State               | Meaning                                                             |
| ------------------- | ------------------------------------------------------------------- |
| `active`            | the role may use it when the task matches the trigger and the lease  |
| `explicit-only`     | only when the Human names the skill                                  |
| `packaged-disabled` | bytes ship for provenance and review, but are not eligible at runtime |

And one rule: projection **fails closed** if the manifest is missing, invalid, or names a
package that does not exist.

We ship two skills into one global directory with no admission map at all. A Peer that
can see `paseo-team-lead` is a Peer that can read the orchestration procedure it is not
supposed to run — the downstream calls this "skill pollution: agent dễ trượt từ task
sang orchestration". Our policy already blocks the *tools* that procedure needs, so this
is attention pollution rather than an authority hole, but it is still the wrong default.

Concretely for us: a `skills/role-admission.json` with `paseo-team-lead` active for
`lead` only, and `paseo-ocr-reviewer` active for `peer` (it already declares itself
loadable only by a Peer with `DISPOSITION: independent-reviewer`,
`skills/paseo-ocr-reviewer/SKILL.md:8`), enforced in `claudeToolBlockReason` for the
`Skill` tool — the hook already receives `toolInput`, so the skill name is available.
The Pi side has no `skill` tool to gate; the equivalent there is a `read` deny on a
non-admitted skill directory.

**Adopted**, paired with the §1.2 fix so that adding the capability did not also hand it
to every seat. Two states rather than three: `explicit-only` is a label neither runtime
gives us a signal to enforce ("the Human named this skill"), and an unenforceable state
in an enforcement table is theatre. `SKILL_ADMISSION` in `policy-core.ts` is the one
table; Claude gates the `Skill` tool per call, and pi — which has no `skill` tool, and
loads a skill by *reading* its `SKILL.md` — gates the read path. `paseo-ocr-reviewer`
additionally follows the brief: admitted for a Peer whose `DISPOSITION` names a reviewer,
which is what the skill's own first paragraph already claimed. `test/policy.test.mts`
fails if a directory under `skills/` is not classified, so the next skill cannot default
to visible-for-everyone.

### 2.2 An install manifest with per-file digests (high value, ~half a day)

`foundation/manifest.json` records `path`, `mode` and `sha256` for every distributed
file, generated by `scripts/import-foundation.mjs`. `scripts/install.sh` separately
verifies the release archive against a published `.sha256` before unpacking.

This is the direct answer to §1.3.

**Adopted, without the manifest.** Their manifest exists because the source bytes are not
present on the target host — the Foundation is imported from another repository. Ours
are: `pteam preflight` runs from the package, so both sides of every comparison are
already on disk, and a manifest would be a third copy that can go stale on its own. So
`installDrift()` hashes the installed artifact against its source directly and reports
`changed`, `missing` or `unexpected` per file. `unexpected` is the leftover case their
manifest would also catch — a retired support script, or the built `.js` that
`install.sh` deletes from the policy core so the two runtimes cannot read different
rules — and is only reported for directories the installers replace wholesale, never for
the shared prompts directory. The existing `policy-core` load check stays: it proves the
module loads, this proves it is the version this CLI enforces.

### 2.3 Admission states for the workspace protocol (medium value, ~a day)

The downstream does not treat the protocol as a file that is either there or not. It
tracks four states — `missing | valid | invalid | unreadable` — plus a content digest,
a binding receipt, and role-specific readership, and it fails closed on
`invalid|unreadable` *always* and on `missing` for ordinary work. The distinction that
earns its keep: an unresolved merge conflict or a truncated protocol is not "no
protocol", it is a protocol the Lead must not act on.

We had none of this. The protocol was a template we handed the Human; nothing read it,
validated it, or noticed it changed.

**Adopted, reporting only.** `cli/lib/workspace-protocol.mjs` grades a repo into the
same four states with a sha256 digest, exposed as `pteam protocol status` and as the
`workspace-protocol` preflight check. Preflight fails on `invalid`/`unreadable` and warns
on `missing`, which is the split that matters: `missing` a Lead can act on, while a
protocol carrying an unresolved merge conflict is worse than absent. The legacy
`.orchestration/` path from §1.1 is still resolved, and reported as legacy.

What we did NOT take is the enforcement: they fail a launch closed on a missing protocol
and admit only a bounded Human-issued bootstrap exception. They can — they own the
daemon and the launch. We could only express it as a tool-call deny, and turning a
missing protocol into a delegation blocker for existing fleets is a decision for whoever
operates one, not something a release switches on underneath them.

Note the readership rule is doctrine we already carry and should keep visible when we
implement this: Lead reads it in full, Peer does not (the Lead extracts the relevant
constraints into the brief), Supervisor reads it only under a governance mandate
(`docs/demonthorn-agent-orchestration-deep-dive.md:764-772`, and identically in the
downstream).

### 2.4 A byte budget on instruction files (low cost, ~an hour)

`scripts/agent-instructions.test.mjs` fails the build when `CLAUDE.md` exceeds 20 KiB,
with the reason in the comment: agent runtimes cap instruction files and **truncate
silently**, so a rule pushed past the cap simply stops existing. The same file asserts
`AGENTS.md` is still a symlink to `CLAUDE.md`, so the Codex-family and Claude-family
rules cannot fork.

Our three role prompts are 319 / 294 / 442 lines and are injected as durable instruction
on every turn (Pi) or once as turn context (Claude). Nothing bounded them.

**Adopted, with a different justification.** We cannot honestly claim their reason: no
runtime this pack targets documents a cap on an *appended* system prompt, and inventing a
number and calling it a cap would be worse than having none. What is verifiable is the
cost — `extensions/paseo-team-policy.ts` re-appends the whole role prompt on every
`before_agent_start`, so a 22 KB Supervisor contract is a per-turn tax — and the ratchet:
every incident adds a paragraph and none removes one, because appending is always the
smaller edit. So `test/instruction-budget.test.mjs` sets each budget a little above
today's largest file. Crossing one is then a decision somebody makes on purpose, in the
same commit, rather than something that happens over six months of reasonable diffs. It
also fails if a fourth role prompt appears without a budget, and if either adapter stops
injecting the prompt the budgets are about.

### 2.5 A managed block in the target repo's entrypoint (medium value)

`foundation/dist/templates/harness/entrypoint-block.md` is a
`<!-- PASEO_HARNESS:BEGIN -->` / `<!-- PASEO_HARNESS:END -->` block with
`{{HARNESS:ENTRY_MAP_PATH}}` placeholders, written into the target repo's `CLAUDE.md`
(see that repo's own `CLAUDE.md:1-9`). An updater can rewrite its own block without
touching the Human's content, and `docs/harness/README.md` has an explicit rule for
meeting a *different* harness already managing the file: do not overlay a second block,
reconcile ownership first.

We have no supported way to tell a target repository that it is orchestrated by this
pack. If we ever want one — pointing at the protocol, naming the brief format — this is
the shape to copy, including the do-not-overlay rule.

### 2.6 Vocabulary worth stealing wholesale (free)

Three distinctions from `docs/foundation-doctrine.md` and `docs/native-role-binding.md`
that our prompts express less sharply:

- **Capability is not authority.** "`full-access` là runtime capability, không phải write
  lease, ownership, external-effect hoặc acceptance authority." Our prompts say this at
  length; that sentence says it once.
- **Evidence is not status.** Current bytes, a stable Git identity, focused checks and
  reproduced behavior are evidence. A notification, silence, lifecycle `completed`, model
  confidence or a single passing test are signals.
- **Doctrine / candidate / qualified are three different states.** A focused test proves
  candidate bytes at the tested boundary, and nothing about activation or end-to-end
  behavior. This is a useful honesty gate for our own `TASK_STATE.md` claims.

Also worth noting as *convergent design*, not something to adopt: their assignment
effect taxonomy (`read-only | mutating | delegation | bootstrap | recovery`) and pinned
per-provider no-write mode is the same idea as our V3 brief's `MODE` / authority fields
and `PI_READ_ONLY` tool set. They pin it at launch, we pin it per tool call. Both fail
closed.

---

## 3. Engineering practices worth adopting

- **`lefthook.yml` pre-commit** running format / lint on staged files and a full
  typecheck. We have CI on three OSes but nothing local, so a contributor learns about a
  formatting failure after the push.
- **`knip.json`** for unreferenced files and exports. Our `extensions/paseo-team-core/policy-core.ts`
  is 3,911 lines with ~70 exports; dead-export drift there is invisible today.
- **A docs index with rules.** `docs/README.md` is a table of every doc with a one-line
  "what it covers", plus three rules that do real work: integrate rather than append;
  one fact, one doc, every other mention is a link; delete obsolete sections. Our `docs/`
  has seven files and no index.
- **Release integrity in the installer.** Their `scripts/install.sh` fetches a `.sha256`
  next to the archive, rejects anything that is not 64 lowercase hex characters, and
  compares before unpacking. Ours installs from a checkout and has no equivalent step.

## 4. Deliberately not adopting

- **Daemon-side role binding.** Correct for them, impossible for us: we do not own the
  daemon. Our hook/extension enforcement is the right layer for a pack.
- **The Beads Central checkpoint contract.** A mandatory `beads_status` receipt bound to
  the assignment digest, blocking every other Beads operation until it exists, is a good
  invariant — but it presumes an issue-graph service we do not ship and do not require.
- **zod-aot protocol validation, RPC namespacing, the Expo/Unistyles docs.** Product
  concerns with no analogue in a zero-dependency Node role pack.
- **Multi-provider role qualification (Cursor / Antigravity / OMP / custom Codex).** We
  serve two runtimes deliberately.

## 5. Compatibility watch item

The downstream daemon now binds Pi roles itself, by generating a Pi extension that
appends the role instruction on `before_agent_start`, on create *and* resume
(`packages/server/src/server/agent/providers/pi/agent.ts:697`). Our extension registers a
handler for the same event and returns its own `{ systemPrompt }`
(`extensions/paseo-team-policy.ts:558`).

Whether both appends survive depends on how Pi chains multiple `before_agent_start`
handlers — if each receives the previous result, both land; if not, one silently wins.
This is not a confirmed bug, and it does not arise against upstream Paseo. It is the
thing to check first if a seat on a downstream-Foundation daemon ever comes up with a
role prompt that is missing half of itself.

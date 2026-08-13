# OpenCodeReview integration — Phase 1 (single machine)

This role pack integrates Alibaba OpenCodeReview (OCR) as a deterministic
review harness used by the `independent-reviewer` Peer. Phase 1 assumes Paseo,
Pi, Git, OCR, and the target repository/worktree are available on one machine.
It does not add remote OCR routing, a reviewer host, workspace transfer, SSH, or
an OCR agent/provider.

## Prerequisites

The role-pack installers automatically install and verify the OCR CLI
`@alibaba-group/open-code-review`. Compatibility is capability-based: any
installed release at or above the verified `1.8.10` baseline that passes the
delegation capability probe (`ocr delegate preview|rule --help` exposing
`--repo`/`--from`) is accepted as-is and never downgraded. When OCR is absent,
too old, or capability-broken, the installer installs the pinned `1.9.2`. If
you are not using an installer, install it manually with the command in the
next section. The wrapper still fails closed on missing OCR or a real
capability/schema incompatibility.

- Git `>= 2.41` (current upstream requirement);
- Node.js/npm when installing the npm distribution;
- Pi and Paseo configured for this role pack;
- the `paseo-ocr-reviewer` skill installed;
- a clean fresh reviewer workspace at the assigned candidate SHA, created as a
  **linked git worktree** from the source repository (worktree isolation) —
  the wrapper rejects a primary checkout or standalone clone with
  `REVIEW_WORKSPACE_NOT_WORKTREE`;
- the OCR CLI (verified releases: v1.8.10 through v1.9.2).

Detect the platform and shell rather than assuming one:

```text
Windows PowerShell: Get-Command ocr
Unix-like shell:    command -v ocr
All platforms:      node --version; npm --version; git --version
```

## Install and verify

Check first. Do not reinstall a working OCR CLI:

```text
Windows PowerShell: ocr version
Unix-like shell:    ocr version
```

If it is unavailable and you are not running the role-pack installer, use the official npm distribution:

```bash
npm install -g @alibaba-group/open-code-review@1.9.2
ocr version
```

The verified baseline contract is OCR `open-code-review v1.8.10`; `v1.9.2` is
verified end-to-end on Windows with Git Bash, Node `v25.9.0`, npm `11.12.1`,
and Git `2.53.0.windows.2`. The wrapper treats the version as provenance and
blocks only on a real incompatibility (`OCR_CAPABILITY_MISSING`,
`OCR_OUTPUT_SCHEMA_UNSUPPORTED`); the installer refuses to leave an install
below the baseline (`OCR_VERSION_UNSUPPORTED`). Do not copy this machine's
paths into configuration. No API key or secret is required by delegation mode,
and no secret belongs in this repository.

## Delegation smoke test

Run these commands inside a safe Git repository. Use a clean committed range;
do not dirty the role-pack worktree merely to smoke-test it:

```bash
BASE_SHA="$(git rev-parse <base-ref>)"
CANDIDATE_SHA="$(git rev-parse <candidate-ref>)"
ocr delegate preview --from "$BASE_SHA" --to "$CANDIDATE_SHA"
```

On PowerShell, use:

```powershell
$base = git rev-parse <base-ref>
$candidate = git rev-parse <candidate-ref>
ocr delegate preview --from $base --to $candidate
```

The v1.8.10 CLI rejects `--format` and emits structured Markdown; v1.9.x
supports `--format json`. The wrapper probes the installed CLI and requests
JSON when available, normalizing both forms against one schema. If the preview
includes reviewable paths, resolve their rules with the exact paths returned
by OCR:

```bash
ocr delegate rule <path-1> <path-2>
```

For a normalized, exact-SHA preflight from the role-pack root:

```bash
node scripts/ocr-review.mjs --repo <repo> --base <base-sha> --candidate <candidate-sha>
```

The manifest is emitted on stdout. If saving it, write outside the reviewed
worktree (or to an ignored location); creating `manifest.json` inside the
review workspace before startup correctly triggers the dirty-workspace gate.

The wrapper checks `git rev-parse HEAD`, clean `git status --porcelain`,
`ocr version`, and both delegate capability help surfaces, then runs `ocr
delegate preview` and `ocr delegate rule` in range mode. It validates full
base/candidate SHAs and repository-relative OCR paths before passing them to
Git/OCR. It performs a second HEAD/status/tree check before emitting
`paseo.ocr-review-manifest/v1`, which includes candidate-tree, workspace
entry/exit, selection/rule digests, and harness provenance. It must not be used
as an AI reviewer and has no LLM call.

## Architecture

```text
Paseo Supervisor
      ↓
Paseo Lead
      ↓
Engineer Peer → candidate Git SHA
      ↓
Independent Reviewer Peer (fresh, clean workspace)
      ↓
OCR delegation: selection + filtering + rules
      +
Pi reasoning/tools: exact diff + repository evidence
      ↓
structured findings → Lead acceptance decision
```

- OCR is not an agent, Paseo provider, writer, or control plane.
- Paseo remains the only orchestration/control plane.
- The Engineer is the only product-code writer.
- The Reviewer is read-only and never commits, pushes, merges, deploys, or
  auto-fixes.
- The Git SHA is the immutable review handoff. A correction returns to the same
  Engineer, creates a new commit, and is reviewed again.
- The Lead owns acceptance/rejection. Human owns merge/deploy.
- OCR delegation is primary; OCR-managed LLM review is not configured in Phase 1.

## Troubleshooting

### `ocr` command not found / `OCR_UNAVAILABLE`

Use the platform-native command lookup above, install the official package, and
restart the process if PATH was changed. If `ocr version` still fails, the
Reviewer must return `BLOCKED: OCR_UNAVAILABLE`; do not silently review a
manually selected file list.

### Old Git

Upgrade Git to the current upstream minimum (`>= 2.41`) and rerun `git
--version`. OCR uses Git for diff generation and repository operations.

### Not inside a Git repository

Run the command with `--repo <repository-root>` or create the Reviewer
workspace from the target repository. The wrapper returns
`NOT_GIT_REPOSITORY`.

### Wrong candidate SHA

The reviewer compares `git rev-parse HEAD` to the assigned candidate. A mismatch
is `BLOCKED: CANDIDATE_SHA_MISMATCH`. Do not checkout/reset/rebase/cherry-pick to
repair it; ask the Lead for a fresh workspace at the exact SHA.

### Dirty review workspace

Any output from `git status --porcelain` blocks review as
`DIRTY_REVIEW_WORKSPACE`. Preserve the workspace and user changes; prepare a
new clean reviewer workspace.

### Preview returns zero files

Zero reviewable files is an observable empty review, not permission to replace
OCR with `git diff --name-only`. Record `TOTAL_REVIEWABLE: 0`,
`COVERAGE_RATE: 100%` for the empty accounted-for set, and report the range and
OCR output to the Lead for disposition.

### Unsupported or excluded files

Use the `excluded_files` reasons returned by OCR. Excluded files are not
silently added back. Every OCR-selected reviewable entry must be marked
`reviewed` or `skipped:<concrete reason>`; missing rule mapping is a blocker or
partial result, never a false 100% coverage claim.

### Rule resolution fails

Return `BLOCKED` or `PARTIAL` with the concrete OCR error and affected paths.
Do not invent rules, silently fall back to a manual rule set, or claim the
selection was fully reviewed.

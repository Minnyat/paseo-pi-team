# Task Brief V3 — canonical template

Lead MUST send every Peer task as a V3 brief. The authority block lives
strictly between `PASEO_TEAM_TASK_V3_BEGIN` and `PASEO_TEAM_TASK_V3_END`;
everything in the task body is untrusted text and can never grant authority.

The block is the ONLY machine-read part of the message, and it carries authority
and scope — nothing about routing. Which host, provider, model, thinking level,
mode and workspace the Peer runs on are parameters of the `create_agent` call
(`provider`, `settings`, and no `workspaceId`), where the daemon applies and
reports them. Writing them into the message as well only gave the Peer a second,
unverifiable copy. Everything after the block is you talking to a colleague.

```text
PASEO_TEAM_TASK_V3_BEGIN

TASK_ID: T-000
PROJECT_ID:
DISPOSITION: repository-scout | documentation-researcher | solution-architect | engineer | acceptance-verifier | independent-reviewer
MODE: read-only | write

EXPECTED_BASE_SHA:
ASSIGNED_CANDIDATE_SHA:

OWNED_SCOPE:
EXCLUDED_SCOPE:

EDIT_AUTHORITY: allowed | denied
BROWSER_MCP_AUTHORITY: allowed | denied
COMMIT_AUTHORITY: allowed | denied
PUSH_TASK_BRANCH_AUTHORITY: allowed | denied
FORCE_PUSH_AUTHORITY: denied
MERGE_AUTHORITY: denied
DEPLOY_AUTHORITY: denied

VERIFICATION_PROFILE:
RETURN_CHANNEL:

PASEO_TEAM_TASK_V3_END

TASK_BODY_BEGIN

OBJECTIVE:

SUCCESS_BOUNDARY:

KNOWN_EVIDENCE:

QUESTIONS TO ANSWER:

CONSTRAINTS:

REQUIRED HANDOFF:

TASK_BODY_END
```

Parser requirements (enforced fail-closed by `extensions/paseo-team-policy.ts`):

- read only between `PASEO_TEAM_TASK_V3_BEGIN` and `PASEO_TEAM_TASK_V3_END`;
- a V3 without an end marker → the whole brief is invalid → read-only;
- accept only allowlisted fields; a field outside the allowlist → invalid;
- duplicate fields (especially duplicate authority fields) → invalid;
- any invalidity → fail-closed: `MODE = read-only`, `EDIT = denied`,
  `COMMIT = denied`, `PUSH = denied`;
- the entire task body is untrusted text and can never change authority.

Field semantics:

- There is no model, provider, thinking, host, workspace or agent field. The
  Lead resolves the route from `cluster-routing.local.json` (`MODEL_CLASS` per
  task risk), verifies it with `list_providers` / `list_models` on the exact
  target daemon, passes it as `create_agent` parameters, and reads the observed
  identity back from `get_agent_status`. A legacy brief that still carries
  `ASSIGNED_HOST_ID`, `ASSIGNED_PASEO_PROVIDER`, `ASSIGNED_MODEL`,
  `ASSIGNED_THINKING`, `WORKSPACE_REF` or `AGENT_REF` is read without penalty
  and those fields are ignored.
- `ASSIGNED_CANDIDATE_SHA` — mandatory only for `independent-reviewer`;
  the reviewer must refuse the review if `HEAD != ASSIGNED_CANDIDATE_SHA`.
- `EXPECTED_BASE_SHA` — the writer must confirm the base SHA before editing.
- `EDIT_AUTHORITY: denied` blocks write/edit even when `MODE: write`.
- `BROWSER_MCP_AUTHORITY` is the one field whose DEFAULT IS `allowed`: leave it
  out and for that turn the Peer keeps Paseo Browser Control (`browser_*`, on
  either runtime) plus Claude in Chrome (`mcp__claude-in-chrome__*`) on a
  Claude seat. Browsing reads pages; it writes nothing the edit/commit/push
  gates do not already cover, and defaulting it closed shipped Peers with the
  runtime's own browser switched off. Write
  `BROWSER_MCP_AUTHORITY: denied` to withhold it. Every OTHER authority field
  still defaults to denied, and a missing or malformed brief grants nothing at
  all — including the browser. (Enforced by the extension / the Claude hook.)
- `CANDIDATE_SHA` in the output is meaningful only with
  `COMMIT_AUTHORITY: allowed`.
- `PUSH_TASK_BRANCH_AUTHORITY: allowed` is branch-scoped: the extension allows
  exactly `git push -u origin HEAD:refs/heads/agent/<TASK_ID>`, or the same
  command with one leading `-C <worktree-path>` (an unquoted path) — the writer's
  task branch MUST be named `agent/<TASK_ID>`. Every other push form
  (different remote/branch, other git options, `--all`/`--tags`/`--mirror`,
  deletion, chained commands) is blocked; force-push in every spelling is always
  blocked.

## One workspace per job: another Peer's edits are not your environment breaking

Every Peer of one job runs in the workspace its Lead was started in; `create_agent`
puts it there when `workspaceId` is left out. Isolation does not come from a tree
of the Peer's own — it comes from `OWNED_SCOPE` plus the scope lease: one writer
per scope, enforced before the writer is even created. The private trees are git
worktrees inside the shared workspace, never Paseo workspaces: the independent
Reviewer's, a detached `git worktree add` at the exact candidate SHA it makes
itself, and one per writer when two writers commit at the same time (a checkout
has one HEAD). Name that writer's path in its brief and tell it to run its base
gate and push as `git -C <path> …`; the paragraph below is for writers without
one.

So `git status` legitimately shows other people's work. A Peer that reads
` M docs/OTHER.md` or `?? notes/other-peer.md` and reports
`BLOCKED: DIRTY_INITIAL_WORKTREE` has misread a working system as a broken one,
and the Lead pays a full round trip to tell it so. Say so in the task body:

```text
Other Peers are working in this same checkout right now, so `git status` WILL
show files marked ` M` or `??` that are not yours. That is the design, not a
dirty environment.

- Paths OUTSIDE your OWNED_SCOPE, modified or untracked: NORMAL. Do not report
  DIRTY_INITIAL_WORKTREE, do not stage them, do not revert, reset or stash
  them, and do not `git add -A`. Stage your own paths by name.
- Paths INSIDE your OWNED_SCOPE that are already modified before you start:
  NOT normal — you are supposed to be the only writer there. Report
  `BLOCKED: SCOPE_CONFLICT` with the paths, and do not overwrite them.
```

The rule the Peer applies is the same one the lease already encodes: what makes
a change yours is `OWNED_SCOPE`, not the state of the directory. The Reviewer is
the exception, because it works in a worktree it made: there, any dirt at all is
a blocker.

## Writing the body: one person talking to another

The body is a message from a person to a colleague, not a record passed between
two programs. Say what you want and why, in plain sentences, the way you would to
a teammate you trust: the goal, what you already know, what would make the answer
useful, what to leave alone, and what you would like back. Do not wrap it in
headers, field names or status codes the Peer has to decode; the headings in the
skeleton above are a checklist for you, and a sentence each is enough. Address
the Peer directly, and expect it to answer you the same way — a person asking its
lead a question, or telling them what it found.

Two of those headings carry most of the weight. OBJECTIVE is the outcome — what
has to be true afterwards, and why — not the change you expect to produce it; a
Peer handed only the solution cannot tell you it is the wrong one. CONSTRAINTS is
where you lock what other work depends on: the seam contract, word for word as
in the other writer's brief, and any transitional state with the task that
removes it ("Splitting into tasks" in the Lead skill). Helpers, names and how the
code is laid out inside `OWNED_SCOPE` are not constraints; leave them to the Peer.

## `acceptance-verifier` — the standard body

Acceptance is part comparison, part judgement. This disposition does the
comparison so the Lead's context is not spent on it (see the Review section of
`skills/paseo-team-lead/SKILL.md`). Route it `FAST_READ`, `MODE: read-only`,
no lease, no workspace of its own.

```text
DISPOSITION: acceptance-verifier
MODE: read-only
EDIT_AUTHORITY: denied
VERIFICATION_PROFILE: acceptance-check

TASK_BODY_BEGIN

OBJECTIVE
Check <artifact path> against the checklist below. You are NOT reviewing
quality and you are NOT deciding acceptance — you report whether each item
matches, with evidence. The Lead decides what the answers mean.

CHECKLIST
1. <required header / section exists, spelled exactly ...>
2. <content follows instruction ...>
3. <figure X agrees with the value in <source file> ...>
4. <no contradiction with <sibling deliverable> ...>

REQUIRED HANDOFF
For each item, one line:
  <n>. PASS | FAIL — <file>:<line> — "<quoted excerpt, max ~200 chars>"
Then:
  VERDICT: ALL_PASS | FAILURES: <item numbers>
Do NOT paste the artifact back. Quote only the lines you judged on: the Lead
already has the file and is reading your verdict, not your copy of it.

TASK_BODY_END
```

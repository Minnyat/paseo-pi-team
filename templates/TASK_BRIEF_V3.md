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

MUST HOLD:

ALREADY DECIDED:

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
  exactly `git push -u origin HEAD:refs/heads/agent/<TASK_ID>` — the writer's
  task branch MUST be named `agent/<TASK_ID>`. Every other push form
  (different remote/branch, `--all`/`--tags`/`--mirror`, deletion, chained
  commands) is blocked; force-push in every spelling is always blocked.

## One workspace per job, one worktree per writer

Every Peer of one job runs in the workspace its Lead was started in; `create_agent`
puts it there when `workspaceId` is left out. A writer does not edit that
workspace's primary checkout: it makes its own `git worktree` under
`.worktrees/<TASK_ID>` — plain git, so Paseo shows nothing new — and the checkout
you and the Human are on stays where it was. Who may touch which files is still
`OWNED_SCOPE` plus the scope lease (one writer per scope, enforced before the
writer is even created); the worktree decides whose HEAD, index and branch a
commit lands on. The independent Reviewer does the same, detached at the
candidate SHA.

The Peer has no other source for the commands, so put them in the body, in your
own words:

```text
Please don't work in the main checkout: other Peers share this workspace. Make
your own worktree from the base and do everything there (the first line keeps it
out of the Human's `git status`):

  grep -qx '/.worktrees/' "$(git rev-parse --git-path info/exclude)" || echo '/.worktrees/' >> "$(git rev-parse --git-path info/exclude)"
  git worktree add -b agent/<TASK_ID> .worktrees/<TASK_ID> <EXPECTED_BASE_SHA>

Keep it under the workspace root (a shell outside it restarts in the workspace on
every call). Run git as `git -C .worktrees/<TASK_ID> …`; the push is exactly
`git -C .worktrees/<TASK_ID> push -u origin HEAD:refs/heads/agent/<TASK_ID>`, or
the same without `-C` once you have `cd`'d into the worktree.
Only touch your OWNED_SCOPE. When the work is committed and reported, remove the
tree from the workspace root with `git worktree remove .worktrees/<TASK_ID>` (no
--force): the branch keeps the commits, and review runs from the SHA in a tree of
its own, not from yours.
```

A relative `-C` path inside the workspace is the one `-C` the push guard accepts.
Files modified in the primary checkout belong to somebody else: what makes a
change a Peer's is `OWNED_SCOPE`, not the state of a directory.

## Writing the body: one person talking to another

The body is a message from a person to a colleague, not a record passed between
two programs. Say what you want and why, in plain sentences, the way you would to
a teammate you trust: the goal, what you already know, what would make the answer
useful, what to leave alone, and what you would like back. Do not wrap it in
headers, field names or status codes the Peer has to decode; the headings in the
skeleton above are a checklist for you, and a sentence each is enough. Address
the Peer directly, and expect it to answer you the same way — a person asking its
lead a question, or telling them what it found.

### Requirement, or a choice you made?

`MUST HOLD` is what is true however the work is done: "the brake stops the bike
within Y metres", "the public API does not change", "tests are not edited".
`ALREADY DECIDED` is an approach you picked — "use a parachute" — plus what it
rests on. Keep them apart. A choice dressed as a requirement is invisible to the
Peer: it will optimize inside it without ever asking whether it was right, and
every Peer after it inherits the choice as if it were a fact of the world. Give
`ALREADY DECIDED` its evidence, or leave the item out and ask it under
`QUESTIONS TO ANSWER`. The Peer may challenge anything in it, with the evidence,
using `peer_ask_lead` kind `reopen`.

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

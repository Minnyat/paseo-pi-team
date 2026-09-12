# Workspace Protocol — example

Place this file at `WORKSPACE_PROTOCOL.md` in the ROOT of the repo being
orchestrated by the team. It is the hard contract between the Human, the Lead,
and the Peers; the project's preflight may read it to validate values.

The root is the only path the Lead is told to read (`prompts/lead.md`, invariant
1, and `skills/paseo-team-lead/SKILL.md`), and it is where both the deep dive
(`docs/demonthorn-agent-orchestration-deep-dive.md` §6) and Paseo's own
Foundation put it. Earlier revisions of this template named
`.orchestration/WORKSPACE_PROTOCOL.md`; a protocol left there is read by nobody
and reports nothing, so move it to the root rather than expecting a fallback.

Readership is part of the contract: the Lead reads it in full before
orchestrating, a Peer never does — the Lead extracts the relevant constraints
into the Peer's V3 brief — and the Supervisor reads it only under a governance
mandate to create, audit or update it.

```text
WORKSPACE_PROTOCOL_VERSION: 1

PROJECT_ID:
PROJECT_CRITICALITY: low | medium | high
DEFAULT_BRANCH:
REPOSITORY_REMOTE:

LEAD_WRITE_POLICY: denied
MERGE_OWNER: human | named-integration-owner
DEPLOY_OWNER: human | external-system

REQUIRED_DOCUMENTS:
- AGENTS.md
- docs/architecture.md
- <other sources>

TEST_COMMANDS:
FAST_TEST:
FULL_TEST:
TYPECHECK:
LINT:
FORMAT_CHECK:
INTEGRATION_TEST:

HUMAN_DECISION_BOUNDARIES:
- product behavior changes
- public API break
- schema migration with irreversible effect
- secret or infrastructure mutation
- deployment
- cost above configured budget

MODEL_POLICY:
MONITOR_ECONOMY:
FAST_READ:
CODING_MEDIUM:
REASONING_HIGH:
REVIEW_HIGH:

MACHINE_TOPOLOGY:
PRIMARY_HOST: win-primary
REVIEW_HOST: mac-review

HOST_CAPABILITY_REQUIREMENTS:
- writers require git-write and focused-test
- reviewers require git-read and independent-review
- Docker tasks require docker
- integration tasks require integration-test

GIT_POLICY:
ONE_WRITER_PER_MOVING_SCOPE: true
WRITER_WORKTREE_REQUIRED: true
TASK_BRANCH_PATTERN: agent/<task-id>
FORCE_PUSH: denied
PEER_MERGE: denied
PEER_DEPLOY: denied

REVIEW_POLICY:
LOW_RISK:
MEDIUM_RISK:
HIGH_RISK:
EXACT_SHA_REQUIRED: true
FRESH_REVIEW_WORKSPACE: true
REVIEWER_MUST_BE_NEW_SESSION: true

ACCEPTANCE_EVIDENCE:
- candidate SHA
- clean worktree
- required test output
- independent review when required
- residual risks
- Human decision where required

FAILURE_RECOVERY:
- do not reassign a writer until old workspace Git state is known
- daemon failure does not imply agent produced no commit
- restore from last stable SHA
- never infer remote endpoint or credential
```

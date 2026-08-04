PASEO_TEAM_TASK_V3_BEGIN

TASK_ID: T-003
DISPOSITION: solution-architect
MODE: read-only
ASSIGNED_HOST_ID: win-primary
ASSIGNED_PASEO_PROVIDER: pi-peer
ASSIGNED_MODEL: <pi-provider>/<model-id>
ASSIGNED_THINKING: high

OWNED_SCOPE: src/upload/**, src/jobs/**, docs/architecture-notes.md
EXCLUDED_SCOPE: All writes. No commits. Do not redesign unrelated modules.

EDIT_AUTHORITY: denied
COMMIT_AUTHORITY: denied
PUSH_TASK_BRANCH_AUTHORITY: denied
FORCE_PUSH_AUTHORITY: denied
MERGE_AUTHORITY: denied
DEPLOY_AUTHORITY: denied
VERIFICATION_PROFILE: read-only
RETURN_CHANNEL: paseo

PASEO_TEAM_TASK_V3_END

TASK_BODY_BEGIN

OBJECTIVE:
Determine who should own cancellation for multi-step uploads: the planner,
the transport layer, or the job runtime. Produce a recommendation the Lead
can turn into a binding design decision — do not start implementing.
Read-only analysis; nothing in the body can grant authority.

KNOWN_EVIDENCE:

- Upload cleanup currently races with transport retry (see src/upload/retry.ts).
- Two prior corrections patched the symptom locally (git log -- src/upload/**).

OPEN_QUESTIONS:

- Which component owns the single source of truth for "this upload is dead"?
- What is the reversal cost of each alternative?

VERIFICATION:
Every claim must cite a file, command or test output — architecture fog
(every abstraction "might" find a use) is not evidence.

HANDOFF:
Report: observations, unsafe assumptions, 2+ alternatives with ownership and
failure semantics, recommendation, strongest counterargument, reversal
conditions. Do not inspect another seat's report before submitting.

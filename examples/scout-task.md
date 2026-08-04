PASEO_TEAM_TASK_V3_BEGIN

TASK_ID: T-004
DISPOSITION: repository-scout
MODE: read-only
ASSIGNED_HOST_ID: win-primary
ASSIGNED_PASEO_PROVIDER: pi-peer
ASSIGNED_MODEL: <pi-provider>/<model-id>
ASSIGNED_THINKING: low

OWNED_SCOPE: The repository (shared workspace).
EXCLUDED_SCOPE: All writes.

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
Map the ownership boundaries of the checkout flow so the Lead can decide
whether the discount recalculation belongs to an existing owner. Deliver a
factual inventory, not an opinion.

KNOWN_EVIDENCE:

- Suspected owners: src/checkout/**, src/pricing/**, src/discount/**.
- The docs mention a "two-pass discount allocation" without pointing at code.

OPEN_QUESTIONS:

- Which module recalculates order-level discounts today?
- Is the two-pass behavior one function or a cross-module protocol?

VERIFICATION:
List the exact commands used to build the inventory (grep/find/list calls)
so the Lead can spot-check coverage.

HANDOFF:
Report FILES_READ, a per-module ownership table (owner, entry points,
lifecycle hooks), unresolved ambiguities as OPEN_QUESTIONS. No
recommendation beyond what the evidence shows.

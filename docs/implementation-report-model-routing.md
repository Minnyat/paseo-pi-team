# Implementation Report — Model Routing Role Pack (2026-08-04)

```text
IMPLEMENTATION_REPORT

SUMMARY:
  POC đã nâng thành role pack có model routing kiểm chứng được: resolver
  stateless + preflight (chạy xanh live trên host thật, 20 checks, exit 0),
  cấu hình 4 lớp, chu trình routing 13 bước bắt buộc cho Lead, hợp đồng
  candidate sạch, và 4 lỗi correctness đã sửa kèm regression test.
  4 commit: 96a3314 (phase 3 correctness), 1b89885 (style), f5feb20
  (phase 4+5 model routing), a740ff3 (examples RESOLVED_*).

ROOT_CAUSES_FIXED:
  1. peerMode là module-level mutable chỉ update khi parse được
     → quyền write leak sang turn sau khi brief thiếu/hỏng.
     FIX: re-parse strict từ prompt mỗi before_agent_start; thiếu
     header/MODE hỏng → read-only (fail-closed). Regression lifecycle test.
  2. engineer-task vừa cấm commit/push vừa bắt report candidate SHA.
     FIX: V2 authority fields; commit/push denied mặc định; force-push/merge/
     deploy chặn vĩnh viễn cho peer; bash guard ở extension.
  3. Formatter làm dirty worktree phá exact-SHA review (issue #3).
     FIX: contract format→test→commit→porcelain rỗng→push; reviewer dùng
     fresh checkout, refuse tree dơ, không normalize whitespace mặc định.
  4. Supervisor MCP guard chỉ block khi target là string không-danh-sách
     → input không-string/shape lạ bypass.
     FIX: classifyMcpInput fail-closed; meta-ops whitelist; unknown future
     target → block; Lead cũng có target allowlist + mcp_script heuristic scan.
  5. Lead policy quá rộng (write/edit + 60 Paseo tools).
     FIX: minimal default (read/bash + orchestration + permissions triage);
     write/edit opt-in PASEO_TEAM_LEAD_WRITE=1. respond_to_permission giữ
     vì thiếu nó workflow deadlock khi peer xin quyền.

FILES_ADDED:
  config/model-routing.example.json, config/hosts.example.json,
  scripts/model-routing.mjs, scripts/preflight.mjs,
  test/model-routing.test.mjs, docs/model-routing.md, docs/multi-host.md,
  examples/architect-task.md, examples/scout-task.md

FILES_CHANGED:
  extensions/paseo-team-policy.ts (4 fix), prompts/{lead,peer,supervisor}.md,
  skills/paseo-team-lead/SKILL.md (routing cycle + V2 + contract),
  examples/{engineer-task,reviewer-task}.md (V2 + authority),
  README.md (structure/routing/compat/preflight), .gitignore (local-config
  guards), scripts/install.{ps1,sh} (pin adapter + preflight step),
  config/paseo.providers.json → config/paseo.providers.example.json (rename),
  test/policy.test.mts (+lifecycle regression)

MODEL_FLOW_BEFORE:
  prompt khuyên "gọi list_providers/list_models"; Lead tự do chọn/không
  truyền model; không observed-check; thinking không valid không ai phát
  hiện (Paseo clamp âm thầm về medium).

MODEL_FLOW_AFTER:
  MODEL_CLASS → route host-local → validate inventory (list_providers/
  list_models) → exact "pi-peer/<pi-provider>/<model-id>" +
  settings.thinkingOptionId → create_agent → get_agent_status runtimeInfo
  so khớp → lệch/thiếu → BLOCKED, archive agent sai. Mọi quyết định ghi
  ROUTING_DECISION đầy đủ requested+observed.

PI_SETUP:        per host, docs/model-routing.md Lớp 1 (models.json template
                 pi, không commit auth.json/apiKey).
PASEO_PROFILE_SETUP: 3 role profile duy nhất (pi-supervisor/lead/peer),
                 config/paseo.providers.example.json; model KHÔNG pin vào
                 profile (quyết định có lý do, ghi trong docs).
PEER_MODEL_TRANSMISSION: exact string first-slash + thinking riêng —
                 source-verified (mcp-shared.js) + LIVE VERIFIED:
                 paseo run --provider "pi-peer/Minnyat/deepseek-v4-flash"
                 --thinking low → inspect: Provider/Model/Thinking khớp.
LEAD_MODEL_BOOTSTRAP:  paseo run --provider "pi-lead/<...>" --thinking <lvl>
                 (verified flag set qua --help + live run cùng format).
SUPERVISOR_MODEL_BOOTSTRAP: cùng format với pi-supervisor + MONITOR_ECONOMY;
                 complex recovery → REASONING_HIGH (ghi trong docs).

HOST_ROUTING:
  hosts.local.json (capabilities/limits/endpointEnv), composite refs
  <host>/<agent-id> và repo@sha, flow 6 bước, remote qua `paseo --host
  "$ENV"` CLI (Lead), recovery không spawn writer đôi. Cross-host live test
  còn MANUAL (chỉ có 1 host lúc implement).

TEST_COMMANDS:
  node test/policy.test.mts          → PASS (gồm lifecycle multi-turn)
  node test/model-routing.test.mjs   → PASS
  npx tsc --noEmit -p tsconfig.json  → OK
  node scripts/preflight.mjs         → 20 checks, exit 0 (live host)
  node scripts/preflight.mjs --json  → machine-readable, ok:true
  paseo run exact-model smoke        → runtimeInfo khớp (live)
  paseo run bogus-model negative     → Status: error, không fallback (live)
  pi --provider ... --model ... --thinking ... -p "PONG"  → PONG (live)

TEST_RESULTS: tất cả PASS/PASS/OK/exit 0 như trên; không tuyên bố gì chưa chạy.

MANUAL_TESTS_REQUIRED:
  - Cross-host test plan đủ 6 bước (docs/multi-host.md) — cần máy thứ hai.
  - LLM e2e: Lead thật chạy routing cycle 13 bước + ghi ROUTING_DECISION
    trong một task thật (prompt-level behavior, không unit-test được).
  - Multi-slash model ID end-to-end trên host có model dạng
    vendor/scoped/name (hiện host chỉ có 1 slash; logic roundtrip đã
    unit-test + source-verified).

ISSUE_1_STATUS:  Đề xuất close khi Human confirm: adapter đã pin
  2.19.0 (install scripts + README + preflight warn khi khác bản), matrix
  tương thích có trong README. Đánh giá fork maintained = việc còn lại.
ISSUE_2_STATUS:  KEEP-OPEN: giữ luồng proxy (quyết định mục 1 của issue đã
  chốt); guard fail-closed target đã vá + regression test. Câu hỏi mở về
  Paseo set lifecycle/toolPrefix trong mcp config vẫn là upstream item.
ISSUE_3_STATUS:  Đề xuất close sau khi Human confirm: handoff clean-worktree
  đã vào SKILL.md + examples + reviewer refuse contract; formatter pass đã
  được chuẩn hóa vào quy trình (format→test→commit→clean).
NEW_ISSUES_RECOMMENDED:
  - "Pin/test: quan sát thực tế Paseo 0.2.5 clamp thinking không hợp lệ về
    medium" (upstream Paseo — có thể là bug report hợp lệ).
  - "Cross-host live test (6 bước) cần host thứ hai".

UNRESOLVED_RISKS:
  - U1 cơ chế Lead-spawn-remote-agent hiện là `paseo --host` qua bash của
    Lead; chưa live-test 2 host (multi-Lead mặc định cho quan hệ lâu dài).
  - U3 Paseo Hub federation chưa khảo sát — không chặn kiến trúc hiện tại.
  - runtimeInfo của provider tương lai không fill → verifyObserved
    fail-closed sang MODEL_RESOLUTION_MISMATCH (đúng hướng, nhưng có thể
    nhiễu nếu Paseo đổi snapshot).
  - Bash guards là heuristic (ghi rõ trong code), không phải sandbox.

MIGRATION_STEPS:
  1. git pull role pack; chạy scripts/install.{sh,ps1}.
  2. pi install npm:pi-mcp-adapter@2.19.0 (nếu khác bản).
  3. Copy + điền ~/.paseo-pi-team/model-routing.local.json từ
     `paseo provider models pi-peer --json`; (N-host: hosts.local.json +
     env endpoint).
  4. node scripts/preflight.mjs → exit 0.
  5. V1 brief vẫn chạy; Lead nên phát brief V2; lưu ý Lead mặc định mất
     write/edit (PASEO_TEAM_LEAD_WRITE=1 nếu protocol cho phép tự implement).

NEXT_ACTION:
  Human review 4 commit (96a3314, 1b89885, f5feb20, a740ff3) trên PR,
  confirm để merge; lên lịch cross-host live test khi có máy thứ hai.
  KHÔNG merge/deploy/close issue khi chưa được phép.
```

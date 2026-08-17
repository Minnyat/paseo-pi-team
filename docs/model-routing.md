# Model Routing — cấu hình, truyền và xác minh model

Tài liệu này mô tả kiến trúc model routing bốn lớp và cách vận hành **không
silent fallback**. Mọi command trong file đã chạy thật trên Paseo 0.2.5 +
Pi 0.83.0 + pi-mcp-adapter 2.19.0 (Windows host `desktop-m1a2r16`,
2026-08-04) trừ khi ghi khác đi.

## Bốn lớp

```text
Lớp 1  Pi model inventory (per host, KHÔNG commit)
         pi install, ~/.pi/agent/auth.json, credential env,
         ~/.pi/agent/models.json (custom provider/model), extension/package
              │
Lớp 2  Paseo role profiles (commit template) — ĐÚNG 3 profile:
         pi-supervisor / pi-lead / pi-peer (extends "pi", chỉ env PASEO_PI_ROLE)
              │
Lớp 3  Logical model classes (commit, trong repo):
         MONITOR_ECONOMY | FAST_READ | CODING_MEDIUM | REASONING_HIGH | REVIEW_HIGH
              │
Lớp 4  Host-local route (KHÔNG commit):
         ~/.paseo-pi-team/model-routing.local.json
         CLASS → { paseoProvider, model: <pi-provider>/<model-id>, thinking }
```

**Quyết định có chủ đích:** không pin danh sách model vào Paseo provider
profile (dù `ProviderOverrideSchema.models` của Paseo 0.2.5 hỗ trợ). Lý do:
catalog model là host-specific; pin vào config chung sẽ cần một profile mỗi
model và nhân bản secret của môi trường lên repo. Model được chọn ở Lớp 4
và truyền exact lúc `create_agent`.

## Vì sao routing phải strict — ba silent-fallback đã xác minh

1. **Paseo ép thinking không hợp lệ về `medium` một cách âm thầm.**
   `PiRpcAgentClient.createSession` gọi
   `normalizePiThinkingOption(input) ?? "medium"` — truyền `thinking: "turbo"`
   chạy êm ở mức medium. Nguồn: `server/agent/providers/pi/agent.js`.
2. **Paseo `list_models` cho pi báo cả 7 thinking options cho mọi model
   `reasoning: true`**, bất kể `thinkingLevelMap` trong
   `~/.pi/agent/models.json`; pi docs nói rõ entry `null` nghĩa là level
   không được hỗ trợ và bị **clamp** (hidden/skipped/clamped away).
   → preflight cross-check `thinkingLevelMap` và cảnh báo.
3. **`--model` của pi là pattern** (docs pi, hỗ trợ `provider/id` và
   partial match). Model ID không chính xác có thể khớp model khác.
   → luôn truyền exact `provider/id`.

Cùng lắp ráp lại, **cơ chế bảo vệ là: pre-validate (list_models) + post-verify
(observed runtimeInfo)**. Khi model không tồn tại, pi fail với status `error`
(không rơi về model khác — đã verify live); nhưng thinking clamp và pattern
match **không** báo lỗi, nên observed-check là bắt buộc.

## Chu trình bắt buộc của Lead (13 bước)

Xem `skills/paseo-team-lead/SKILL.md` → "Implementation — model routing
cycle". Tóm tắt: `MODEL_CLASS` → route local → `list_providers` →
`list_models` → exact string → `create_agent(provider=..., settings=
{thinkingOptionId})` → `get_agent_status` → bounded poll đến khi `runtimeInfo` xuất hiện → so khớp
`runtimeInfo`. Identity chưa populate trong timeout là
`BLOCKED: STARTUP_IDENTITY_UNAVAILABLE` và không archive; chỉ identity đã xuất
hiện nhưng lệch mới là `BLOCKED: MODEL_RESOLUTION_MISMATCH` và archive agent sai.

## Transmission format (đã xác minh bằng source Paseo 0.2.5)

```text
create_agent.provider = "<role-profile>/<pi-provider>/<model-id>"
```

Paseo tách ở **dấu `/` đầu tiên** (`resolveRequiredProviderModel`,
`server/agent/mcp-shared.js`):

```text
"pi-peer/Minnyat/deepseek-v4-flash"      → provider=pi-peer, model=Minnyat/deepseek-v4-flash
"pi-peer/openrouter/vendor/model-name"   → provider=pi-peer, model=openrouter/vendor/model-name
```

Thinking truyền riêng qua `settings.thinkingOptionId`
(pi levels: `off|minimal|low|medium|high|xhigh|max`).

## Bootstrap command đã verify live

```bash
# Human/Supervisor/Lead/Peer chạy trực tiếp, local daemon:
paseo run -d --provider "pi-peer/Minnyat/deepseek-v4-flash" --thinking low \
  --title "routing-smoke" "Reply with exactly: PONG"
# → inspect cho kết quả khớp:
paseo inspect <agent-id> --json
#   Provider=pi-peer | Model=Minnyat/deepseek-v4-flash | Thinking=low

# Đối chứng âm tính (model không tồn tại → error, KHÔNG silent fallback):
paseo run -d --provider "pi-peer/Minnyat/no-such-model" --thinking low "..."
paseo inspect <agent-id> --json   # → Status: error, Model vẫn hiển thị giá trị sai

# Direct pi CLI smoke test (kiểm pi inventory độc lập với Paseo):
pi --provider Minnyat --model deepseek-v4-flash --thinking low -p "Reply with exactly: PONG"

# Remote daemon (bootstrap remote — endpoint từ env, không ghi vào file):
paseo run --host "$PASEO_HOST_B" --provider "pi-peer/<pi-provider>/<model-id>" \
  --thinking high -d "<prompt>"
```

Supervisor/Lead bootstrap với exact model dùng đúng chuỗi trên với profile
`pi-supervisor` / `pi-lead` và `MODEL_CLASS` tương ứng
(`MONITOR_ECONOMY` cho supervisor normal observation, `REASONING_HIGH` cho
Lead orchestration — Workspace Protocol có thể nới xuống cho task routing
nhỏ). Lead model và Peer model không cần giống nhau; writer và reviewer ưu
tiên session + model resolution độc lập.

## Resolver + preflight

```bash
node scripts/model-routing.mjs validate                 # schema của route local
node scripts/model-routing.mjs resolve --class CODING_MEDIUM --json
node scripts/preflight.mjs [--json] [--skip-models]     # full host check
```

Mã lỗi fail-closed (không bao giờ fallback):

```text
CONFIG_INVALID                 route file lỗi schema/đọc được nhưng sai
ROLE_PROVIDER_UNAVAILABLE      role profile thiếu/vô hiệu trên daemon
MODEL_UNAVAILABLE              exact model không có trong list_models
THINKING_OPTION_UNAVAILABLE    thinking level model không offer
STARTUP_IDENTITY_UNAVAILABLE   runtimeInfo chưa xuất hiện trong startup timeout
MODEL_RESOLUTION_MISMATCH      observed runtime identity ≠ requested
HOST_ROUTE_UNAVAILABLE         class không có route trên host này
```

## Ranh giới secret

- Không commit: `model-routing.local.json`, `cluster-routing.local.json`,
  `~/.pi/agent/{auth.json,models.json}`, `~/.paseo/config.json`, pairing URL,
  mọi endpoint có credential.
- `cluster-routing.local.json` chỉ tham chiếu endpoint qua **tên env var**
  (`connection.endpointEnv`); giá trị tcp://...?password=... nằm trong
  environment.
- Preflight chỉ báo env var có tồn tại hay không, không in giá trị.

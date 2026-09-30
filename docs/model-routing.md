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
         → với endpoint OpenAI-compatible: `pteam models sync` dựng lại file này
           (probe thật từng model; cờ `reasoning` suy từ câu trả lời, không đoán
           theo tên — đoán sai là Paseo báo thinkingOptions "none" và chặn mọi
           route trên mức off). Cấu hình ở ~/.paseo-pi-team/pi-models.local.json.
              │
Lớp 2  Paseo role profiles (commit template) — ĐÚNG 6 profile,
       một cho mỗi (family, vai trò):
         pi-supervisor / pi-lead / pi-peer          (extends "pi")
         claude-supervisor / claude-lead / claude-peer (extends "claude")
       cả sáu chỉ khác nhau ở env PASEO_PI_ROLE (+ disallowedTools bên claude)
              │
Lớp 3  Logical model classes (commit, trong repo):
         bắt buộc:  MONITOR_ECONOMY | FAST_READ | CODING_MEDIUM | REASONING_HIGH | REVIEW_HIGH
         tuỳ chọn:  SUPERVISOR_GOVERNANCE (route *-supervisor) | LEAD_RECOVERY (route *-lead)
              │
Lớp 4  Host-local route (KHÔNG commit):
         ~/.paseo-pi-team/model-routing.local.json
         CLASS → { paseoProvider, model, thinking }
         model và thinking theo family của paseoProvider:
           pi     → "<pi-provider>/<model-id>", off|minimal|low|medium|high|xhigh|max
           claude → "<model-id>" (một đoạn),    off|low|medium|high|xhigh|max|ultracode
         Một route có thể ở family này, route kế bên ở family kia, trên cùng máy.
```

Danh sách model của từng role provider đọc bằng `pteam models` (một lần
`provider ls` + một lần `provider models` mỗi family) hoặc
`pteam models --provider <role-provider>` để thấy kèm `thinkingOptionIds`.
Form định tuyến trong WebUI gợi ý đúng danh sách đó và giới hạn mức thinking
theo family — nhưng gợi ý không phải thẩm quyền: `resolveRoute` lúc preflight
mới là chỗ fail-closed.

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

## Cổng route cho `create_agent` — routing được ép bằng code

Trước đây routing chỉ là quy ước: policy kiểm HÌNH DẠNG của `create_agent`
(có đoạn model, có `settings.thinkingOptionId`, có `settings.modeId`, có
`labels.purpose`, có `team.cluster`) nhưng không so provider/model/thinking với
route file. Một Lead có thể dựng Peer — và Supervisor dựng Lead — trên bất kỳ
model nào parse được. Cổng route đóng lỗ hổng đó, trong `policy-core.ts`, dùng
chung cho cả hai runtime (adapter Pi và hook Claude).

**Mỗi `create_agent` của Lead hoặc Supervisor** phải khai lớp model trong
`labels["team.model-class"]`, và phải khớp route của lớp đó **trên máy này**:

| So sánh | Quy tắc |
|---|---|
| provider head | viết đúng chữ thường, không khoảng trắng (`Claude-Peer`, ` claude-peer` bị từ chối kèm cách viết đúng); family+role phải bằng route (seat `claude-peer-audit` tính là claude/peer) |
| model | bằng `route.model` từng byte |
| thinking | `settings.thinkingOptionId` bằng `route.thinking` từng byte (Paseo âm thầm chạy level lạ ở `medium`) |

Thông báo từ chối luôn nêu giá trị mong đợi (`Expected provider "…" with
settings.thinkingOptionId "…"`). Provider không parse được bị từ chối, không
bao giờ bị bỏ qua.

**Lớp theo luồng** — mỗi luồng có lớp riêng để ghế quản trị và ghế khôi phục
không bao giờ mượn route của Peer:

| Luồng | Lớp được khai |
|---|---|
| Lead → Peer (hoặc Lead) | `MONITOR_ECONOMY`, `FAST_READ`, `CODING_MEDIUM`, `REASONING_HIGH`, `REVIEW_HIGH` |
| Lead → Supervisor | `SUPERVISOR_GOVERNANCE` |
| Supervisor → Lead (recovery) | `LEAD_RECOVERY` |

**Một lớp route tới provider `*-supervisor` không dùng được để dựng Peer.** File
mẫu route `MONITOR_ECONOMY` tới `pi-supervisor` (giám sát thường ngày của
Supervisor do Human dựng), nên Lead dựng Peer với `MONITOR_ECONOMY` bị từ chối
`ROUTE_PROVIDER_MISMATCH` — muốn dùng lớp đó cho Peer thì route phải trỏ tới một
provider `*-peer`. Cùng lý do, lớp route tới `*-lead` không dựng được Peer.

**Hai lớp tuỳ chọn.** `SUPERVISOR_GOVERNANCE` và `LEAD_RECOVERY` không bắt buộc
trong route file — mọi file viết trước khi có chúng vẫn hợp lệ, preflight chỉ
cảnh báo. Khi luồng cần lớp chưa cấu hình, cổng từ chối
`ROUTE_CLASS_UNCONFIGURED` và nêu lệnh cấu hình
(`pteam routing set <CLASS> --provider <family>-<role> --model <id> --thinking <level>`).
Cổng **không** rơi về lớp khác: rơi âm thầm sang route khác chính là lỗi mà cả
repo này tồn tại để ngăn (xem mục ba silent-fallback ở trên). Validator còn bắt
`SUPERVISOR_GOVERNANCE` trỏ tới provider `*-supervisor` và `LEAD_RECOVERY` tới
`*-lead`.

**Cổng đọc file nào.** `create_agent` qua MCP luôn rơi vào daemon LOCAL, nên
cổng cần route của đúng một máy — máy này:

1. có `cluster-routing.local.json` → host DUY NHẤT có `connection.type: "local"`;
   không có host local nào → xuống bước 2; từ hai host local trở lên → từ chối
   (`LOCAL_HOST_AMBIGUOUS`);
2. ngược lại `model-routing.local.json`.

File không đọc được / sai schema, hoặc không có file nào → **fail-closed**: mọi
`create_agent` của Lead/Supervisor bị từ chối (`ROUTE_TABLE_UNAVAILABLE`) kèm
đường dẫn file. Cluster file sai **không** bao giờ khiến cổng quay sang đọc file
đơn-host. `pteam routing show` cho biết cổng đang đọc file nào.

**Opt-out duy nhất: `PASEO_TEAM_ROUTE_ENFORCE=off`** — đúng chuỗi `off`; mọi giá
trị khác (`OFF`, `0`, gõ sai) vẫn là bật. Chỉ dành cho khẩn cấp, không bao giờ là
mặc định, và được làm cho **ồn ào**: mỗi lượt của Lead/Supervisor trên cả hai
runtime nhận một khối cảnh báo, preflight báo WARN (FAIL với `--strict`),
`pteam routing show/check` gắn cờ.

Ngoài phạm vi cổng: lệnh `run` của wrapper remote (tạo agent trên host remote)
và Lead gọi thẳng `paseo` CLI từ bash — hai đường này không đi qua
`create_agent` MCP.

## Cập nhật route bằng CLI

```bash
pteam routing show [--json]      # route hiệu lực theo lớp; đánh dấu lớp tuỳ chọn chưa đặt
pteam routing check [--json]     # phần routing của preflight: schema + resolve strict với daemon
pteam routing set <CLASS> --provider <role-provider> --model <id> --thinking <level> [--host-id <id>]
pteam routing unset <CLASS> [--host-id <id>]   # chỉ SUPERVISOR_GOVERNANCE / LEAD_RECOVERY
```

`set` kiểm route mới bằng `resolveRoute` ở chế độ **strict** với inventory sống
của daemon local (như `preflight --strict`) và **không ghi gì** nếu route không
resolve được. Mỗi lần ghi: chép file cũ sang `<file>.bak-<epoch>` rồi ghi
nguyên tử (file tạm + rename). Không có `--host-id`: sửa đúng file và host mà
cổng đọc. `--host-id <id>`: sửa host đó trong `cluster-routing.local.json`; host
`remote` bị từ chối vì inventory của nó nằm ở daemon khác — chạy lệnh trên chính
host đó, hoặc sửa file rồi `pteam preflight --strict --host-id <id>`. Thư mục
cấu hình theo cùng biến ghi đè với các lệnh khác (`PST_TEAM_CONFIG_DIR` /
`PASEO_TEAM_HOME`).

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
node scripts/model-routing.mjs gate-routes              # route table mà cổng create_agent đọc (JSON)
node scripts/model-routing.mjs resolve --class CODING_MEDIUM --json
node scripts/preflight.mjs [--json] [--skip-models]     # full host check
```

Mã lỗi fail-closed (không bao giờ fallback):

```text
CONFIG_INVALID                 route file lỗi schema/đọc được nhưng sai
ROLE_PROVIDER_UNAVAILABLE      role profile thiếu/vô hiệu trên daemon
MODEL_UNAVAILABLE              exact model không có trong list_models
THINKING_OPTION_UNAVAILABLE    thinking level model không offer, HOẶC model
                               tự khai không hỗ trợ extended thinking mà route
                               lại xin một level khác "off"
STARTUP_IDENTITY_UNAVAILABLE   runtimeInfo chưa xuất hiện trong startup timeout
MODEL_RESOLUTION_MISMATCH      observed runtime identity ≠ requested
HOST_ROUTE_UNAVAILABLE         class không có route trên host này
```

Mã từ chối của cổng `create_agent` (tiền tố `BLOCKED:`):

```text
ROUTE_CLASS_MISSING            thiếu labels["team.model-class"]
ROUTE_CLASS_UNKNOWN            tên lớp không tồn tại
ROUTE_CLASS_WRONG_FLOW         lớp không thuộc luồng (vd. Lead dựng Supervisor bằng lớp của Peer)
ROUTE_CLASS_UNCONFIGURED       lớp (thường là lớp tuỳ chọn) chưa có route trên host
ROUTE_TABLE_UNAVAILABLE        route file thiếu / sai / mơ hồ — fail-closed
ROUTE_UNVERIFIABLE             không nạp được route table
ROUTE_PROVIDER_UNKNOWN         provider không phải role provider
ROUTE_PROVIDER_NONCANONICAL    provider viết hoa / có khoảng trắng
ROUTE_PROVIDER_MISMATCH        family+role khác route
ROUTE_MODEL_MISMATCH           model khác route
ROUTE_THINKING_MISMATCH        thinking khác route
```

## Ba trạng thái của extended thinking

`list_models` có thể nói ba điều khác nhau về thinking, và resolver phân biệt
đủ ba — gộp trạng thái 2 vào trạng thái 3 chính là lỗi đã loại hẳn model rẻ
nhất (`claude-peer/claude-haiku-4-5`) khỏi mọi route strict:

| Daemon trả về | `thinkingValidated` | Kết quả |
|---|---|---|
| Có option list, chứa level yêu cầu | `exact` | pass |
| Có option list, KHÔNG chứa level | — | `THINKING_OPTION_UNAVAILABLE` |
| `thinkingSupported: false`, hoặc option list RỖNG (có mặt nhưng trống — đúng cách Haiku 4.5 tự khai) | `unsupported` | pass **chỉ khi** `thinking: off`; level khác → `THINKING_OPTION_UNAVAILABLE` |
| Không nói gì cả, route xin `thinking: off` | `off` | pass (kể cả `--strict`: không có gì để xác minh) |
| Không nói gì cả, route xin level khác | `unverifiable` | warn; `--strict` → FAIL |

Hai dòng cuối là ranh giới thật sự: **"không biết"** vẫn fail-closed như cũ,
còn **"biết chắc là không có"** là một sự kiện đã xác minh, không phải một
khoảng trống. Daemon nên công bố `thinkingSupported: false` một cách tường
minh; resolver chấp nhận cả option list rỗng như cùng một tuyên bố viết dưới
dạng dữ liệu.

## Provider `available` ≠ có model dùng được

`list_providers` báo `available` là nói về PROVIDER, không nói gì về inventory.
Đã quan sát thấy `pi-peer` báo `available` nhưng `list_models` trả về mảng rỗng
— provider trông như tồn tại, phía sau không có gì route được. Luôn gọi
`list_models` trước khi định tuyến; `node scripts/preflight.mjs` nay tự làm
việc này cho mọi role provider khỏe mạnh và cảnh báo (FAIL với `--strict`) khi
inventory rỗng.

## Ranh giới secret

- Không commit: `model-routing.local.json`, `cluster-routing.local.json`,
  `~/.pi/agent/{auth.json,models.json}`, `~/.paseo/config.json`, pairing URL,
  mọi endpoint có credential.
- `cluster-routing.local.json` chỉ tham chiếu endpoint qua **tên env var**
  (`connection.endpointEnv`); giá trị tcp://...?password=... nằm trong
  environment.
- Preflight chỉ báo env var có tồn tại hay không, không in giá trị.

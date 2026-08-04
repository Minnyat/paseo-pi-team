# Multi-host (N host) — routing và vận hành

Thiết kế N-host của role pack. Không có tên máy nào được hard-code trong
core logic; mọi host là một entry trong config host-local.

## Tài nguyên thiết kế

Mỗi host được mô tả bởi sáu trường (trong `~/.paseo-pi-team/hosts.local.json`,
template tại `config/hosts.example.json`):

```text
HOST_ID               định danh duy nhất (trùng hostId trong model-routing.local.json)
ENDPOINT_ENV          TÊN env var chứa endpoint pair (không lưu value)
CAPABILITIES          ['git-read', 'git-write', 'docker', 'integration-test', 'focused-test', 'independent-review', ...]
TRUST_ZONE            nhãn vùng tin cậy (ghi trong WORKSPACE_PROTOCOL; extension không ép)
RESOURCE_LIMITS       { writers, readers } — trần concurrency
MODEL_ROUTES          ~ nội dung của model-routing.local.json trên host đó
```

`HOST_ID = "local"` là đặc biệt: daemon mà Lead nói chuyện qua MCP server
được inject (không cần endpoint).

## Luồng host routing (mandatory order)

1. **Filter hard constraints** — loại host thiếu capability bắt buộc
   (writer scope cần `git-write`; cross-host review cần candidate
   `PUSHED_REMOTE` reachable từ reviewer host).
2. **Daemon reachable** — với host remote: `paseo status --host $ENV --json`
   (không reachable → `HOST_ROUTE_UNAVAILABLE`, KHÔNG rơi về host khác
   ngầm nhiên; chuyển host phải là routing decision được ghi lại).
3. **Repository availability** — repo/project tồn tại trên host (workspace
   source path) hoặc clone/pull được.
4. **Model route hợp lệ trên host đó** — đọc `model-routing.local.json`
   của host đích (preflight host-local), list_models trên đúng daemon.
5. **Concurrency** — `limits.writers/readers`; một moving scope chỉ một
   writer toàn cụm, không phải chỉ một writer mỗi host.
6. **Chọn host và ghi routing evidence** (xem ROUTING_DECISION trong
   SKILL.md).

## Cơ chế tạo agent trên daemon khác

MCP server được inject vào pi agent **luôn trỏ daemon local** của agent đó
(xác minh bằng source Paseo 0.2.5: `daemon.mcp.injectIntoAgents` tạo mcp
config ở `createPiMcpConfigFile` với URL daemon của chính daemon cha).
Vì vậy với host remote, Lead dùng **chính Paseo CLI qua bash**:

```bash
# Endpoint value NẰM TRONG ENV (ví dụ PASEO_HOST_B), hosts config chỉ tên:
paseo status  --host "$PASEO_HOST_B" --json
paseo provider ls --host "$PASEO_HOST_B" --json
paseo provider models pi-peer --host "$PASEO_HOST_B" --json
paseo run     --host "$PASEO_HOST_B" -d \
  --provider "pi-peer/<pi-provider>/<model-id>" --thinking <level> \
  --workspace <wks-id> --title "<title>" "<prompt>"
```

CLI chấp nhận `host:port`, socket/pipe, `tcp://host:port?ssl=true&password=...`
hoặc pairing offer URL (xem `paseo run --help`). Credential của endpoint sống
trong env, không trong file.

> Lưu ý bảo mật policy: policy extension hiện chặn Peer dùng `paseo` CLI từ
> bash (heuristic) và cho Lead quyền `bash`. Lead dùng CLI cho remote được
> coi là đường orchestration chính thức — vẫn qua control plane Paseo, không
> phải control plane thứ hai.

**Multi-Lead vẫn là phương án mặc định cho quan hệ chặt lâu dài**: một Lead
mỗi daemon, Supervisor quan sát chéo và Human phối hợp portfolio. Cross-host
từ một Lead nên dành cho pattern nhẹ (reviewer host riêng, runner host riêng).

## Composite reference

```text
AGENT_REF      <host-id>/<agent-id>                    (vd: local/9cb42327-..., host-b/3fa8b20a)
WORKSPACE_REF  <host-id>/<workspace-id>
CANDIDATE_REF  <repository-url>@<commit-sha>
```

`CANDIDATE_REF` độc lập host: git SHA là điểm neo duy nhất giữa writer và
reviewer nằm hai host — vì vậy cross-host review **bắt buộc**
`COMMIT_AUTHORITY: allowed` + `PUSH_TASK_BRANCH_AUTHORITY: allowed` trong
brief của Engineer, và reviewer dùng fresh clone/fetch tới đúng SHA.

## Failure & recovery

- **Daemon remote chết giữa task** → không tự spawn writer thay thế khi
  trạng thái writer cũ chưa rõ (có thể đã commit). Quy trình: đánh dấu
  HOST_ROUTE_UNAVAILABLE, chờ daemon quay lại, đối chiếu `git log`/`status`
  của workspace trên host đó, mới quyết định recreate + carry-over.
- **Writer không phản hồi** → Lead check qua `--host` trước khi tuyên bố
  mất; nếu daemon sống mà agent kẹt → cancel_agent/archive_agent trên đúng
  daemon đó rồi handoff scope (commit SHA cuối cùng = progress checkpoint).
- **Endpoint env mất** → preflight warn; routing tới host đó là BLOCKED,
  không suy đoán endpoint từ lịch sử.

## Cross-host test plan (MANUAL — cần máy thứ hai)

Trạng thái: **chưa chạy** (chỉ có một host tại thời điểm implement).
Khi có host thứ hai, chạy đủ chuỗi sau và ghi kết quả vào issue liên quan:

1. `node scripts/preflight.mjs` PASS trên cả hai host (riêng biệt).
2. Host A: đặt `PASEO_HOST_B=tcp://<ip>:6767?ssl=true&password=...`;
   `paseo status --host "$PASEO_HOST_B" --json` reachable.
3. Host B cài role pack với `model-routing.local.json` khác host A (đúng
   mục đích: N host có model mapping khác nhau).
4. Lead (host A) spawn reviewer trên host B:
   Engineer (A) được cấp COMMIT+PUSH → push task branch tới remote chung
   → reviewer (B) clone/fetch đúng `CANDIDATE_SHA`, refuse nếu HEAD ≠ SHA.
5. Kill daemon host B giữa task writer → Lead báo `HOST_ROUTE_UNAVAILABLE`,
   không spawn writer thứ hai cùng scope.
6. `unknown` env endpoint → routing bị BLOCKED, không fallback về local.

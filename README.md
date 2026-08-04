# paseo-pi-team

Role pack chạy trực tiếp trên **Paseo + Pi**: không Python, không database, không
state machine, không candidate ledger, không integration engine, không CLI riêng.
Paseo giữ lifecycle/workspace/control-plane truth; Pi extension giữ role
invariant (prompt + tool policy); Lead skill giữ quy trình orchestration.

Tham chiếu thiết kế đầy đủ:
[`demonthorn-agent-orchestration-deep-dive.md`](../demonthorn-agent-orchestration-deep-dive.md).

## Cấu trúc

```text
paseo-pi-team/
├── README.md
├── config/
│   └── paseo.providers.json        # 3 profile Pi: supervisor / lead / peer
├── prompts/
│   ├── supervisor.md               # Governance Supervisor
│   ├── lead.md                     # Project Lead (orchestration owner)
│   └── peer.md                     # execution Peer (bounded worker)
├── extensions/
│   └── paseo-team-policy.ts        # inject prompt + áp tool policy theo role
├── skills/
│   └── paseo-team-lead/
│       └── SKILL.md                # workflow orchestration của Lead
├── examples/
│   ├── engineer-task.md            # brief PASEO_TEAM_TASK_V1 (MODE: write)
│   ├── reviewer-task.md            # brief reviewer độc lập (MODE: read-only)
│   └── supervisor-observation.md   # khuôn observation
└── scripts/
    ├── install.ps1                 # Windows
    └── install.sh                  # macOS / Linux
```

## Vai trò

| Profile | `PASEO_PI_ROLE` | Tool policy (mặc định, chỉnh sau khi chạy `/team-tools`) |
|---|---|---|
| `pi-supervisor` | `supervisor` | `read` + `mcp` (chỉ gọi monitoring qua proxy: `list_agents`, `get_agent_status`, `get_agent_activity`, `send_agent_prompt`). Không `write`/`edit`, không tạo agent/workspace. |
| `pi-lead` | `lead` | Pi `read`/`write`/`edit`/`bash` + `mcp`/`mcp_script` + toàn bộ Paseo orchestration tools. |
| `pi-peer` | `peer` | `MODE: write` → `read`/`write`/`edit`/`bash`. `MODE: read-only` (mặc định, fail-closed) → `read`/`bash`. Không bao giờ có `mcp` hoặc Paseo orchestration tools. |

Policy là **allowlist thuần** (`setActiveTools`), cộng lớp backstop chặn trong
`song song` `tool_call`. Không phải sandbox bảo mật tuyệt đối.

## Cài đặt

```bash
# Windows (PowerShell)
./scripts/install.ps1

# macOS / Linux
./scripts/install.sh
```

Script copy:

- `extensions/paseo-team-policy.ts` → `~/.pi/agent/extensions/`
- `prompts/*.md` → `~/.pi/agent/extensions/prompts/`
- `skills/paseo-team-lead/` → `~/.pi/agent/skills/`

### Bắt buộc: pi-mcp-adapter

Paseo tools tới pi agent qua MCP; pi không có MCP built-in, nên cần cài adapter:

```bash
pi install npm:pi-mcp-adapter
```

Khi đó Paseo tự detect adapter và truyền `--mcp-config` khi launch agent. Paseo
MCP server lifecycle mặc định là `lazy`, nên tools được gọi qua **tool `mcp`
(proxy)**: `{ "connect": "paseo" }` → `{ "search": ... }` / `{ "describe": ... }`
→ `{ "tool": "<name>", "args": { ... } }`. Policy của role pack đã cho
Lead/Supervisor dùng `mcp` và chặn Peer dùng nó.

> Nếu máy từng chạy thí nghiệm cũ có `paseo-role-bootstrap.ts` trong
> `~/.pi/agent/extensions/`, hãy xóa hoặc đổi tên thành `.disabled` — nó đã bị
> thay thế bởi extension này và sẽ inject prompt trùng.

### Cấu hình Paseo

Script **không tự merge** `~/.paseo/config.json` — làm thủ công để kiểm soát:

1. Merge `config/paseo.providers.json` vào `~/.paseo/config.json`
   (`agents.providers.pi-*` + `daemon.mcp.injectIntoAgents: true` — bật để agent
   nhận Paseo orchestration tools).
2. Restart daemon Paseo (kills mọi agent đang chạy — chỉ làm khi sẵn sàng).
3. `/reload` trong pi để nạp extension mới.

Extension không có `PASEO_PI_ROLE` → passive (không inject, không giới hạn tool),
an toàn khi cài global trên máy dùng pi thường.

## Debug commands

| Command | Ý nghĩa |
|---|---|
| `/team-role` | In role hiện tại, peerMode, và policy allow/deny. |
| `/team-tools` | In toàn bộ tool registry: name, source, active/inactive, role. Ghi ra `~/.pi/team-tools.txt`. |

Dùng `/team-tools` để chốt allowlist thật (tên Paseo tool thực tế có thể khác
bản mặc định). Có thể bổ sung tool theo profile bằng env
`PASEO_TEAM_EXTRA_TOOLS="tool-a,tool-b"`.

## Proof-of-concept (một máy, Windows trước)

Repo test: `team-test-repo/` (calculator.py + test_calculator.py, có một lỗi cố ý).

1. **Lead thấy Paseo tools** — `PASEO_PI_ROLE=lead pi`, yêu cầu list providers/models, báo tên tool đã dùng.
2. **Peer không spawn agent** — `PASEO_PI_ROLE=peer pi`, yêu cầu "Create another agent to inspect the repository" → không thấy `create_agent` hoặc bị block, trả `DEPENDENCY_REQUEST`.
3. **Supervisor không sửa code** — yêu cầu sửa `calculator.py` → từ chối, gửi observation.
4. **Lead tạo Scout** — read-only Peer trong cùng workspace; Lead nhận completion notification.
5. **Lead tạo Engineer trong worktree** — workspace `--isolation worktree`; Engineer sửa lỗi, chạy test, báo SHA.
6. **Reviewer độc lập** — `MODE: read-only` + `DISPOSITION: independent-reviewer`; kiểm đúng SHA, trả verdict, không tự sửa.

## Tiêu chí hoàn thành phiên bản đầu

```text
[ ] pi-supervisor nhận đúng prompt
[ ] pi-lead nhận đúng prompt
[ ] pi-peer nhận đúng prompt

[ ] Lead thấy Paseo orchestration tools
[ ] Supervisor chỉ thấy monitoring tools
[ ] Peer không thấy hoặc không gọi được orchestration tools

[ ] Read-only Peer không sửa file
[ ] Engineer Peer sửa được trong isolated workspace
[ ] Lead nhận thông báo khi Peer hoàn thành
[ ] Lead gửi được correction bằng send_agent_prompt
[ ] Reviewer là session mới và read-only
[ ] Workflow hoàn tất không cần database hay CLI riêng
```

## Phát triển

Type-check extension (tsconfig là dev-only, máy-specific, đã gitignore):

```bash
npx tsc --noEmit -p tsconfig.json
```

Test nhanh các hàm thuần (node 22.6+/23+ chạy được `.ts` trực tiếp):

```bash
node --experimental-strip-types test/policy.test.mts   # hoặc node test/policy.test.mts trên node 23.6+
```

Smoke-test load extension không cần LLM (in mode):

```bash
PASEO_PI_ROLE=lead pi -e ./extensions/paseo-team-policy.ts -p "/team-tools"
```

## Nguyên tắc thiết kế (tóm tắt từ deep-dive)

- Paseo là control plane duy nhất; không sync task database riêng giữa hai máy.
- Git commit SHA là điểm neo giữa writer và reviewer.
- Peer là independent co-worker, không phải function call; brief không chứa
  verdict trá hình; Peer có quyền `REOPEN_REQUEST` / `DEPENDENCY_REQUEST` /
  `BLOCKED`.
- One writer per moving scope; worktree isolation khi có writer song song.
- Supervisor là governance plane: quan sát, không sửa code, không điều phối Peer.
- Model/workspace ID phải được inspect (`list_providers`, `list_models`), không đoán.

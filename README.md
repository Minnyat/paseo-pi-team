# paseo-pi-team

Role pack chạy trực tiếp trên **Paseo + Pi**: không Python, không database, không
state machine, không candidate ledger, không integration engine, không CLI riêng.
Paseo giữ lifecycle/workspace/control-plane truth; Pi extension giữ role
invariant (prompt + tool policy); Lead skill giữ quy trình orchestration.

Tham chiếu thiết kế đầy đủ:
[`docs/demonthorn-agent-orchestration-deep-dive.md`](docs/demonthorn-agent-orchestration-deep-dive.md).

## Cấu trúc

```text
paseo-pi-team/
├── README.md
├── config/
│   ├── paseo.providers.example.json   # 3 profile Pi: supervisor / lead / peer
│   ├── model-routing.example.json     # template route MODEL_CLASS → model (copy per host)
│   └── cluster-routing.example.json   # template contract controller-local N-host
├── templates/
│   ├── TASK_BRIEF_V3.md               # canonical V3 task brief + parser rules
│   └── WORKSPACE_PROTOCOL.example.md  # .orchestration/WORKSPACE_PROTOCOL.md cho repo đích
├── prompts/
│   ├── supervisor.md               # Governance Supervisor
│   ├── lead.md                     # Project Lead (orchestration owner)
│   └── peer.md                     # execution Peer (bounded worker)
├── extensions/
│   └── paseo-team-policy.ts        # inject prompt + áp tool policy theo role
├── skills/
│   ├── paseo-team-lead/
│   │   └── SKILL.md                # workflow orchestration + routing cycle của Lead
│   └── paseo-ocr-reviewer/
│       └── SKILL.md                # read-only OCR delegation workflow của Reviewer
├── examples/
│   ├── engineer-task.md            # brief PASEO_TEAM_TASK_V3 (engineer, write)
│   ├── reviewer-task.md            # brief reviewer độc lập (read-only)
│   ├── architect-task.md           # brief solution-architect (read-only)
│   ├── scout-task.md               # brief repository-scout (read-only)
│   └── supervisor-observation.md   # khuôn observation
├── scripts/
│   ├── install.ps1 / install.sh    # installer
│   ├── model-routing.mjs           # stateless resolver: single-host + cluster (+ validate/resolve CLI)
│   ├── remote-paseo.mjs            # remote-host executor: Paseo CLI --host qua HOST_ID (Lead REMOTE cycle)
│   ├── reliability.mjs              # retry classification/backoff + stale predicates
│   ├── team-communication.mjs       # parent-scoped Peer → Lead messaging
│   ├── watchdog.mjs                 # observation-only running-agent watchdog
│   ├── ocr-review.mjs               # deterministic OCR exact-SHA preflight manifest
│   ├── team-scripts-path.mjs        # durable support-script path resolver
│   └── preflight.mjs                # host readiness check (--json, --strict, --host-id)
├── test/
│   ├── policy.test.mts             # policy + lifecycle regression
│   ├── model-routing.test.mjs      # resolver regression
│   ├── remote-paseo.test.mjs       # remote executor regression (+ fixtures/fake-paseo.mjs)
│   ├── reliability.test.mjs        # retry/backoff/stale predicates
│   ├── team-communication.test.mjs # parent-scoped Peer → Lead contract
│   ├── watchdog.test.mjs            # stale-agent classification
│   ├── ocr-review.test.mjs          # OCR delegation preflight contract
│   └── ocr-integrity.test.mjs       # skill/reference/authority integrity
└── docs/
    ├── demonthorn-agent-orchestration-deep-dive.md   # thiết kế gốc
    ├── model-routing.md            # 4 lớp model routing, verified commands
    ├── multi-host.md               # N-host routing + cross-host test plan
    └── ocr-integration.md          # OpenCodeReview Phase 1 single-machine setup
```

## Vai trò

| Profile | `PASEO_PI_ROLE` | Tool policy (mặc định, chỉnh sau khi chạy `/team-tools`) |
|---|---|---|
| `pi-supervisor` | `supervisor` | `read` + monitoring `mcp` + `team_watchdog` (observation-only); `create_agent` chỉ recovery Lead với argument guard. Không `write`/`edit`. |
| `pi-lead` | `lead` | Pi `read`/`bash` + Paseo discovery/workspace/monitoring/orchestration/permissions + `team_watchdog`. `write`/`edit` chỉ khi `PASEO_TEAM_LEAD_WRITE=1`. |
| `pi-peer` | `peer` | `MODE: write` → `read`/`write`/`edit`/`bash` + `peer_ask_lead`; `MODE: read-only` → `read`/`bash` + `peer_ask_lead`. Peer không có Paseo MCP/orchestration; browser MCP vẫn chỉ được cấp bằng V3 brief hiện tại. |

Policy là **allowlist thuần** (`setActiveTools`), cộng lớp backstop chặn trong
`song song` `tool_call`. Không phải sandbox bảo mật tuyệt đối. Mọi authority
được tính lại từ brief của **turn hiện tại**: chỉ marker block V3
(`PASEO_TEAM_TASK_V3_BEGIN` … `PASEO_TEAM_TASK_V3_END`) cấp được write mode hoặc
git authority; **legacy header `PASEO_TEAM_TASK_V1|V2` luôn resolve read-only**
(mọi `MODE` và `*_AUTHORITY` field bị bỏ qua — parser legacy từng quét toàn
prompt và là lổ hổng injection). `git commit`/`git push` qua bash của Peer bị
chặn trừ khi V3 brief cấp `*_AUTHORITY: allowed`; push authority là
**branch-scoped** (duy nhất `git push -u origin HEAD:refs/heads/agent/<TASK_ID>`);
force-push (mọi spelling: `-f`, `-uf`, `-fu`, `--force*`, refspec `+`) và merge
của Peer luôn bị chặn. `BROWSER_MCP_AUTHORITY` là grant theo current turn:
chỉ các target có prefix agent-browser và `connect/search` được scope vào
server `agent-browser`; agent-browser CLI qua bash luôn bị chặn. Paseo MCP và
MCP khác luôn bị chặn.

## Liên lạc và watchdog

### Peer hỏi Lead

Peer dùng custom tool `peer_ask_lead`, không dùng `paseo send` qua bash. Tool lấy `PASEO_AGENT_ID`, inspect `paseo.parent-agent-id`, chỉ gửi tới parent Lead và đóng gói `PEER_MESSAGE_V1` với `kind`, `TASK_ID`, `CORRELATION_ID`. Inspect có retry tối đa 3 lần với backoff chỉ cho lỗi transport tạm thời; `send` không retry vì delivery ambiguity có thể tạo duplicate. Các loại message: `question`, `blocked`, `dependency`, `progress`. Không resolve được parent là fail-closed, không broadcast.

### Lead/Supervisor kiểm tra agent treo

Custom tool `team_watchdog` kiểm tra agent `running` bằng `paseo ls -g` + `paseo inspect` với bounded concurrency (mặc định 6), global deadline (mặc định 30 giây), partial result khi hết hạn và retry transport tối đa 3 lần. Chỉ inspect thành công với `UpdatedAt` quá threshold (mặc định 5 phút) mới được đánh dấu `stale`/**suspected**; inspect thất bại là **unknown**, không tự cancel/archive/spawn.

Recovery bắt buộc: kiểm tra activity, pending permission, daemon/remote health, lệnh dài dự kiến và workspace/Git state; chỉ sau đó Lead quyết định cancel/archive/correction. Không tạo writer thay thế khi commit/state cũ chưa rõ.

### Transport retry

`remote-paseo.mjs` retry tối đa 3 lần cho thao tác đọc/health/provider/status; `run` và `send` không tự retry để tránh tạo duplicate task/message. Lỗi usage, authority, model, workspace, endpoint hoặc malformed request fail ngay.

## OpenCodeReview delegation (Phase 1)

`paseo-ocr-reviewer` is a strictly read-only Reviewer Peer skill. The
installer automatically installs and verifies the OCR CLI
`@alibaba-group/open-code-review` (capability-based: any installed release at
or above the verified `1.8.10` baseline that passes the delegation capability
probe is accepted as-is and never downgraded; when OCR is absent or
incompatible the installer installs the pinned `1.9.2`). OCR is not an
agent/provider or second control plane: it deterministically selects files and
resolves rules, while the Pi Reviewer performs reasoning on the exact candidate
SHA. The installer runs `scripts/ocr-setup.mjs` to install/verify the CLI;
check it manually with `ocr version` (PowerShell:
`Get-Command ocr`; Unix-like shells: `command -v ocr`) and use delegation mode,
not `ocr review`. See [`docs/ocr-integration.md`](docs/ocr-integration.md).

The optional deterministic preflight emits a normalized manifest:

```bash
node scripts/ocr-review.mjs --repo <repo> --base <base-sha> --candidate <candidate-sha>
```

It probes `delegate preview/rule` capabilities (recording the OCR version as
provenance, preferring `--format json` when the installed release supports it)
and blocks candidate mismatch, non-worktree review workspaces
(`REVIEW_WORKSPACE_NOT_WORKTREE` — the reviewer must run in a linked git
worktree, never a primary checkout or standalone clone), dirty/mutated
workspaces, unavailable/incompatible OCR, malformed selection/rules, and
incomplete rule coverage. Its manifest includes candidate-tree/workspace
entry-exit state and deterministic digests. It never edits Git state or calls
an LLM.

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
- `skills/paseo-team-lead/` → `~/.pi/agent/skills/paseo-team-lead/`
- `agent-browser` CLI + Chrome runtime (nếu thiếu), bundled skill → `~/.pi/agent/skills/agent-browser/`
- MCP entry `agent-browser: { command: "agent-browser", args: ["mcp"] }` → `~/.pi/agent/mcp.json` nếu chưa có ở các config chuẩn

### agent-browser browser MCP

Installer tự kiểm tra `agent-browser --version`, `agent-browser doctor --offline --quick`,
bundled skill (`agent-browser skills path agent-browser`) và các MCP config chuẩn.
Nếu thiếu, installer sẽ cài OCR `@alibaba-group/open-code-review` (bản pin
hiện tại `1.9.2`; bản đã cài `>= 1.8.10` qua được capability probe thì giữ
nguyên, không downgrade),
`npm install -g agent-browser`, chạy `agent-browser install`
(`--with-deps` trên Linux), copy skill, rồi merge entry `agent-browser` vào
`~/.pi/agent/mcp.json` mà không ghi đè server khác. Chạy lại installer là an toàn.

Lead cấp quyền cho Peer bằng field trong V3 brief:

```text
BROWSER_MCP_AUTHORITY: allowed
```

Mặc định là `denied`; quyền không lưu qua turn. Khi được cấp, Peer chỉ được
search/connect server `agent-browser` và gọi target prefix `agent_browser_` /
`agent-browser_` (cùng các prefix chuẩn hóa tương thích), không được dùng Paseo
MCP hoặc server khác. `node scripts/preflight.mjs --json` có các check CLI,
Chrome/runtime, skill và MCP entry.

### Paseo inspect contract test

Vì `peer_ask_lead` và watchdog phụ thuộc các field JSON do Paseo expose,
repo có contract test chạy với daemon thật. Test này không chạy trong CI thông
thường vì cần một agent đang tồn tại; chạy explicit với agent ID đã chọn:

```bash
PASEO_CONTRACT_AGENT_ID=<real-agent-id> node test/paseo-contract.test.mjs
```

Test kiểm tra agent xuất hiện trong `paseo ls -g --json` và các field
`Id`, `Status`, `UpdatedAt`, `PendingPermissions`, `ParentAgentId` trong
`paseo inspect --json`. Field thiếu hoặc schema đổi sẽ fail rõ ràng.

### Bắt buộc: pi-mcp-adapter (pinned)

Paseo tools tới pi agent qua MCP; pi không có MCP built-in, nên cần cài adapter
**đúng version đã verify**:

```bash
pi install npm:pi-mcp-adapter@2.19.0
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

1. Merge `config/paseo.providers.example.json` vào `~/.paseo/config.json`
   (`agents.providers.pi-*` + `daemon.mcp.injectIntoAgents: true` — bật để agent
   nhận Paseo orchestration tools).
2. Restart daemon Paseo (kills mọi agent đang chạy — chỉ làm khi sẵn sàng).
3. `/reload` trong pi để nạp extension mới.

Extension không có `PASEO_PI_ROLE` → passive (không inject, không giới hạn tool),
an toàn khi cài global trên máy dùng pi thường.

### Model routing (bắt buộc cho mọi create_agent)

Kiến trúc 4 lớp và cơ chế no-silent-fallback: xem
[`docs/model-routing.md`](docs/model-routing.md). Tóm gọn:

1. Per host (Lớp 1, không commit): pi + credential + `~/.pi/agent/models.json`
   nếu dùng custom provider.
2. Copy `config/model-routing.example.json` →
   `~/.paseo-pi-team/model-routing.local.json`, điền model THẬT của host lấy từ
   `paseo provider models pi-peer --json` (5 lớp: `MONITOR_ECONOMY`, `FAST_READ`,
   `CODING_MEDIUM`, `REASONING_HIGH`, `REVIEW_HIGH`).
3. Cross-host: copy `config/cluster-routing.example.json` →
   `~/.paseo-pi-team/cluster-routing.local.json` trên CONTROLLER — một file duy
   nhất mô tả connection/required/capabilities/limits/routes của mọi host;
   endpoint remote chỉ tham chiếu qua **tên env var**, không bao giờ chứa value.
   Xem [`docs/multi-host.md`](docs/multi-host.md). (Host registry
   `hosts.local.json` đã bị bỏ; cluster file là nguồn host duy nhất.)
4. Lead truyền exact model vào mọi `create_agent` dạng
   `pi-peer/<pi-provider>/<model-id>` + `settings.thinkingOptionId`, rồi đối
   chiếu `get_agent_status` runtimeInfo — lệch thì
   `BLOCKED: MODEL_RESOLUTION_MISMATCH`, không fallback. Lead (không phải Peer)
   sở hữu observed routing evidence.
5. **Host remote**: MCP inject vào agent luôn trỏ daemon LOCAL — `--host` là
   option CLI, không phải argument MCP. Lead dùng
   `<PASEO_TEAM_SCRIPTS_DIR>/remote-paseo.mjs` (installer copies the support
   scripts to `~/.pi/agent/extensions/paseo-team-scripts`; the environment
   variable is an optional override (the deterministic default is used after
   shell/daemon restart); it reads cluster file theo HOST_ID,
   chạy Paseo CLI
   `--host`, không in endpoint, trả JSON envelope có hostId) cho mọi thao tác
   remote: `health/providers/models/workspaces/workspace-create/run/status/
   send/cancel/archive` — xem `docs/multi-host.md` và Lead skill
   (LOCAL_CREATE_CYCLE vs REMOTE_CREATE_CYCLE).

### Compatibility matrix (đã verify 2026-08-04)

| Thành phần | Phiên bản | Ghi chú |
|---|---|---|
| Paseo CLI/daemon | 0.2.5 | `create_agent` schema, split-first-slash, runtimeInfo |
| Pi | 0.83.0 | `--model` (pattern), `--thinking` (7 levels), models.json |
| pi-mcp-adapter | 2.19.0 | **pinned**; lazy lifecycle, tool name có prefix `paseo_` |
| Node | ≥ 22.18 | type stripping sẵn có; test trên 25.9.0 |

### Preflight

```bash
node scripts/preflight.mjs            # human-readable
node scripts/preflight.mjs --json     # machine-readable, exit 1 khi có check fail
node scripts/preflight.mjs --strict --host-id <host-id>
                                      # cross-host gate: missing cluster config,
                                      # missing required remote endpoint env,
                                      # unverifiable thinking → FAIL (không warn-as-pass)
```

Kiểm: node/git/paseo/pi + version pin, daemon, adapter (pin), extension,
role prompts, 3 role providers, routing config (single-host + cluster
contract), từng route so với inventory thật, provider status, model segment
rỗng, `thinkingLevelMap` per-model của pi (level `null` = bị clamp),
endpoint env, trạng thái repo (writer host phải sạch trong strict mode).
Không in secret.

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
[x] pi-supervisor nhận đúng prompt
[x] pi-lead nhận đúng prompt
[x] pi-peer nhận đúng prompt

[x] Lead thấy Paseo orchestration tools (qua mcp proxy, 60 tools)
[x] Supervisor chỉ thấy monitoring tools (fail-closed allowlist)
[x] Peer không thấy hoặc không gọi được orchestration tools

[x] Read-only Peer không sửa file
[x] Engineer Peer sửa được trong isolated workspace
[x] Lead nhận thông báo khi Peer hoàn thành
[x] Lead gửi được correction bằng send_agent_prompt (đã xác minh supervisor → lead; cùng một tool)
[x] Reviewer là session mới và read-only
[x] Workflow hoàn tất không cần database hay CLI riêng
```

Kết quả POC Windows (2026-08-04, model Minnyat/deepseek-v4-flash): cả 6 test
đều PASS — T1 lead list providers/models qua mcp; T2 peer từ chối spawn agent
và trả REOPEN_REQUEST; T3 supervisor bị chặn sửa code (test đầu lộ lỗ hổng
terminal bypass qua mcp → đã vá bằng allowlist fail-closed) và route task cho
Lead bằng send_agent_prompt; T4 scout read-only + completion notification; T5
engineer trong worktree sửa 2 bug, test 3/3 pass, báo SHA, lead tự verify;
T6 reviewer độc lập REFUSED vì working tree dơ dù SHA khớp — ưu tiên protocol
hơn tiện lợi.

## Phát triển

Dev dependency pin trong `package.json` + `package-lock.json` (CI dùng đúng
lockfile này qua `npm ci`):

```bash
npm ci          # cài @earendil-works/pi-coding-agent, @types/node, typescript
npm test        # chạy toàn bộ test/*.test.{mjs,mts}
npm run typecheck   # tsc --noEmit -p tsconfig.ci.json
npm run check       # cả hai
```

Node **22.18+ hoặc 23.6+** chạy được `.ts`/`.mts` trực tiếp nhờ type stripping
bật sẵn. Chạy lẻ một suite khi cần khoanh vùng:

```bash
node test/policy.test.mts          # policy + per-turn lifecycle regression
node test/model-routing.test.mjs   # routing resolver regression
node test/remote-paseo.test.mjs    # remote executor regression (fake CLI)
node test/lib-common.test.mjs      # helper dùng chung: exec resolution, shim, version
```

`tsconfig.json` ở root là dev-only, máy-specific và đã gitignore; CI và
`npm run typecheck` dùng `tsconfig.ci.json` nằm trong repo.

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

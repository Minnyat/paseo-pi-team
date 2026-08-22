# Task: Build paseo-pi-team thành CLI + WebUI extension (WebUI chỉ gọi qua CLI)

## Original request (verbatim)
> repo paseo-pi-team sẽ build thành dạng cli. và webui như phần mở rộng được cài thêm cho cli đó để thao tác qua web còn mọi thứ vẫn call qua cli

(cảnh trước: thiết kế web-ui để cấu hình role prompts, mcp, skill. User chốt pattern CLI-as-truth + WebUI-extension only-talking-to-CLI.)

## Success criteria (observable)
- [x] Có `bin/` trong `package.json`, chạy được `paseo-team <subcommand> --json`.
- [x] CLI là "nguồn sự thật": mọi đọc/ghi config (providers, routing, cluster, mcp, prompts, skills, env) đều qua CLI, trả JSON.
- [x] CLI wrap được `scripts/preflight.mjs --json` (tái sử dụng, không copy logic).
- [x] WebUI extension: local server + SPA; KHÔNG đụng file trực tiếp — mọi request proxy sang spawn `paseo-team ...` và render JSON.
- [x] Smoke-test chạy được: `paseo-team --help`, `status`, `config read`, `prompts read` với HOME tạm.
- [x] Các test có sẵn `npm test` vẫn xanh (không phá vỡ hiện trạng).
- [x] Có `docs/webui-architecture.md` mô tả contract CLI ↔ WebUI.

## Constraints & decisions
- Zero external runtime deps cho cả CLI và webui server (chỉ `node:*`) để portability cao, repo vốn private + devDeps sẵn.
- READ back từ file hiện có; config WRITE qua stdin full-JSON → CLI tự backup + ghi atomic (không regex-patch).
- PHP/Node >= 22.18 theo `engines`.
- CLI delegate các script có sẵn (`preflight.mjs`, `install`, `ocr-*`) thay vì viết lại.
- Không đổi hành vi/API hiện có của `scripts/*` và các test. Chỉ thêm lớp CLI + webui.

## Plan
- [x] Step 1: anchor (TASK_STATE.md) + đọc phần còn lại (config-walker paths, mcp/prompts structure).
- [x] Step 2: `cli/lib/config-walker.mjs` — resolve đường dẫn (~/.pi, ~/.paseo, ~/.paseo-pi-team) + backup + atomic write + JSON validate.
- [x] Step 3: `cli/paseo-team.mjs` — router subcommand: help/status/preflight/config read|write/prompts read|write/skills list|read|write/env list|set/install. Mọi output `--json`.
- [x] Step 4: `bin` trong `package.json` + `scripts.web`.
- [x] Step 5: `webui/server.mjs` (zero-dep http) spawn CLI → REST proxy; `webui/public/` SPA (index.html/app.js/style.css).
- [x] Step 6: `docs/webui-architecture.md` — contract CLI↔WebUI, diagram, JSON schemas.
- [x] Step 7: smoke-test (--help, status, config read, prompts read, SPA tải) + `npm test` vẫn xanh + self-review.

## Open questions / risks
- Phạm vi "cấu hình skills" có cần copy ngược về repo (git diff) hay chỉ sửa local? → MVP: sửa local file ~/.pi; ghi ngược về repo là follow-up.
- Việc helper mcp.json / models.json merge có nên trong CLI? → MVP: đọc/ghi qua `config`; merge phức tạp (browser-setup; --attach-cdp-port) giao script có sẵn, webui nuôi qua `install --attach-cdp-port`.

## Log
- (bắt đầu) anchor; đã khảo sát scripts/preflight, model-routing, browser-setup, ocr-review, remote-paseo + package.json (chưa có bin), prompts/*.md, skills/SKILL.md, config/*.example.json, installer destinations (~/.pi/agent/extensions, /prompts, /skills, /mcp.json).
- (2026-08-21) Probe live Paseo CLI 0.3.0: xác nhận bề mặt `ls/inspect/permit/chat/logs/attach`; `inspect` có `ParentAgentId` + `PendingPermissions`. Tái hiện lỗi `paseo logs` timeout (`get_state`) với agent idle nguội -> timeline là dữ liệu có thể vắng, phải degrade chứ không crash.
- (2026-08-21) Mở rộng scope theo yêu cầu mới: thêm mặt phẳng **permission** (runtime permit vs policy authority) và **team graph** (trực quan hoá agent liên lạc). Viết `docs/webui-architecture.md` (contract CLI↔WebUI + schema graph + lộ trình PR-1..PR-5). Bước 6 xong; còn Bước 5 (webui server+SPA) và Bước 7 (smoke-test).
- (2026-08-21) MVP xong (PR-1 + PR-2 gộp). Thêm `cli/lib/paseo-bridge.mjs`, `cli/lib/graph-cache.mjs`, `cli/lib/graph.mjs`; CLI thêm `agents`/`agent inspect|send`/`permits`/`chat`/`graph`/`watchdog`/`web`; `webui/server.mjs` + SPA 6 tab (Dashboard, Team graph, Permissions, Roles, Config, Chat). 4 test file mới; `npm test` 17/17 xanh, typecheck sạch. Verify thật: daemon local 21 agent, 7 cạnh spawn, đã render trong Chrome.
- (2026-08-21) Đo chi phí thật: mỗi lệnh `paseo` ~3.0-3.5s (chi phí khởi động tiến trình, không phải query); `graph` lạnh ~12s, ấm ~3.8s; `preflight` ~25-30s (phải cho timeout riêng 180s, đã tái hiện timeout ở trình duyệt khi dùng chung 60s). Vì `paseo ls` không trả parent, cây spawn phải cache (`~/.paseo-pi-team/graph-cache.json`, TTL 15', tối đa `--max-inspect` lần inspect mỗi lượt).
- (2026-08-21) Còn lại: cạnh **message** giữa agent (`graph --with-logs`, parse `PEER_MESSAGE_V1` từ timeline Lead) và multi-host — xem PR-4/PR-5 trong docs/webui-architecture.md.
- (2026-08-22) Đặt tên ngắn cho CLI: thêm bin `pteam` (giữ alias `paseo-team`, cả hai trỏ `cli/paseo-team.mjs`; webui vẫn spawn theo path nên không phụ thuộc tên). Help text chuyển sang tiền tố `pteam`. README thêm mục "Run it straight from GitHub (no clone)": `npx --package github:Minnyat/paseo-pi-team pteam ...` / `npm i -g github:Minnyat/paseo-pi-team`. Lưu ý: lệnh GitHub chỉ thấy thay đổi sau khi commit + push.
- (2026-08-22) Tính năng version + update: version lấy từ `package.json` (bump 1.0.0, sửa lỗi status hardcode "0.1.0" lệch package.json 0.0.0); thêm `pteam --version|-v`, `pteam update [--check]` (`cli/lib/self-update.mjs`: so tag qua `git ls-remote` vì repo private — `npm view` không thấy; detect install mode checkout vs global-npm; update global = `npm i -g github:slug#tag`, checkout = trả lại `git pull` cho user; remote lỗi → degraded không crash). Thêm `repository.url` vào package.json. Test: `self-update.test.mjs` mới + block e2e trong `cli-contract` (fake git qua `PASEO_TEAM_GIT_EXEC` giống pattern `PASEO_TEAM_PASEO_EXEC`). 19/19 xanh. Lưu ý vận hành: cần push tag release (vd `v1.0.0`) thì `update` mới có gì để so.
- (2026-08-22) PR #11 + #12 đã merge, đã push tag `v1.0.0` — `pteam update --check` verify thật trả `upToDate: true`.
- (2026-08-22) Tính năng `pteam uninstall [--purge]` (`cli/lib/uninstall.mjs`): dao ngược đúng footprint của install — policy extension, đúng 3 file prompt trong thư mục dùng chung, đúng 3 skill dir của pack (kể cả agent-browser), `extensions/paseo-team-scripts/`, và remove đúng entry `mcpServers["agent-browser"]` khỏi mcp.json (ghi lại bằng atomicWrite có backup; entry tool khác giữ nguyên). Mặc định GIỮ `~/.paseo-pi-team/` vì chứa permit-audit log; `--purge` mới xoá. Idempotent (chạy lại báo missing, vẫn exit 0). Output JSON kèm hướng dẫn gỡ binary (`npm rm -g` vs xoá checkout). Bump 1.1.0.
- (2026-08-22) OCR delegation review cho PR #13 (base 8e85d02, candidate f6eeb64, worktree cách ly + manifest + --verify sạch): PASS WITH FINDINGS. Đã fix 001 (mcp.json corrupt giờ báo `mcp-config-unreadable` + error, không đụng file), 002 (target bị lock (rmSync throw) báo `status:"failed"` per-target thay vì crash cả lệnh, summary thêm `failed`), 003 (docs ghi rõ agent-browser CLI + Chrome runtime ngoài phạm vi uninstall), 004 (lỗi thụt dòng test), 005 (assert `.bak-*` tồn tại sau khi ghi lại mcp.json). Thêm e2e case corrupt mcp.json.
- (2026-08-22) PR #13 merge + tag `v1.1.0` push, `update --check` verify upToDate.
- (2026-08-22) Dịch toàn bộ prompt sang tiếng Anh theo yêu cầu user: 3 role prompts (`prompts/supervisor.md`, `lead.md`, `peer.md`), `templates/TASK_BRIEF_V3.md` (parser requirements + field semantics), `templates/WORKSPACE_PROTOCOL.example.md` (intro), `examples/engineer-task.md`, `examples/supervisor-observation.md`. Giữ nguyên mọi định danh/marker/field name (`PASEO_TEAM_TASK_V3_*`, authority fields, `paseo-ocr-reviewer` — test ocr-integrity phụ thuộc). Skills + policy.ts vốn đã tiếng Anh. Bump **1.1.1** (PATCH — đổi nội dung prompt, không thêm/tháo tính năng; do user chốt, kèm quy tắc version: tính năng CLI mới = MINOR, fix/docs/content = PATCH, breaking change CLI/API = MAJOR; tag `v<version>` sau merge).
- (2026-08-22) PR #14 merge (cfd91d2) + tag `v1.1.1`; user cài global `npm i -g github:...` thành công 1.1.1 → phát hiện 2 vấn đề: (a) npm warn gitignore-fallback + tarball kèm đồ dev → PR #15 thêm `files` allowlist (82→49 file), merge + tag `v1.1.2`; (b) **bug thật**: `pteam update` global-mode fail `spawnSync npm ENOENT` trên Windows vì npm là `.cmd` shim mà spawnSync từ chối không shell. Fix trong `self-update.mjs` `npmExec()`: resolve shim → entry thật `npm-cli.js`, spawn bằng `process.execPath` (tái dùng `resolveWindowsCliExec` của lib-common, cùng pattern resolvePaseoExec). Unit test win32-only cho npmExec. Bump 1.1.3. Lưu ý bootstrap: bản 1.1.1/1.1.2 global không tự update được (chính là bản bị bug) — nâng một lần bằng `npm i -g github:Minnyat/paseo-pi-team#v1.1.3`, từ 1.1.3 `pteam update` hoạt động native.
- (2026-08-22) User gặp `EADDRINUSE` thô (stack trace) khi `pteam web --open` — do server WebUI cũ của phiên chạy ngầm chiếm 4321. Fix UX trong `webui/server.mjs`: (a) không `--port` → tự fall-forward 4321→4329 kiểu dev-server, mỗi lần nhảy in dòng "port N busy, trying N+1"; (b) có `--port` (quyết định của user) → fail một dòng thân thiện "port N already in use — WebUI may already be running (open URL), or pass --port <other>", không stack; `cmdWeb` bắt lỗi qua fail() thay vì để main().catch in stack. Lỗi listen khác → message kèm code `WEB_LISTEN_FAILED`/`WEB_PORT_BUSY`. Test: block busy-port mới trong webui-server.test (blocker port 0, assert fall-forward range + reject có code + message gợi ý --port). Smoke thật đủ 2 nhánh. Bump 1.1.4 (UX fix = PATCH).

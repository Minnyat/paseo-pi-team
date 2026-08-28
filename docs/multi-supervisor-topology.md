# Mở rộng topology: nhiều Supervisor, nhiều Lead, fork/handoff

Plan cho bước mở rộng từ mô hình hiện tại (1 Supervisor → 1 Lead → N Peer) sang
**N Supervisor ↔ N Lead ↔ N Peer**, cộng cơ chế fork/handoff context giữa các
Lead cùng vai.

Mọi quyết định ở §3 đều neo vào bằng chứng đo thật ở §1. Không mục nào dựa trên
suy đoán về khả năng của Paseo/Pi.

Môi trường đo: Windows, `paseo` 0.3.0 (daemon local, 21 agent thật), `pi` 0.84.2,
ngày 2026-08-27/28.

---

## 1. Bằng chứng đã đo

### 1.1 Fork + import context — HOẠT ĐỘNG

| Kiểm chứng | Kết quả |
|---|---|
| `pi --fork <session-id>` giữ nguyên context | ✅ hỏi lại codeword → trả đúng |
| Session gốc sau khi fork | ✅ không đổi 1 byte |
| `paseo import <session-id> --provider pi-lead` | ✅ ra agent Paseo thật |
| Context sống sót qua import | ✅ `paseo logs` hiện đủ lịch sử cũ |
| `PASEO_PI_ROLE` được inject sau import | ✅ agent tự nhận vai "Project Lead" |
| `ParentAgentId` của agent import | ✅ `null` → là root sẵn, không cần detach |
| Hiện trong `paseo ls -g` với prefix role | ✅ `pi-lead/...` → `inferRole()` chạy được, không phải sửa |
| Fork session do **Paseo quản lý** | ✅ chạy đúng y hệt phiên `pi` chạy tay |

### 1.2 Fork = copy file, KHÔNG tốn lượt LLM

So sánh cấu trúc file gốc và file fork:

- Bản fork **copy nguyên mọi entry**, giữ nguyên chuỗi `id`/`parentId` (5 entry
  đầu trùng id từng chữ với bản gốc).
- Header mới có `id` = session UUID mới, `timestamp` mới, và
  `parentSession` = **đường dẫn tuyệt đối tới file nguồn**.

⇒ Fork materialize được bằng **thao tác file thuần**: ghi header mới (UUIDv7) +
append nguyên các entry cũ. Không cần spawn `pi`, không tốn lượt LLM, gần như
tức thời kể cả với session lớn.

**Đã kiểm chứng end-to-end**: file fork tự dựng bằng script → `paseo import` →
agent trả lời đúng codeword kế thừa (`FALCON-9920, LEAD-L2`).

### 1.3 Model của agent import — SỬA ĐƯỢC, nhưng chỉ qua MCP

Khi import, model **không** lấy từ session mà lấy **phần tử đầu trong inventory
của provider**:

| Session nguồn | Provider import | Model nhận được |
|---|---|---|
| `Minnyat/deepseek-v4-flash` | `pi-lead` | `Minnyat/claude-opus-5` |
| `Minnyat/glm-5.2` | `pi-lead` | `Minnyat/claude-opus-5` |
| `Minnyat/deepseek-v4-flash` | `pi-peer` (không có `additionalModels`) | `Minnyat/claude-opus-5` |

(`paseo provider models pi-lead --json` → index 0 = `Minnyat/claude-opus-5`.)

**CLI không sửa được** — `import` không có `--model`, `agent update` chỉ có
`--name` / `--thinking` / `--label`, `send` không có override.

**MCP thì sửa được.** `update_agent { agentId, settings: { model, thinkingOptionId } }`
đổi model thật — đã đo: `config.model` và `runtimeInfo.model` cùng chuyển từ
`claude-opus-5` sang `glm-5.2`, và agent chạy tiếp đúng trên model mới.

⚠️ `persistence.metadata.model` **không** được cập nhật (giữ giá trị lúc tạo)
⇒ khi verify routing phải đọc `runtimeInfo.model`, không đọc `persistence`.

⇒ Đây **không còn là chặn đường**, nhưng là một bước bắt buộc: import xong phải
`update_agent` ép đúng route rồi mới verify.

> Hậu quả thật khi bỏ qua bước này: agent kẹt `claude-opus-5`, gateway trả `524`
> rồi `Stream ended without finish_reason` nhiều lần, không cách nào re-route
> bằng CLI, phải bỏ agent.

### 1.4 Paseo đã lưu sẵn mọi metadata cần thiết

`$PASEO_HOME/agents/<cwd-slug>/<agent-id>.json` chứa:

```jsonc
{
  "labels":      { "team.experiment": "copyfork" },     // đọc ngược được
  "config":      { "model": "Minnyat/glm-5.2" },
  "runtimeInfo": { "sessionId": "01a04613-…", "model": "…", "thinkingOptionId": "off" },
  "persistence": { "sessionId": "01a04613-…",
                   "nativeHandle": "C:\\…\\sessions\\…\\<ts>_<sessionId>.jsonl" }
}
```

⇒ **Không cần tự dựng registry.** `agentId ↔ sessionId ↔ file session ↔ labels ↔
model` đều có sẵn trong state file của Paseo. Đây là nguồn tốt hơn registry tự
ghi: không phụ thuộc extension có được nạp hay không, không có ghi đua.

(Chỉ `paseo ls`/`inspect` là không trả `labels`; `ls --label k=v` lọc được, và
state file đọc ngược được.)

### 1.5 Chat room — là bus N↔N thật

| Kiểm chứng | Kết quả |
|---|---|
| `author` của message | ✅ **UUID agent thật** + `authorName` → cạnh graph `confirmed`, không heuristic |
| Trường có sẵn | `replyTo`, `mentionAgentIds`, `mentionLabels`, `--since`, `--agent` filter |
| `@mention` với agent **idle** | ✅ **đánh thức** — idle → running sau **34ms** |
| `@mention` với agent **đang bận** | ✅ **xếp hàng, không mất** |
| `@mention` theo **label** | ❌ **không delivery** — control test bằng shortId thì thức ngay ⇒ `mentionLabels` chỉ là tokenizer |
| Membership / ACL của room | ❌ không có |
| 4 post đồng thời (trong 123ms) | ✅ không mất, không trùng, mỗi cái 1 timestamp ms riêng, **total order** |
| CAS / atomic claim | ❌ không có — cả 4 claim đều thành công |

⇒ Chat vừa là **sổ cái** vừa là **chuông cửa**. Bỏ được mô hình 2 lớp
"post room + send prompt trỏ tới room".

### 1.6 Giới hạn kích thước message (~32 KB, Windows)

`paseo chat post <room> <message>` nhận message **chỉ qua argv** — không có
`--message-file` / stdin.

| Kích thước | Kết quả |
|---|---|
| 4 000 / 10 000 / 32 000 ký tự | ✅ lưu đủ |
| 100 000 ký tự | ❌ `spawnSync … ENAMETOOLONG` |

Trần là giới hạn `CreateProcess` của Windows (~32767 ký tự cho cả command line);
Linux cao hơn nhiều ⇒ **protocol phải lấy trần của nền thấp nhất**.

⇒ `TEAM_MESSAGE_V1` cap payload **8 KB** (giữ nguyên cap đang có ở
`cli/paseo-team.mjs:401`), và **mọi bằng chứng lớn đi bằng con trỏ** (đường dẫn,
SHA, agent-ref) — diff/log/OCR manifest đều vượt trần nếu inline.

### 1.7 Chat không có trong MCP

Agent Lead thật `mcp {"connect":"paseo"}` → **60 tools**; search `"chat"` /
`"room"` / `"message"` đều không có kết quả. Đối chiếu code: `PASEO_TOOLS`
(`extensions/paseo-team-policy.ts:64-96`) không có tool chat nào.

⇒ Lead/Supervisor chạm chat **chỉ qua bash** — một bề mặt **policy không soi
được**: không gate room, không ép envelope, không audit. Quan sát phụ: agent tự
đoán sai cú pháp (`paseo chat send` thay vì `post`) ⇒ CLI trần là bề mặt dễ sai.

### 1.8 Peer bị chặn chat — invariant còn nguyên

`PASEO_CLI_RE` (`extensions/paseo-team-policy.ts:349`) có `chat` trong danh sách
subcommand, peer bị chặn Paseo CLI qua bash (dòng 1303-1309), và peer không có
MCP. ⇒ Peer **không** chạm được chat bằng đường nào.

### 1.9 Detach — một chiều, làm peer câm

- `paseo agent detach` xoá `ParentAgentId` → `null`, agent vẫn sống.
- **Không có lệnh nghịch đảo** ⇒ irreversible.
- Peer đã detach gọi `peer_ask_lead` → `PARENT_LEAD_UNAVAILABLE`, fail-closed
  ⇒ **peer câm, không escalate được**.
- Thứ tự gate: check brief V3 chạy **trước** resolve parent.
- **Docs Paseo nói rõ**: *"Detach is an explicit user action in the subagents
  track, not an agent tool"* và *"Do not … invoke CLI or wire-level detach
  operations."* ⇒ trong plan này detach là **thao tác của Human**, agent không
  được tự gọi.

### 1.10 Parentage là khai báo, không xác thực

Set `PASEO_AGENT_ID=<id-lead>` trong env của shell rồi `paseo run` → agent mới
nhận `ParentAgentId = <id-lead>`, dù lead đó **không hề tạo nó**.

- Lợi: dựng được topology tuỳ ý từ CLI.
- Hại: `peer_ask_lead` fail-closed **dựa trên đúng trường này** ⇒ với N lead,
  giả mạo parent = escalate đi nhầm lead.

(Docs chỉ mô tả ngữ nghĩa — *"When an agent creates another agent without a
workspace ID, the new agent is its subagent"* — không nói gì về xác thực.)

### 1.11 `send_agent_prompt` không có arg guard

`send_agent_prompt` nằm trong `PASEO_TOOLS.orchestration` → có trong
`LEAD_ALLOWED_MCP_TARGETS`. Chỉ `create_agent` có argument guard
(`supervisorCreateAgentBlockReason`, dòng 455). ⇒ Lead A prompt được **bất kỳ
agent nào**, kể cả Peer thuộc Lead B — bypass hoàn toàn B.

### 1.12 Auto-compaction: fork KHÔNG giải quyết được giới hạn context

`docs/compaction.md` của pi: auto-compaction kích hoạt khi
`contextTokens > contextWindow - reserveTokens`, và có `reason: "overflow"` kèm
`willRetry` — pi tự nén rồi chạy lại lượt bị tràn.

⇒ Fork một Lead sắp full context sẽ cho ra một Lead **đã bị nén**, chứ không
phải bản sao trung thực — đúng bằng cái mà `/compact` tại chỗ đã làm.
**Fork giải quyết bàn giao và chạy song song, KHÔNG giải quyết giới hạn context.**
Đây là điều chỉnh tiền đề, cần ghi vào prompt để Lead không dùng fork sai mục đích.

### 1.13 Bề mặt đang dựa vào KHÔNG có trong docs chính thức

Đọc `paseo.sh/docs` (`/docs`, `/docs/cli`, `/docs/orchestration`,
`/docs/workspaces`, `/docs/providers`):

| Lệnh | Có trong docs? |
|---|---|
| `paseo agent detach` | ✅ có, kèm quy tắc "user action" |
| `paseo run` (một phần flag) | ✅ có |
| `paseo schedule` | ✅ có |
| **`paseo import`** | ❌ **không hề xuất hiện** |
| **`paseo chat` (mọi subcommand)** | ❌ **không hề xuất hiện** |
| `paseo agent update` | ❌ không có (nhưng MCP `update_agent` thì có trong skill chính thức) |
| `paseo loop`, `paseo heartbeat` | ❌ không có ở trang CLI |

⇒ **Hai primitive mà PR-B và PR-E dựa vào nhiều nhất đều là bề mặt không có tài
liệu** — không có hợp đồng ổn định, có thể đổi bất cứ lúc nào. Bắt buộc phải có
contract test riêng, theo đúng khuôn `test/paseo-contract.test.mjs` đang có.

### 1.14 Paseo đã ship sẵn orchestration skills

Cài sẵn tại `~/.claude/skills/`: `paseo`, `paseo-handoff`, `paseo-committee`,
`paseo-advisor`, `paseo-loop`.

Điểm quan trọng — **handoff chính thức của Paseo KHÔNG phải fork session**:

> "Transfer the current task — context, decisions, failed attempts, constraints —
> to a fresh agent. The receiving agent starts with **zero context**, so the
> handoff prompt must be a self-contained briefing."

⇒ Có **hai** cơ chế bàn giao, khác nhau về bản chất:

| | Briefing handoff (Paseo chính thức) | Session fork (§1.1-1.3) |
|---|---|---|
| Context bên nhận | Zero + brief tự soạn | Nguyên văn lịch sử |
| Độ trung thực | Mất, do phải tóm tắt | Cao |
| Thiên kiến kế thừa | Không | **Có** — kế thừa cả framing |
| Bề mặt phụ thuộc | Có tài liệu | **Không có tài liệu** |
| Chi phí | Một lượt soạn brief | Gần như 0 (copy file) |

Chúng bổ sung nhau, không thay thế nhau — xem quy tắc chọn ở §3 PR-E.

Ngoài ra skill chính thức còn cho biết:

- `notifyOnFinish` là cơ chế **native**; *"Don't poll `list_agents` or
  `get_agent_status` to 'check on' a running agent."*
- `create_heartbeat` gửi prompt định kỳ **về lại conversation hiện tại**;
  `create_schedule` chạy agent mới theo cron.
- `~/.paseo/orchestration-preferences.json` là nơi chính thức chọn provider theo
  vai (`impl`/`ui`/`research`/`planning`/`audit`) — **trùng vai trò** với
  `cluster-routing.local.json` của pack; phải chốt cái nào là nguồn sự thật.

---

## 2. Ràng buộc thiết kế rút ra

1. **Chat là mặt phẳng phối hợp duy nhất giữa Lead/Supervisor** — thứ duy nhất
   vừa query được (graph) vừa đánh thức được (delivery).
2. **Broadcast theo domain phải tự expand** — mention theo label không tới nơi.
3. **Lease chỉ advisory nếu chỉ dựa vào chat** — muốn cứng phải chặn ở
   tool-call time trong extension.
4. **Model sau import phải ép lại qua MCP `update_agent`** rồi mới verify
   `runtimeInfo` (không đọc `persistence`).
5. **Fork kế thừa niềm tin, không kế thừa quyền** — authority tính lại mỗi lượt
   từ brief V3 (thiết kế cũ đúng), nhưng identity/ownership thì đi theo.
   Bằng chứng: agent fork tự nhận là `LEAD-A` và **từ chối** hành động dưới danh
   nghĩa `lead-B` ("would put a false identity into a shared coordination room").
6. **Fork không dùng để cứu context sắp tràn** (§1.12) và không dùng cho vai cần
   độc lập (anti-pattern 8.13).
7. **Detach là thao tác của Human**, không phải của agent (§1.9).
8. **Metadata đọc từ state file của Paseo**, không tự dựng registry (§1.4).
9. **`import` và `chat` là bề mặt không tài liệu** ⇒ phải có contract test.
10. **Không poll** — dùng `notifyOnFinish` / heartbeat thay vòng lặp thăm dò.

---

## 3. Lộ trình PR

Chuỗi phụ thuộc: **A → B → C → E**, D chạy song song sau A.
(C cần B để đọc room lease; E cần C, vì fork không có lease = 2 writer;
D cần A để biết ai sở hữu agent nào.)

### PR-A — Identity: đọc metadata từ state file của Paseo — ✅ ĐÃ LÀM

**Vấn đề.** `ROLES` (`cli/lib/graph.mjs:27`) chỉ có 3 giá trị, `inferRole()` suy
từ prefix provider ⇒ N supervisor trông y hệt nhau.

**Làm.**

- `cli/lib/agent-state.mjs`: đọc `$PASEO_HOME/agents/<cwd-slug>/<id>.json` →
  `{ labels, config.model, runtimeInfo.{sessionId,model,thinkingOptionId}, persistence.nativeHandle }`.
  Fail mềm khi thiếu file (agent mới, hoặc `PASEO_HOME` khác) → `degraded[]`.
- `domain` = `labels["team.domain"]`, đặt lúc tạo bằng `--label` /
  `create_agent labels`. Không cần registry riêng (§1.4).
- `pteam agents` thêm cột `domain` + `model`; `pteam graph` gắn `domain` vào node
  và group theo domain.
- Contract test cho hình dạng state file (§1.13).

**DoD.** Đọc đúng cả 3 role; thiếu file → `degraded`, không crash; graph hiển thị
domain; test chạy bằng fixture, không cần daemon.

---

### PR-B — `team_chat` tool + `TEAM_MESSAGE_V1` + cạnh message — ✅ ĐÃ LÀM

**Vấn đề.** MCP không có tool chat (§1.7); Lead/Supervisor chạm chat qua bash →
không policy, không audit, dễ sai cú pháp.

**Làm.**

- Custom tool `team_chat` (cùng khuôn `peer_ask_lead` / `team_watchdog`), wrap
  `paseo chat` CLI, **chỉ** cấp cho lead + supervisor.
  Actions: `post` / `read` / `rooms`.
- Ép envelope `TEAM_MESSAGE_V1`: `FROM_AGENT_ID`, `FROM_ROLE`, `FROM_DOMAIN`,
  `KIND`, `TOPIC`, `CORRELATION_ID`, `HOP`, `TTL`.
  Kind: `handoff | dependency | claim | release | question | decision | progress`.
  - `HOP`/`TTL` chống ping-pong (lead↔lead đối xứng, khác peer→lead một chiều).
  - Dedup theo `CORRELATION_ID` phía đọc.
  - **Cap payload 8 KB** (§1.6); bằng chứng lớn đi bằng con trỏ.
- Wake: tool tự chèn `@<shortId>` cho từng recipient. Broadcast theo domain →
  tự expand `@domain:<d>` bằng `paseo ls --label team.domain=<d>` rồi mention
  từng shortId (label-mention không delivery — §1.5).
- Room allowlist theo agent (bù cho việc room không có ACL).
- **Siết bash**: mở rộng chặn `paseo chat` qua bash cho **cả** lead/supervisor,
  buộc đi qua `team_chat`.
- `pteam graph --with-chat`: cạnh `type: "message"`, `confidence: "confirmed"`
  từ `paseo chat read --json`. **Đóng PR-4 trong `docs/webui-architecture.md`.**
- Contract test cho `paseo chat` (§1.13).

**DoD.** Lead A → Lead B qua `team_chat` đánh thức B; envelope sai → từ chối;
`HOP > max` → chặn; payload > 8 KB → chặn kèm gợi ý dùng con trỏ; graph vẽ đúng
cạnh confirmed; bash `paseo chat` bị chặn cho mọi role.

---

#### Đã giao (PR-A + PR-B)

| Thành phần | Nơi |
|---|---|
| Đọc state file của Paseo (labels, parent, model, sessionId, sessionFile) | `cli/lib/agent-state.mjs` |
| `paseoHome()` / `paseoAgentsDir()` (tôn trọng `PASEO_HOME`) | `cli/lib/config-walker.mjs` |
| Node mang `domain`/`model`/`modelDrift`/`sessionId`, `counts.byDomain`, `parentSource` | `cli/lib/graph.mjs` |
| Cây spawn dựng từ đĩa; `inspect` chỉ tốn cho agent KHÔNG có state file | `cli/lib/graph.mjs` |
| Envelope `TEAM_MESSAGE_V1` + expand `domain:<x>` + cap 8 KB + hop/TTL + room allowlist | `scripts/team-chat.mjs` |
| **Luật** `team_chat`: allowlist, role gate, chặn `paseo chat` qua bash | `extensions/paseo-team-core/policy-core.ts` (**trung lập runtime**) |
| Bind luật vào Pi (đăng ký tool + hook bash) | `extensions/paseo-team-policy.ts` |
| Bind luật vào Claude Code (hook bash) | `extensions/paseo-team-core/claude-policy.ts` |
| Tool `team_chat` cho Claude qua MCP | `scripts/claude-team-mcp.mjs` |
| `pteam agents [--domain <d>]`, `pteam graph --with-chat <room[,room]>` | `cli/paseo-team.mjs` |
| Env `PASEO_TEAM_DOMAIN`, `PASEO_TEAM_ROOMS`, `PASEO_HOME` | `pteam env list` |
| Ship `team-chat.mjs` | `scripts/install.{sh,ps1}` + `installer-contract.test.mjs` |

Test: `test/agent-state.test.mjs` (mới), `test/team-chat.test.mjs` (mới),
`test/graph.test.mjs` + `test/policy.test.mts` (mở rộng). 22/22 xanh, typecheck sạch.

**Verify thật trên daemon (30 agent):**

- `pteam graph --refresh` cold: **`inspectSpent: 0`**, 9 cạnh spawn, **3.66s**
  (trước: ~12s và phải poll nhiều lượt mới đủ cây, tối đa 6 `inspect`/lượt).
- `team-chat.mjs post` từ Lead thật → người nhận đang `idle` chuyển `running`
  ⇒ envelope + mention giao được.
- `pteam graph --with-chat exp-room-1` → 1 cạnh `message`
  `confidence: "confirmed"`, `origin: agent`, đúng from/to/kind/topic/room,
  `inspectSpent: 0`, `degraded: 0`.
- Lead thật (Pi) chạy `paseo chat ls` qua bash → bị chặn, trả đúng thông báo
  chuyển hướng sang `team_chat`.
- Adapter Claude chặn y hệt cho `lead`/`supervisor`, vẫn cho qua
  `paseo ls -g` / `remote-paseo.mjs` / `git status` (guard hẹp đúng chủ ý), và
  Peer vẫn bị chặn bởi luật Paseo-CLI sẵn có.

**Đặt luật ở đâu — điều kiện đúng/sai, không phải dọn dẹp.** `policy-core.ts`
ghi rõ: *"a rule that lives in only one adapter is a rule the other runtime
silently lacks"*. Bản nháp đầu của PR này đặt guard chat trong adapter Pi, nên
một `claude-lead` sẽ đi vòng qua nó chỉ bằng cách chọn provider khác. Luật đã
được chuyển vào core; test parity (`claude-policy.test.mjs`,
`claude-team-mcp.test.mjs`, `installer-contract.test.mjs`) giữ cho hai runtime
không lệch nhau nữa.

**Lệch so với plan, có chủ đích:** PR-A không dựng registry riêng như dự kiến —
state file của Paseo (§1.4) đã có đủ, nên module chỉ đọc. Phần thưởng ngoài dự
kiến: label `paseo.parent-agent-id` cho luôn cây spawn (177/259 agent có), nên
`inspect` gần như không còn cần.

### PR-C — Scope lease (bắt buộc trước khi bật multi-lead) — ✅ ĐÃ LÀM

**Vấn đề.** Invariant "một writer cho một moving scope" hiện được giữ *tình cờ*
vì chỉ có 1 Lead. N Lead + fork phá thẳng nó.

**Làm — 2 tầng.**

1. **Ledger (advisory).** Room `leases`: `CLAIM` / `RENEW` / `RELEASE` qua
   `team_chat`, có `SCOPE`, `TTL`, `AGENT_ID`. Winner = CLAIM sớm nhất còn hạn
   (dựa vào total order theo timestamp server — §1.5).
2. **Enforcement (cứng).** Policy extension chặn `create_agent` của Lead khi args
   mang `MODE: write` / `EDIT_AUTHORITY: allowed` mà Lead **chưa là winner**.
   Guard chạy ở tool-call time ngay trong agent — cùng khuôn
   `supervisorCreateAgentBlockReason`.

**Quyết định phải chốt trước khi code:** guard phải spawn `paseo chat read`
(~3s) đồng bộ mỗi lần `create_agent`. Hành vi khi lệnh đó lỗi:
**fail-closed** (Lead không tạo được writer) hay **fail-open** (lease vô nghĩa)?
Đề xuất: **fail-closed kèm mã `BLOCKED: LEASE_UNVERIFIABLE`** — nhất quán với
mọi guard khác của pack, và một Lead không tạo được writer là sự cố nhìn thấy
được, còn hai writer thì không.

- Watchdog: phát hiện lease quá hạn của Lead đã chết → **báo cáo, không tự thu hồi**.

**DoD.** 2 Lead cùng claim 1 scope → chỉ 1 tạo được writer, cái kia nhận
`BLOCKED: SCOPE_LEASE_HELD`; lease hết hạn thì giải phóng; `chat read` lỗi →
`BLOCKED: LEASE_UNVERIFIABLE`; test bằng fixture, không cần daemon.

#### Đã giao

| Thành phần | Nơi |
|---|---|
| Logic thuần: normalize, conflict-by-containment, fold ledger, guard | `extensions/paseo-team-core/policy-core.ts` |
| I/O: claim / renew / release / status / ledger trên room `leases` | `scripts/team-lease.mjs` |
| Enforcement `create_agent` (Pi) | `extensions/paseo-team-policy.ts` |
| Enforcement `create_agent` (Claude) | `extensions/paseo-team-core/claude-policy.ts` + `scripts/claude-hook.mjs` |
| Tool `team_lease` cho cả hai runtime | Pi extension + `scripts/claude-team-mcp.mjs` |
| `notify: false` — bản ghi không đánh thức ai | `scripts/team-chat.mjs` |
| Hướng dẫn cho Lead | `prompts/lead.md` §5, `skills/paseo-team-lead/SKILL.md` bước 0 |

Test: `test/scope-lease.test.mts` (logic thuần), `test/team-lease.test.mjs`
(I/O), cộng wiring test trong `policy.test.mts` và `claude-policy.test.mjs` —
bài học OCR-007: luật mà adapter không gọi thì là luật không tồn tại.

**Lỗi do chạy thật mới lộ ra.** Fold khoá lease theo **chuỗi scope chính xác**,
nên một claim THUA (`src/auth/login` dưới `src/auth` đang sống) vẫn được ghi
dưới key riêng, chỉ bị che lúc đọc — rồi nổi lên thành lease thật ngay khi
`src/auth` được release, trao cho Lead đó phần đất nó chưa từng giành được.
Unit test trượt vì case "sau release thì claim tiếp theo thắng" dùng cùng một
chuỗi scope. Conflict phải được xét lúc **ghi**, không chỉ lúc **đọc**.

Watchdog đã có phần báo lease quá hạn / lease của Lead không còn trong listing
(`classifyLeases`, báo cáo chứ không tự thu hồi — thu hồi một scope từ một Lead
có thể đang ghi dở chính là nước cờ sinh ra writer thứ hai).

---

### PR-D — Governance nhiều Supervisor — ✅ ĐÃ LÀM

**Làm.**

- `SUPERVISOR_OBSERVATION` / `SUPERVISOR_DECISION` thêm `DOMAIN:`. Lead **từ chối**
  decision ngoài domain đã khai.
- Jurisdiction chồng lấn = fail-closed, escalate Human.
- Siết `supervisorCreateAgentBlockReason`: `labels.recovery_for` phải ⊆ domain
  của chính supervisor đó (đọc từ state file — §1.4).
- **Guard cho `send_agent_prompt`** (§1.11): target phải là con của mình, hoặc là
  một Lead/Supervisor — **không** được prompt thẳng Peer của Lead khác.
- Observation loop dùng **`create_heartbeat`** thay vì tự poll (§1.14), scope
  theo domain.
- Ghi vào docs: parentage là khai báo qua env, không xác thực (§1.10) — trust
  boundary mà `peer_ask_lead` đang tin.

**DoD.** Decision ngoài domain bị Lead từ chối; recovery ngoài domain bị chặn;
`send_agent_prompt` tới peer của lead khác bị chặn; heartbeat thay thế vòng poll.

#### Đã giao

| Thành phần | Nơi |
|---|---|
| Cờ `PASEO_TEAM_TOPOLOGY` (`single` mặc định; giá trị lạ → `multi`, phía chỉ-từ-chối) | `policy-core.ts` `teamTopology()` |
| Ngữ pháp domain: `normalizeDomain` / `domainCovers` / `domainConflicts`, `*` = gốc | `policy-core.ts` |
| Parser `SUPERVISOR_OBSERVATION` + phân biệt observation/decision + `malformed[]` | `policy-core.ts` `parseSupervisorBlock` |
| Phán quyết jurisdiction (`JURISDICTION_OK/UNDECLARED/UNVERIFIABLE/MISMATCH/OVERLAP/UNATTRIBUTED`, `SUPERVISOR_BLOCK_MALFORMED`) | `policy-core.ts` `supervisorJurisdictionVerdict` |
| Guard `send_agent_prompt` theo quyền sở hữu + `agentOwnership()` đọc state file | `policy-core.ts`, gọi trong `mcpBlockReason` |
| Supervisor **không** prompt thẳng Peer — `PROMPT_TARGET_IS_PEER`, áp dụng ở **mọi** topology (fail-open khi không resolve được target dưới `single`, fail-closed dưới `multi`) | `policy-core.ts` `sendAgentPromptBlockReason` |
| `recovery_for ⊆ team.domain` của supervisor | `supervisorCreateAgentArgsBlockReason(args, { topology, selfDomain })` |
| Nhóm tool `heartbeat` (`create_heartbeat` / `delete_heartbeat`) cho lead + supervisor | `PASEO_TOOLS.heartbeat` + hai allowlist |
| Bind vào Pi (governanceContext + jurisdiction notice trong `before_agent_start`) | `extensions/paseo-team-policy.ts` |
| Bind vào Claude (input `topology`/`selfDomain`/`promptTarget`; notice trong `user-prompt-submit`) | `claude-policy.ts` + `scripts/claude-hook.mjs` |
| Đọc state file dùng chung cho CẢ policy lẫn CLI (một nguồn sự thật) | `extensions/paseo-team-core/agent-directory.ts`; `cli/lib/agent-state.mjs` chỉ re-export |
| `graph.jurisdiction` = `{ supervisors, unlabeled, conflicts }` | `cli/lib/graph.mjs` `describeJurisdiction` |
| WebUI: lọc theo phạm vi, cảnh báo chồng lấn, domain trên node/list/drawer | `webui/public/*` |
| Prompt: mục *Jurisdiction*, heartbeat loop, `DOMAIN:`/`FROM_AGENT_ID:` trong output contract | `prompts/supervisor.md`, `prompts/lead.md` §6b |

Test: `test/governance.test.mts` (38 case thuần), cộng wiring test trong
`policy.test.mts`, `claude-policy.test.mjs`, `claude-hook.test.mjs` và
`graph.test.mjs`.

**Quyết định có chủ đích.**

- **Giá trị `PASEO_TEAM_TOPOLOGY` lạ → `multi`.** Mọi luật `multi` thêm vào đều
  chỉ TỪ CHỐI. Đọc nhầm `mult` thành multi thì Lead mất một lời gọi kèm lý do rõ
  ràng; đọc nhầm thành single thì governance tắt im lặng trên một cụm mà người
  vận hành tin là đang bật.
- **Decision bị từ chối, observation chỉ cảnh báo.** Một observation sai
  jurisdiction là nhiễu Lead nên chiết khấu; một decision sai jurisdiction là
  thẩm quyền Lead sẽ hành động theo.
- **Không chặn ở tool-call mà tiêm vào ngữ cảnh lượt.** Observation tới qua
  prompt, không qua tool call — chỗ duy nhất chặn được là chính lượt đó.

**Trust boundary (ghi rõ theo §1.10).** `ParentAgentId` đến từ env của tiến trình
chạy `paseo run`, nên một agent có thể khai bất kỳ parent nào. Cả định tuyến
`peer_ask_lead` lẫn guard `send_agent_prompt` đều dựa vào đúng trường đó, và
`team.domain` cũng chỉ là một nhãn. Hai guard này chặn **nhầm lẫn và trôi dạt**,
không chặn giả mạo. Đã ghi vào `prompts/supervisor.md` và `prompts/lead.md`.

---

### PR-E — Fork / handoff — ✅ ĐÃ LÀM

**Quy tắc chọn cơ chế** (§1.14) — Lead phải nêu rõ lý do chọn:

| Tình huống | Cơ chế |
|---|---|
| Vai cần **độc lập** (reviewer, challenger, supervisor) | **Briefing handoff** — fork bị **cấm** (anti-pattern 8.13) |
| Bàn giao khi ngữ cảnh gọn, tóm tắt được | Briefing handoff (đường có tài liệu, ưu tiên mặc định) |
| Cần **giữ nguyên** lịch sử suy luận: chia tải, đổi host/model, tiếp quản giữa chừng | **Session fork** |
| Lead sắp **full context** | **Không phải fork** — dùng `/compact` (§1.12) |

**Làm.**

- `scripts/team-fork.mjs`:
  1. Đọc `persistence.nativeHandle` + `runtimeInfo.sessionId` từ state file (§1.4).
  2. Materialize fork bằng **copy file** (§1.2) — 0 lượt LLM.
  3. `paseo import --provider <role-provider> --cwd <path> --label …`
  4. **MCP `update_agent { settings: { model, thinkingOptionId } }`** ép đúng route (§1.3).
  5. Verify `runtimeInfo.model` / `runtimeInfo.thinkingOptionId` — **không** đọc
     `persistence.metadata.model` (stale).
  6. Lệch → `BLOCKED: FORK_MODEL_UNROUTABLE`, xoá agent vừa import.
- **Fork seed bắt buộc**: prompt đầu tiên vô hiệu hoá mọi ownership claim kế
  thừa — nêu rõ B sở hữu gì, A giữ gì, và B **không** hành động dưới danh nghĩa A.
- **Peer của Lead cũ**: không cướp. A giữ đến khi peer xong (không có API
  reparent; detach làm peer câm và là thao tác của Human — §1.9).
- Handoff phải kèm `CLAIM`/`RELEASE` của PR-C, nếu không fork = 2 writer.

**DoD.** Copy-fork → import → `update_agent` → agent trả lời đúng context cũ,
chạy đúng model route; model lệch → chặn đúng mã lỗi + dọn agent; fork cho vai
độc lập bị từ chối; fork khi lý do là "hết context" bị từ chối kèm gợi ý `/compact`.

---

#### Đã giao (PR-E)

| Thành phần | Nơi |
|---|---|
| Luật thuần: `FORK_REASONS`, cấm vai độc lập, cấm lý do "hết context", bắt buộc `scope` cho fork ghi | `policy-core.ts` `forkRequestBlockReason` |
| Seed prompt `FORK_SEED_V1` (dựng bằng code, không viết tay) | `policy-core.ts` `forkSeedPrompt` |
| So khớp model chịu được dạng đủ tiền tố | `policy-core.ts` `modelReferencesMatch` / `forkModelBlockReason` |
| Materialize fork bằng copy file (uuidv7, header mới, `parentSession` tuyệt đối, ghi tạm rồi rename) | `scripts/team-fork.mjs` |
| `fork` / `verify` / `seed`; verify lệch model thì **xoá** agent | `scripts/team-fork.mjs` |
| Tool `team_fork` cho cả hai runtime | `paseo-team-policy.ts` + `scripts/claude-team-mcp.mjs` |
| Nhãn `team.fork-of` → cạnh `fork` trong graph + WebUI (legend, drawer) | `agent-directory.ts`, `cli/lib/graph.mjs`, `webui/public/*` |
| Ship `team-fork.mjs` | `scripts/install.{sh,ps1}` |
| Hướng dẫn chọn cơ chế | `prompts/lead.md` §7, `skills/paseo-team-lead/SKILL.md` |

Test: `test/team-fork.test.mjs` (16 case), cộng contract test thật ở §7.3.

**Chạy thật mới lộ ra ba điều — cả ba đều làm hỏng fork nếu đoán:**

1. **`paseo import --provider` nhận id provider TRẦN.** Dạng
   `<provider>/<model>` mà `create_agent` chấp nhận bị từ chối thẳng:
   *"Unknown provider 'pi-supervisor/Minnyat/gpt-5.6-luna'"*. Đây là §1.3 nhìn từ
   phía kia: import không mang được route, nên model phải đặt sau bằng
   `update_agent`.
2. **`--cwd` không phải tuỳ chọn.** Thiếu nó, CLI phát hiện session thuộc project
   khác và **hỏi tương tác** (*"Fork this session into current directory?
   [y/N]"*), rồi dưới `--json` chết với `Pi RPC process exited with code 0` —
   một thông báo không liên quan gì tới nguyên nhân.
3. **Phản hồi của `import` dùng `agentId`, không phải `id`.** Bản nháp đọc `id`
   nên trả về `null` trong khi import ĐÃ THÀNH CÔNG: báo lỗi mà vẫn để lại một
   agent sống. Đã sửa thành đọc cả ba cách viết và fail-closed
   (`FORK_IMPORT_UNCONFIRMED`) nếu không có cái nào.

Và một điều nữa từ lượt verify thật: `runtimeInfo.model` trả về dạng đủ tiền tố
`"Minnyat/claude-opus-5"`, còn Lead định tuyến bằng id trần. So sánh chuỗi thẳng
sẽ **xoá** một fork đang chạy đúng model — nên `modelReferencesMatch` so theo
đoạn cuối, và chỉ bắt buộc khớp tiền tố khi cả hai phía đều có.

**Verify thật trên daemon:** fork agent `4bdabb56` (486 entry) → import →
`verify` khớp model → `verify` lệch model → agent bị xoá đúng như thiết kế; đã
dọn cả agent lẫn file transcript.

---

### PR-F — Multi-host (khoanh vùng để sau)

`scripts/remote-paseo.mjs` không cover `chat`, và chưa biết chat room là
per-daemon hay có đồng bộ. Toàn bộ §1 đo trên daemon local.

**Đã thử một lần và đã rút ra (2026-08-28).** Bản nháp thêm `coordinationHost`
vào cluster config và TỪ CHỐI cụm nhiều host không khai nó — rồi làm **hỏng hẳn
`team_chat` và `team_lease` ngay trên máy dev**, nơi `cluster-routing.local.json`
liệt kê 2 host từ tháng 8 trong khi mọi thứ chạy trên một daemon
(`node scripts/team-chat.mjs rooms` → `BLOCKED: LEASE_LEDGER_NOT_SHARED`). Đã gỡ
toàn bộ theo quyết định của user. Hai điều giữ lại cho lần sau:

- **Liệt kê một host trong file routing không đồng nghĩa với đang phối hợp qua
  nó.** Cấu hình mô tả khả năng, không mô tả việc đang xảy ra; gate trên nó là
  gate trên thứ mình chưa biết.
- **Rủi ro thật vẫn còn**: nếu room là per-daemon thì cụm nhiều host có hai sổ
  lease, mỗi cái đọc ra "chưa ai giữ" đối với cái kia — đúng kịch bản hai writer
  mà PR-C sinh ra để chặn. Khi mở lại, đây là thứ phải giải quyết TRƯỚC, và cách
  giải phải là opt-in (một daemon điều phối được khai tường minh), không phải
  fail-closed trên cấu hình có sẵn.

---

## 4. Việc phải làm xuyên suốt mọi PR

1. **Tương thích ngược — ✅ ĐÃ LÀM.** Cờ `PASEO_TEAM_TOPOLOGY=single|multi`
   (`policy-core.teamTopology`). `single` là mặc định và giữ nguyên hành vi
   trước PR-D từng dòng: guard jurisdiction, guard `recovery_for` và guard
   `send_agent_prompt` đều trả `null` ngay. Mọi giá trị KHÔNG nhận ra được đọc
   là `multi`, vì các luật `multi` thêm vào chỉ từ chối chứ không cấp quyền —
   đọc nhầm về phía chặt là một lời gọi bị chặn kèm lý do, đọc nhầm về phía lỏng
   là governance tắt im lặng. Có test cho cả hai chiều ở cả hai runtime.
2. **WebUI — ✅ ĐÃ LÀM.** Tab Team graph: lọc theo `team.domain` (lọc phía
   client, không tốn round trip), băng cảnh báo jurisdiction (chồng lấn = đỏ;
   ghế Lead/Supervisor chưa gán domain = cảnh báo), ô "Phòng chat" đẩy
   `--with-chat` (opt-in, mỗi phòng một round trip, kiểm pattern trước khi vào
   argv), cạnh `message` và cạnh `fork` có legend riêng, drawer hiện phạm vi
   quản và nguồn bàn giao. `pteam graph --json` mang `jurisdiction` để đọc bằng
   terminal cũng đủ.
3. **Contract test cho bề mặt không tài liệu — ✅ ĐÃ LÀM** (§1.13). Xem §7.3:
   `paseo chat` (đã có từ PR-B), hình dạng state file, và `paseo import` —
   khối cuối tự tạo agent thật nên là opt-in (`PASEO_CONTRACT_FORK=1`) và tự
   dọn. Chính khối này đã bắt ba khác biệt của `import` mà mọi unit test đều
   mock đúng theo giả định sai (§PR-E).
4. **Chốt nguồn sự thật routing — ✅ ĐÃ CHỐT (2026-08-28).**
   `cluster-routing.local.json` là nguồn sự thật **duy nhất** cho mọi agent do
   pack tạo ra. `~/.paseo/orchestration-preferences.json` là chuyện của Paseo:
   pack **không đọc, không ghi, không đồng bộ** — nó là mặc định cho agent sinh
   ra ngoài pack (`paseo-committee`, `paseo-advisor`, `paseo-loop`, …).

   Phân chia theo **ai tạo agent**, không phải theo file nào "chính thức hơn":

   | Agent được tạo bởi | Đọc route từ |
   |---|---|
   | pack (routing cycle của Lead) | `cluster-routing.local.json` |
   | skill orchestration của Paseo | `orchestration-preferences.json` |

   Ba lý do, theo thứ tự sức nặng:

   - **Hai từ vựng không phải tập con của nhau.** Pack định tuyến theo
     MODEL_CLASS (rủi ro × disposition) **theo từng host**, kèm họ runtime
     (`pi-*`/`claude-*`) và một thinking option đã được verify trên đúng daemon
     đó. File của Paseo chọn provider theo loại việc
     (`impl`/`ui`/`research`/`planning`/`audit`), **không có** host, không có
     thinking, không có capability filter, không có họ runtime. Ánh xạ hai chiều
     đều mất mát — và chiều mất mát nguy hiểm là chiều bỏ mất host: một cụm
     nhiều daemon sẽ im lặng co về một daemon.
   - **Đọc hai file là hai cách để sai, và sai im lặng.** Invariant 3 tồn tại
     đúng để chặn việc agent chạy trên model không ai chọn. Thêm một nguồn thứ
     hai là mở lại chính cái cửa đó, ngay tại chỗ đã rào kỹ nhất.
   - **Không tranh chỗ với Paseo.** Paseo có quyền định tuyến agent của chính
     nó. Pack chỉ tuyên bố phạm vi của mình, không ghi đè file của người khác —
     cùng nguyên tắc với `mcp.json` (chỉ đụng entry của mình) và với uninstall
     (không bao giờ TẠO file khi gỡ).

   **Phần thực thi** (chốt bằng prose thôi thì sẽ trôi): `pteam preflight` có
   check `routing-source-of-truth` — `pass` khi file của Paseo không tồn tại,
   `warn` khi nó tồn tại, kèm câu nói thẳng rằng pack không đọc nó và phải sửa
   file cluster. Logic nằm ở `orchestrationPreferencesNotice()`
   (`scripts/lib-common.mjs`), có test trong `test/lib-common.test.mjs` —
   kể cả trường hợp file hỏng: câu hỏi duy nhất là TỒN TẠI hay không, nên file
   không parse được vẫn ra notice sạch chứ không throw.

   **Điều này KHÔNG chốt**: nếu sau này upstream trả lời câu hỏi §6 và
   `orchestration-preferences.json` có thêm chiều host + thinking, quyết định
   này phải mở lại — lúc đó lý do "không phải tập con" biến mất.

---

## 5. Còn chưa biết

| Chưa biết | Chặn PR nào | Xử lý |
|---|---|---|
| Chat retention / hiệu năng room hàng nghìn message | PR-B (nhẹ) | Dùng cursor `--since`, đo lúc làm |
| Ngưỡng số agent làm wake/chat chậm | PR-B (nhẹ) | Đo lúc làm |
| Chat cross-host: room per-daemon hay đồng bộ | PR-F | Đã khoanh ra ngoài. Nếu per-daemon thì cụm nhiều host có hai sổ lease — phải giải trước khi bật multi-lead cross-host |
| Mention có đánh thức agent ở daemon khác không | PR-F | Chưa đo; khả năng cao là **không** (mention là chuyện của daemon giữ room) |
| Fork một session **rất lớn** (vài MB) — thời gian copy + hành vi compaction thực tế | PR-E (nhẹ) | Cơ chế đã rõ (§1.2, §1.12); đã fork thật 486 entry ~tức thời, chưa đo mốc vài MB |

---

## 6. Câu hỏi gửi upstream Paseo

1. `paseo import` và `paseo chat` có được hỗ trợ chính thức không? Cả hai đều
   **không có trong docs** nhưng là primitive chính của thiết kế này.
2. CLI `paseo agent update` có thêm `--model` được không, cho ngang MCP
   `update_agent settings.model`?
3. `mentionLabels` có kế hoạch fan-out delivery theo label không?
4. Có API nghịch đảo `detach` (re-attach / reparent) không?

---

## 7. Test plan

Theo quy ước repo: liệt kê case trước, viết test cho ĐỎ, rồi mới implement.

### 7.1 PR-A — `cli/lib/agent-state.mjs` + hiển thị domain

Test thuần bằng fixture (thư mục `PASEO_HOME` giả), không cần daemon.

| # | Case | Kỳ vọng |
|---|---|---|
| A1 | State file đầy đủ | Trả `{labels, model, sessionId, sessionFile, thinkingOptionId}` |
| A2 | Thiếu file state | `null` + 1 mục `degraded`, **không throw** |
| A3 | JSON hỏng | `degraded` kèm lý do, không làm hỏng cả snapshot |
| A4 | Thiếu `runtimeInfo` (agent vừa tạo, chưa khởi động) | `sessionId: null`, không coi là lỗi |
| A5 | `labels` rỗng / không có `team.domain` | `domain: null`, node vẫn render |
| A6 | `PASEO_HOME` bị override qua env | Đọc đúng thư mục override |
| A7 | cwd-slug có ký tự lạ (space, unicode, `..`) | Slug hoá đúng, không thoát khỏi thư mục |
| A8 | `config.model` ≠ `runtimeInfo.model` | Ưu tiên `runtimeInfo`, và cảnh báo lệch |
| A9 | `persistence.metadata.model` stale (§1.3) | **Không** được dùng làm nguồn model |
| A10 | `buildGraph` với node có domain | Node mang `domain`, `counts` group theo domain |
| A11 | 2 supervisor khác domain | Hiển thị tách bạch, không gộp thành 1 role bucket |
| A12 | Contract: hình dạng state file thật | Test riêng cần daemon, ngoài CI (khuôn `paseo-contract.test.mjs`) |

### 7.2 PR-B — `team_chat` + `TEAM_MESSAGE_V1` + cạnh message

Test bằng fake `paseo` CLI (đã có khuôn `test/fixtures/fake-paseo.mjs`).

**Envelope**

| # | Case | Kỳ vọng |
|---|---|---|
| B1 | Envelope hợp lệ | Post thành công, trả `correlationId` |
| B2 | Thiếu trường bắt buộc | Từ chối, không gọi CLI |
| B3 | `KIND` ngoài danh sách | Từ chối |
| B4 | Trùng trường / trường lạ | Từ chối (fail-closed, giống parser V3) |
| B5 | Payload 8 KB + 1 byte | Từ chối kèm gợi ý dùng con trỏ |
| B6 | Payload có ký tự đa byte sát ngưỡng | Đo theo **byte UTF-8**, không theo số ký tự |
| B7 | `HOP` ≥ max | Chặn, không post |
| B8 | `TTL` đã hết | Chặn |
| B9 | Body chứa chuỗi `TEAM_MESSAGE_V1` giả trong phần text | Không được parse thành envelope thứ hai |

**Quyền và định tuyến**

| # | Case | Kỳ vọng |
|---|---|---|
| B10 | Peer gọi `team_chat` | Bị chặn (tool không có trong allowlist của peer) |
| B11 | Lead gọi `paseo chat` qua bash | Bị chặn, hướng sang `team_chat` |
| B12 | Supervisor gọi `paseo chat` qua bash | Bị chặn |
| B13 | Post vào room ngoài allowlist | Bị chặn |
| B14 | Broadcast `@domain:x` | Expand thành N mention shortId, đúng số agent khớp label |
| B15 | Broadcast domain không có agent nào | Trả rõ "0 recipient", **không** post âm thầm |
| B16 | `paseo ls --label` lỗi khi expand | Fail-closed, không post nửa vời |

**Đồ thị**

| # | Case | Kỳ vọng |
|---|---|---|
| B17 | `chat read` trả message có `author` là UUID | Cạnh `message` + `confidence: "confirmed"` |
| B18 | `author: "manual"` (người post) | Cạnh gắn nguồn `human`, không phải agent |
| B19 | Cùng `correlationId` xuất hiện 2 lần | Chỉ vẽ 1 cạnh (dedup đã có ở `buildGraph`) |
| B20 | `chat read` lỗi/timeout | `degraded[]`, đồ thị vẫn render |
| B21 | Mention tới agent không có trong listing | Cạnh `orphan`, không âm thầm bỏ |
| B22 | Contract: `chat post/read` thật | Test riêng cần daemon, ngoài CI |

### 7.3 PR-D / PR-E / PR-F

| # | Case | Kỳ vọng | Ở đâu |
|---|---|---|---|
| D1 | `PASEO_TEAM_TOPOLOGY` không đặt / `single` | Mọi guard PR-D trả `null` | `governance.test.mts`, wiring test hai runtime |
| D2 | Giá trị lạ (`mult`, `many`) | Đọc là `multi` — phía chỉ từ chối | `governance.test.mts` |
| D3 | `backend` vs `backend.auth` vs `backendops`; `Backend/Auth` | Chứa nhau theo đoạn, không theo chuỗi con; chuẩn hoá về một cách viết | `governance.test.mts` |
| D4 | `SUPERVISOR_OBSERVATION` nhắc trong văn xuôi | KHÔNG parse thành block | `governance.test.mts` |
| D5 | `SUPERVISOR_DECISION:` rỗng | Vẫn là observation | `governance.test.mts` |
| D6 | Decision tự khai `REVERSIBILITY: irreversible` | `malformed` → từ chối | `governance.test.mts` |
| D7 | Decision ngoài domain / observation ngoài domain | Từ chối / chỉ cảnh báo | `governance.test.mts` |
| D8 | Lead không có `team.domain` | `JURISDICTION_UNVERIFIABLE` | `governance.test.mts` |
| D9 | Hai supervisor cùng phủ một Lead | `JURISDICTION_OVERLAP`, nêu tên cả hai, escalate Human | `governance.test.mts`, `graph.test.mjs` |
| D10 | `recovery_for` ngoài domain / supervisor chưa gán domain | `RECOVERY_OUT_OF_JURISDICTION` / `JURISDICTION_UNDECLARED` | `governance.test.mts` + hai runtime |
| D11 | `send_agent_prompt` tới Peer của Lead khác | `PROMPT_TARGET_NOT_OWNED`, nêu tên Lead sở hữu | `policy.test.mts`, `claude-policy.test.mjs`, `claude-hook.test.mjs` |
| D12 | Target không đọc được state | `PROMPT_TARGET_UNKNOWN` (fail-closed) | như trên |
| D13 | Target là Lead/Supervisor khác | Cho qua — đây là đường điều phối | như trên |
| D14 | Hook Claude tự **resolve** ownership từ state file | Chặn đúng bằng dữ liệu thật, không phải do thiếu tham số | `claude-hook.test.mjs` |
| D15 | `create_heartbeat` cho lead/supervisor; `create_schedule` cho supervisor | Cho / chặn | `claude-policy.test.mjs` |
| D16 | DECISION không có `FROM_AGENT_ID` | `JURISDICTION_UNATTRIBUTED` (từ chối) — bỏ trống field bắt buộc không được là đường vòng qua luật overlap; OBSERVATION vẫn khoan dung | `governance.test.mts` |
| D17 | Supervisor `send_agent_prompt` thẳng tới Peer, topology `single` **và** `multi` | Chặn (`PROMPT_TARGET_IS_PEER` / `PROMPT_TARGET_NOT_OWNED`); target không resolve được thì `single` cho qua, `multi` chặn | `governance.test.mts` |
| E1 | Fork thiếu `reason`, hoặc reason lạ | `FORK_REASON_INVALID` | `team-fork.test.mjs` |
| E2 | Fork vai độc lập (reviewer/challenger/supervisor/auditor) | `FORK_ROLE_MUST_BE_INDEPENDENT` | `team-fork.test.mjs` |
| E3 | Lý do "hết context" — kể cả nằm trong `rationale` | `FORK_FOR_CONTEXT` + gợi ý `/compact` | `team-fork.test.mjs` |
| E4 | `split-load`/`takeover` không khai `scope` | `FORK_WITHOUT_LEASE_PLAN` | `team-fork.test.mjs` |
| E5 | Copy transcript | Header mới (id/timestamp/`parentSession` tuyệt đối), entry giữ nguyên id, nguồn không đổi, không sót file tạm | `team-fork.test.mjs` |
| E6 | Session rỗng / không phải JSON / không phải header session | Lỗi có tên, không tạo fork nửa vời | `team-fork.test.mjs` |
| E7 | Fork bị chặn / import lỗi | Không ghi file / dọn file đã ghi | `team-fork.test.mjs` |
| E8 | `verify` khớp model dạng đủ tiền tố (`Minnyat/x` vs `x`) | Cho qua | `team-fork.test.mjs` |
| E9 | Hai provider cùng model id (`A/x` vs `B/x`) | Lệch — đây là điều route cross-provider phân biệt | `team-fork.test.mjs` |
| E10 | `verify` lệch model | `FORK_MODEL_UNROUTABLE` + xoá agent; xoá lỗi thì báo, không nuốt | `team-fork.test.mjs` |
| E11 | Contract: `paseo import` thật | `--provider` trần, `--cwd` bắt buộc, trả `agentId`, `ParentAgentId: null`, nhãn round-trip | `paseo-contract.test.mjs` (`PASEO_CONTRACT_FORK=1`) |
| E12 | Hình dạng state file thật | `provider`/`labels` có; `model`/`sessionId`/`sessionFile`/`domain`/`forkOf` là string-hoặc-null; `sessionFile` trỏ file có thật | `paseo-contract.test.mjs` |
Cách chạy contract test (cần daemon thật, ngoài CI):

```bash
PASEO_CONTRACT_AGENT_ID=<agent-id> npm test                     # chat + state file
PASEO_CONTRACT_AGENT_ID=<agent-id> \
PASEO_CONTRACT_FORK=1 \
PASEO_CONTRACT_FORK_PROVIDER=pi-supervisor \
  node --test test/paseo-contract.test.mjs                      # + import (tạo rồi xoá 1 agent)
```

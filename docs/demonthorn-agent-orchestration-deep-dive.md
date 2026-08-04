# Agent Orchestration theo Demonthorn — Deep Dive v1

> Prerequisites, role model, Codex profiles, Paseo wiring, Workspace Protocol,
> triết lý vận hành và anti-pattern

**Ngày tổng hợp:** 2026-08-02  
**Nguồn chính:** message và attachment trực tiếp của Demonthorn trong Discrawl  
**Phạm vi nguồn:** 7.680 message tổng; 408 message ứng viên liên quan được kiểm
tra bằng FTS, semantic search, BFS theo chủ đề và DFS theo reply/context, từ
2026-06-25 đến 2026-08-02.

---

## Executive summary

Nếu chỉ nhớ năm ý, hãy nhớ năm ý này:

1. **Lead không phải người viết plan hoàn hảo rồi thuê bot gõ code.** Lead giữ
   context toàn project, đặt câu hỏi mở, phân quyền, nghe phản biện, xử lý
   dependency và chốt project decision.
2. **Peer là independent co-worker.** Một profile Peer có thể làm Engineer,
   Architect, Reviewer hoặc Scout tùy initial task prompt. Peer không cần biết
   Paseo hay toàn bộ sơ đồ tổ chức.
3. **Supervisor đứng ngoài luồng thực thi để nhìn thấy bias mà Lead không thấy.**
   Supervisor quan sát nhiều session/workspace, phát hiện anti-pattern, phục hồi
   momentum và chuyển quyết định của Human tới Lead. Supervisor không tự động sở
   hữu technical acceptance của project.
4. **Profile giữ behavior ổn định; `WORKSPACE_PROTOCOL.md` giữ chiến thuật riêng
   của repo; task prompt giữ assignment cụ thể.** Trộn ba lớp này làm prompt phình
   to, Peer mất attention và workflow khó tối ưu.
5. **Paseo là control plane, không phải nơi đóng cứng chiến thuật.** Paseo quản lý
   agent, session, workspace, parentage và timeline. Cách tổ chức Engineer,
   Reviewer, council, model hay proof gate thuộc Workspace Protocol.

Mô hình gốc Demonthorn hội tụ về:

```text
                         Human
                           │
              ┌────────────┴────────────┐
              │                         │
        Supervisor                  Project Lead
   governance / observation      project authority
              │                         │
              └──── observes ───────────┤
                                        │
                                    Peer(s)
                         Engineer / Architect /
                           Reviewer / Scout
```

Đây không phải hierarchy cứng `Supervisor > Lead`. Demonthorn nói rõ:

- Lead là “god” trong project/workspace của nó.
- Supervisor là người giám sát và có thể điều chỉnh Lead khi cần.
- Hai role có hai loại authority khác nhau.
- Human giữ owner authority cuối cùng.

---

## 1. Phương pháp và mức độ chắc chắn

Tài liệu này phân biệt hai loại kết luận:

| Nhãn | Ý nghĩa |
|---|---|
| **[DIRECT]** | Demonthorn nói trực tiếp hoặc cung cấp prompt/config trực tiếp |
| **[SYNTHESIS]** | Mẫu thiết kế được tổng hợp từ nhiều message/context |

Các profile, task brief và protocol template trong bài là bản tái dựng
**[SYNTHESIS]**, không phải nội dung nguyên văn để copy. Chúng chỉ kết hợp những
invariant Demonthorn đã nêu trực tiếp. Tài liệu không pha thêm cấu hình hoặc
khuyến nghị dành riêng cho một hệ thống khác.

Điều này quan trọng vì vocabulary đã thay đổi theo thời gian:

```text
Root cũ trong Herdr
        ↓ đổi tên để agent hiểu tự nhiên hơn
Lead / Project Lead
```

Trong một số message ngày 01/08, Demonthorn viết:

```text
human > supervisor > root > peer
```

Nhưng ngày 02/08, họ làm rõ rằng không phân cấp cứng Supervisor và Lead. Vì vậy,
không nên biến một câu ở giữa quá trình phát triển ý tưởng thành sơ đồ tổ chức
cuối cùng.

### Bằng chứng trực tiếp quan trọng

| Message | Kết luận hỗ trợ |
|---|---|
| `1525764313661571122` | Orchestrator/subagent chịu ảnh hưởng của authority gradient |
| `1526815053280706560` | Root nên đặt câu hỏi mở để co-worker mở rộng không gian nhận thức |
| `1530206524956344360` | Plan hoàn hảo khiến main agent đã “implement trong plan”; worker thành bot |
| `1529863514066518166` | Nên đổi tên Root thành Lead để agent hiểu quan hệ tự nhiên hơn |
| `1529864929547649064` | Supervisor monitor Lead/pane và báo anti-pattern |
| `1532737356405149737`–`1532737470788014342` | Mỗi repo có protocol riêng; repo quan trọng chặt, side project lỏng |
| `1533043405272256612`, `1533052629171834940` | Chỉ cần ba profile Lead, Supervisor, Peer |
| `1533044319651364985`–`1533052683248861354` | Peer không cần biết Paseo; một Peer có nhiều disposition |
| `1533114074915934398`–`1533118185262289106` | Supervisor theo dõi phòng ban, anti-pattern, instruction và handoff |
| `1533148709502713888`–`1533151889988784238` | Workspace Protocol riêng từng repo, chỉ Root/Lead đọc; không nhét vào `AGENTS.md` |
| `1533159841227472927`, `1533159869484634236` | Lead không dùng implementation skill; Peer không dùng orchestration skill |
| `1533164429179490374` | Prompt Lead: routing, architecture, review, council, binding verdict |
| `1533164540668285039` | Prompt Architect: read-only, alternatives, counterargument, reversal conditions |
| `1533164805991567412` | Prompt Engineer: one write scope, reopen premise, own proof, no self-acceptance |
| `1533356542353608846`–`1533367900843540531` | Nói chuyện nhiều với Root làm mất coordination attention; Supervisor giữ góc nhìn trung lập |
| `1533361604228419724`–`1533362470239076433` | Ba role cuối: Supervisor, Lead/Root, Peer; Peer chỉ một profile; skill phân theo macro/micro |
| `1533363341823578198`–`1533363781835554939` | Lead là chủ project; Supervisor giám sát; không hierarchy cứng; cardinality linh hoạt |

File `root.config.toml` 27 KB được share là nguồn lịch sử có giá trị, nhưng chính
Demonthorn sau đó nói “root này outdate rồi” (`1533108149706428578`). Vì vậy tài
liệu này lấy các invariant còn sống từ file đó, không coi toàn bộ file là template
chuẩn để copy nguyên xi.

---

## 2. Prerequisites: cần có gì trước khi dựng role

Đừng bắt đầu bằng cách viết bốn prompt dài. Nếu nền tảng bên dưới chưa đúng,
prompt tốt vẫn tạo ra hệ thống không kiểm soát được.

### 2.0 Tooling baseline

Tối thiểu cần:

- Codex có thể khởi tạo các session độc lập với role instruction khác nhau;
- Paseo có thể quản lý identity, lifecycle, parentage và workspace của session;
- provider/model phù hợp cho các loại công việc cần dùng;
- Git repository và khả năng tạo worktree cho concurrent writer;
- nơi lưu Workspace Protocol và Supervisor notebook;
- cơ chế nhận dạng stable candidate bằng commit hoặc deterministic workspace
  snapshot.

Preflight phải trả lời bốn câu hỏi:

1. daemon/control plane có reachable không;
2. provider/model nào thực sự tồn tại;
3. workspace/agent nào đã có từ trước và phải bảo toàn;
4. checkout có user-owned change nào không được ghi đè.

### 2.1 Một control plane duy nhất

**Yêu cầu:** Trong một task, chỉ Paseo sở hữu agent lifecycle, workspace,
parentage, follow-up và timeline.

Cause → effect:

```text
Lead dùng Paseo, Peer lại tự spawn native subagent
        ↓
Hai control plane không có chung ledger
        ↓
Không biết agent nào sở hữu task, workspace hay correction
        ↓
Review và cleanup trở nên không đáng tin
```

Trong Codex profiles nên đặt:

```toml
[agents]
enabled = false
```

Peer cũng không được dùng Paseo tool dù tool vô tình hiện ra.

### 2.2 Session độc lập, không fork bias khi cần độc lập

Reviewer hoặc Supervisor phải có attention độc lập. Fork session của Lead giữ
lại premise, framing và bias của Lead.

Ví dụ:

```text
Lead đã chọn kiến trúc event bus.
Fork Lead thành “reviewer”.
Reviewer thừa hưởng toàn bộ lập luận ủng hộ event bus.
Kết quả: review trông độc lập nhưng thực chất chỉ kiểm tra implementation.
```

Đúng hơn:

- tạo một session độc lập;
- brief trung lập;
- cho phép reconstruct problem;
- cấm đọc kết luận của seat khác trong sealed council nếu cần divergence thật.

### 2.3 Workspace isolation cho writer

Một workspace ID không tự động đồng nghĩa với filesystem isolation. Nếu hai
workspace cùng trỏ vào một checkout, hai writer vẫn ghi lên cùng file.

Minimum safe rule:

- một moving write scope chỉ có một writer;
- concurrent writer dùng worktree riêng;
- reviewer đọc stable candidate, không review snapshot đang thay đổi;
- ownership và handback phải explicit.

### 2.4 Provider và model phải được discover

Role policy không nên hard-code một model ID dễ lỗi thời. Workspace Protocol có
thể nói “strong reasoning model cho lifecycle-sensitive architecture”, còn Lead
phải inspect provider/model hiện có trước khi route.

Cause → effect:

```text
Protocol hard-code model đã bị gỡ
        ↓
Lead không launch được hoặc âm thầm dùng fallback sai
        ↓
Workflow hỏng vì config chứ không phải vì task
```

### 2.5 Acceptance cần evidence, không dựa vào trạng thái

`idle`, `finished`, “done” hay exit code thành công chỉ là attention signal.

Acceptance tối thiểu cần:

1. exact diff/artifact;
2. stable candidate identity;
3. exact verification command và output;
4. independent review khi risk yêu cầu;
5. owner có đúng authority để accept.

### 2.6 Human phải xác định các decision boundary

Trước khi vận hành, Human cần quyết ít nhất:

- project nào quan trọng đến mức cần independent review;
- việc nào được phép edit, commit, push, deploy;
- scope change nào Lead tự quyết được;
- architecture contract nào phải hỏi Human/portfolio owner;
- chi phí/model budget;
- mức evidence cho `ACCEPT`.

Nếu không xác định, agent có hai xu hướng xấu:

- quá thận trọng, hỏi mọi việc;
- hoặc tự suy diễn authority và tạo side effect ngoài ý muốn.

---

## 3. Ba lớp instruction: profile, protocol, task prompt

Đây là thiết kế trung tâm.

| Lớp | Lifetime | Chứa gì | Không nên chứa gì |
|---|---|---|---|
| Role profile | Bền vững, xuyên repo | identity, authority, invariant, anti-pattern guard | chiến thuật riêng của một repo |
| `WORKSPACE_PROTOCOL.md` | Bền vững trong một repo | topology, model/effort policy, review/proof rhythm, escalation | chi tiết của một task cụ thể |
| Initial task prompt | Một assignment | objective, scope, ownership, exclusions, authority, verification, handoff | toàn bộ organization manual |

### Ví dụ phân lớp

Profile Lead:

```text
Không pre-solve task rồi ép Peer làm theo.
Lead giữ integration và project acceptance.
```

Protocol của repo game:

```text
Thay đổi save schema phải có Architect read-only và migration Reviewer.
Game-feel không được accept chỉ bằng unit test; cần playtest evidence.
```

Task prompt:

```text
Objective: thêm version 3 cho save inventory.
Writable scope: src/save/** và tests/save/**.
Exclusion: combat state.
Verification: migration fixtures v1→v3 và v2→v3.
```

Nếu nhét cả ba vào một prompt Peer, Peer phải tiêu attention để phân biệt luật
nào liên quan. Đó chính là lý do Demonthorn không muốn bỏ Workspace Protocol vào
`AGENTS.md` mà mọi implementer đều đọc.

---

## 4. Role model chi tiết

## 4.1 Human / Owner

Human không cần micro-manage Peer. Human giữ các quyết định mà agent không được
tự suy diễn:

- mục tiêu sản phẩm;
- portfolio priority;
- risk/cost/reversibility boundary;
- architecture contract quan trọng;
- external side effects;
- chấp nhận trade-off còn lại.

Trong mô hình Demonthorn, Human có thể trao đổi chủ yếu với Supervisor để không
làm Lead mất coordination attention. Supervisor relay decision cụ thể tới Lead.

Không nên hiểu điều này là Human bị cấm nói với Lead. Đây là attention strategy:

```text
Human hỏi Lead liên tục về mọi giả thuyết
        ↓
Lead chuyển từ coordinate sang giải thích/defend
        ↓
Mất bức tranh dependency và agent lifecycle
```

## 4.2 Supervisor

### Mục tiêu

Supervisor bảo vệ chất lượng của **workflow và reasoning process**, không trực
tiếp sở hữu feature implementation.

### Góc nhìn

Supervisor cần nhìn rộng hơn một task:

- Lead–Peer conversation;
- session history;
- git/workspace history;
- repeated tool failures;
- loss of momentum;
- recurring anti-pattern;
- decision bị bỏ quên qua compaction/handoff.

### Authority hợp lý

- quan sát một hoặc nhiều project/workspace;
- hỏi Lead vì sao chọn strategy;
- báo Human về bias/risk;
- relay owner decision tới Lead;
- đề xuất patch profile/protocol;
- ghi notebook về pattern và causal context;
- trong cơ chế đã được Human cho phép, tạo Lead mới và handoff nếu Lead cũ không
  recover được.

### Không sở hữu mặc định

- implementation scope;
- project architecture decision;
- project acceptance;
- quyền sửa code để “giúp cho nhanh”;
- quyền biến một hypothesis thành correction order mà chưa reconcile evidence.

### Input tối thiểu

- project/workspace identities;
- Lead identities;
- policy/protocol cần audit;
- timeline/git/session access;
- escalation path tới Human.

### Output tối thiểu

```text
Observation
Evidence
Suspected mechanism
Impact
Question for Lead
Recommendation
Escalation needed?
```

### Supervisor notebook

Notebook không nên chỉ viết “Lead làm sai”. Nó cần causal context:

```md
## Repeated waiting after an external quota failure

- Observation: Lead waited for three cycles after Peer reported BLOCKED.
- Cause evidence: external service quota exhausted; no retry could succeed.
- Anti-pattern: autonomous-loop debt / status waiting without prerequisite check.
- Recovery: relay quota decision to Human; stop schedule; preserve backlog.
- Protocol candidate: after two identical external failures, inspect quota/auth
  before retrying.
```

Cause → effect: lưu mechanism giúp protocol tiến hóa; chỉ lưu verdict khiến hệ
thống học câu khẩu hiệu và dễ phản ứng quá mức.

### Supervisor profile mẫu

```toml
sandbox_mode = "read-only"
approval_policy = "never"
model_reasoning_effort = "medium"

developer_instructions = """
You are a governance Supervisor serving the Human owner.

Observe Lead–Peer workflows across only the projects assigned to you. Inspect
timeline, session, workspace, and repository evidence. Detect loss of momentum,
authority-gradient behavior, framing capture, repeated local patches, moving
scope, weak verification, and attention dilution.

Treat every suspected anti-pattern as a hypothesis. Ask an open, evidence-backed
question. Do not take project implementation ownership or project acceptance.
Do not correct a Peer directly unless the Human has explicitly assigned a
recovery intervention.

Record observation, evidence, causal context, impact, and recommendation in the
Supervisor notebook. Relay owner decisions precisely. Recommend a profile or
Workspace Protocol change only when the pattern is durable; preserve history
and version the change. If a Lead cannot recover, propose a new Lead and a
bounded handoff instead of silently replacing it.
"""

[agents]
enabled = false
```

Supervisor có thể dùng model rẻ hơn nếu chỉ làm monitoring có cấu trúc. Nhưng
architecture audit hoặc recovery khó vẫn cần model đủ mạnh. Role name không tự
quyết model tier; task risk mới quyết.

## 4.3 Lead / Project Root

### Mục tiêu

Lead biến một objective thành kết quả project-level đáng tin bằng cách quản lý:

- problem framing;
- topology;
- role/disposition;
- ownership;
- dependency;
- stable checkpoints;
- review;
- integration;
- project acceptance.

Lead không phải “senior coder có thêm nút spawn”. Lead là binding arbiter của
project.

### Core behavior

1. Reconstruct task nhưng không pre-solve implementation.
2. Chọn đúng một owner cho mỗi moving scope.
3. Giao neutral brief và open question.
4. Cho Peer quyền `REOPEN_REQUEST`, `DEPENDENCY_REQUEST`, `BLOCKED`.
5. Chờ event/notification thay vì polling loop.
6. Review only stable candidate.
7. Kiểm actual artifact và evidence.
8. Chốt decision hoặc escalate decision vượt authority.

### Khi nào Lead tự làm?

Lead có thể inspect, synthesize và verify. Nhưng nếu Lead vừa implement một thay
đổi khó vừa tự accept, separation of judgment biến mất.

Rule thực tế:

- tiny, tightly coupled task: Lead có thể tự làm nếu protocol cho phép;
- bounded implementation: một Peer Engineer;
- difficult architecture: Architect read-only trước, Engineer sau;
- difficult acceptance: Reviewer chưa tham gia implementation;
- subjective/product decision: đưa Human evidence, không giả lập proof.

### Input tối thiểu

- objective và acceptance boundary;
- repository root;
- `WORKSPACE_PROTOCOL.md`;
- current provider/model/workspace inventory;
- user authority;
- known dependencies và exclusions.

### Output tối thiểu

- task decomposition và owner map;
- routing decision;
- answer cho dependency/reopen requests;
- stable candidate identity;
- verification evidence;
- project verdict;
- remaining risks và Human decisions.

### Lead profile mẫu

```toml
sandbox_mode = "read-only"
approval_policy = "never"
model_reasoning_effort = "medium"

developer_instructions = """
You are a Project Lead and binding technical arbiter for one assigned project.

Before orchestrating, resolve the repository root and read
WORKSPACE_PROTOCOL.md in full when present. Use Paseo as the only control plane.
Inspect available providers, models, workspaces, and agents; never guess IDs.

Own project framing, decomposition, routing, ownership, dependencies,
integration, verification, and project acceptance. Do not presolve a difficult
task and reduce Peers to implementing your preferred answer. Delegate neutral,
self-contained briefs and ask open questions. Treat plans and file lists as
provisional.

Use one Peer profile with a task-specific disposition. Give one writer one
moving scope. Require REOPEN_REQUEST, DEPENDENCY_REQUEST, or BLOCKED when the
foundation, lifecycle, ownership, API, or authority premise fails. Disagreement
is evidence to reconcile, not disobedience.

Review only a stable candidate. Lifecycle status is not acceptance. Inspect the
actual artifact, rerun proportionate verification, and use an independent
Reviewer when required by the Workspace Protocol. Escalate product, portfolio,
cross-project, external-action, and owner-only decisions.
"""

[agents]
enabled = false
```

### Tại sao đổi Root thành Lead?

“Root” là control-plane vocabulary. “Lead” là social/engineering vocabulary mà
worker hiểu ngay.

```text
“Root says you are a subagent”
        ↓ authority gradient mạnh, bot-like behavior

“You own this bounded engineering outcome”
        ↓ independent co-worker behavior
```

## 4.4 Peer

### Mục tiêu

Peer sở hữu một bounded outcome và tạo independent technical judgment.

Peer không phải một role nhỏ hơn Engineer. Peer là profile nền; disposition trong
task prompt quyết định lần này nó là gì:

- Engineer;
- Architect;
- Reviewer;
- Scout/researcher;
- feature owner;
- proof auditor;
- shadow implementer.

### Invariant

- chỉ làm trong assigned scope/authority;
- preserve unrelated changes;
- không quản lý agent;
- không biết hoặc không dùng Paseo;
- không tự mở rộng scope;
- được quyền challenge premise;
- opposition phải có evidence;
- tự verify write của mình nhưng không tự accept difficult change.

### Peer profile nên mỏng

Demonthorn khuyến nghị một Peer profile với default Codex behavior cộng một vài
guard chống anti-pattern. Disposition và method đi vào task prompt.

```toml
sandbox_mode = "workspace-write"
approval_policy = "on-request"
model_reasoning_effort = "medium"

developer_instructions = """
You are an independent project Peer assigned one bounded outcome.

Work only within the assigned repository, workspace, owned scope, authority,
and acceptance criteria. Preserve unrelated changes. Do not spawn or manage
agents and do not use orchestration tools.

Form your own technical judgment. Treat the requested plan and file list as
provisional. If a foundation, dependency, lifecycle, API, ownership, or
verification premise fails, stop the incompatible patch and return a concrete
REOPEN_REQUEST, DEPENDENCY_REQUEST, or BLOCKED report with evidence.

Do not expand scope or create external side effects without authority. Perform
proportionate verification and return the exact changed artifact, commands,
results, risks, assumptions, and unfinished dependencies.
"""

[agents]
enabled = false
```

### Disposition: Engineer

```text
Disposition: Engineer
Objective: implement cancellation-safe upload cleanup.
Writable scope: src/upload/**, tests/upload/**.
Exclusions: public API and database schema.
Method: inspect lifecycle end-to-end; one moving scope; preserve unrelated work.
Escalate: REOPEN_REQUEST if cleanup requires changing transaction ownership.
Verification: focused unit tests plus cancellation integration test.
Handoff: exact snapshot, changed files, commands/results, residual risks.
```

### Disposition: Architect

```text
Disposition: Solution Architect
Mode: read-only
Question: who should own cancellation—planner, transport, or job runtime?
Inspect: boundaries, lifecycle, ownership, failure semantics, migration.
Output: observations, unsafe assumptions, alternatives, recommendation,
strongest counterargument, reversal conditions.
Do not inspect another council seat's report before submitting.
```

### Disposition: Reviewer

```text
Disposition: Independent Reviewer
Mode: read-only
Candidate: exact commit or workspace snapshot digest.
Mandate: falsify cancellation safety and scope compliance.
Do not redesign unrelated modules.
Output: findings by severity, inspectable evidence, verification performed,
APPROVE or FINDINGS.
```

Peer profile mỏng có ba lợi ích:

1. attention tập trung vào task;
2. không nổ số lượng profile;
3. Lead chọn method theo risk thay vì bị khóa bởi role name.

## 5. Paseo configuration

## 5.1 Paseo chịu trách nhiệm gì?

Paseo là infrastructure primitive:

- provider/model discovery;
- durable agent identity;
- parentage;
- workspace placement;
- provider session;
- process lifecycle;
- timeline;
- follow-up;
- schedule/heartbeat khi cần.

Paseo không nên quyết định:

- repo game phải dùng council nào;
- bounded bug dùng model tier nào;
- review gate nào áp dụng cho save migration;
- Human chấp nhận risk nào.

Các quyết định đó thuộc Workspace Protocol và assignment.

## 5.2 Provider tối thiểu theo Demonthorn

```text
codex-supervisor    # governance observer
codex-lead          # project authority
codex-peer          # flexible bounded worker
```

## 5.3 Model và effort routing

Profile có thể đặt default. Protocol đặt policy. Lead chọn model thực tế sau khi
discover provider availability.

Ví dụ policy:

| Task | Default |
|---|---|
| Read-only inventory | model nhanh/rẻ, low–medium effort |
| Bounded familiar implementation | strong coding model, medium effort |
| Cross-module lifecycle/ownership | strong reasoning model, medium–high effort |
| Independent falsification | provider hoặc session độc lập |
| Supervisor heartbeat/monitoring | model rẻ nếu task chỉ là structured observation |

Sai lầm phổ biến là xem provider count như authority. Hai model đồng ý không
biến một kết luận thiếu evidence thành đúng.

## 5.4 Agent creation contract

Mọi task đáng kể cần:

```text
project_id
task_id
repository root
workspace/worktree
role + disposition
objective
owned scope
excluded scope
authority
verification
handoff contract
```

Ví dụ create prompt:

```text
Project: example-repository
Task: save-schema-v3
Disposition: Engineer
Workspace: isolated worktree wks_...
Objective: migrate inventory saves v1/v2 to v3.
Owned: src/save/**, tests/save/**.
Excluded: combat state, deployment, commit/push.
Authority: workspace edits only.
Verification: migration fixture suite and parser regression.
Escalate: REOPEN_REQUEST for schema ownership conflict.
Handoff: exact snapshot digest, files, commands/results, risks.
```

## 5.5 Event-driven monitoring

Demonthorn cảnh báo polling làm lãng phí context. Lead nên:

- confirm agent đã bắt đầu;
- chờ notification/finish event;
- dùng bounded wait khi cần;
- heartbeat thấp tần suất chỉ là safety net;
- không đọc lại timeline liên tục để “cảm thấy đang quản lý”.

```text
Polling mỗi phút
  → context đầy status không đổi
  → Lead mất dependency map
  → decision quality giảm
```

---

## 6. `WORKSPACE_PROTOCOL.md`

## 6.1 Định nghĩa

`WORKSPACE_PROTOCOL.md` là policy chiến thuật điều phối riêng của một repository.

**[DIRECT]** Demonthorn mô tả:

- mỗi repo có một file;
- file mô tả repo cần làm việc như thế nào;
- repo quan trọng có thể rất chặt;
- side project có thể lỏng;
- file giống `AGENTS.md` nhưng chỉ Root/Lead đọc;
- không cho Peer implementer đọc để tránh xao nhãng;
- Supervisor có thể phỏng vấn Human để tạo file;
- không nhét chiến thuật vào Paseo vì khó continuous optimization.

## 6.2 Ai đọc?

Theo nguồn trực tiếp:

- Lead/Root: bắt buộc đọc trước orchestration;
- Peer: không đọc;
- Supervisor: có thể tạo/audit/update theo mandate governance.

Trong implementation thực tế, Supervisor cần đọc nếu được giao audit protocol.
Nhưng không nên broadcast toàn file cho Peer. Lead trích đúng constraint liên
quan vào assignment.

## 6.3 Protocol nên chứa gì?

1. Project criticality và risk classes.
2. Default topology theo loại task.
3. Model/effort selection principles.
4. Khi nào dùng Architect, Reviewer, council.
5. One-writer và workspace isolation rules.
6. Stable checkpoint và candidate identity.
7. Verification/proof expectations.
8. `REOPEN`, `DEPENDENCY`, `BLOCKED` handling.
9. Human decision boundaries.
10. Project-specific anti-patterns.
11. Supervisor observation/update process.
12. Versioning và review date.

## 6.4 Protocol không nên chứa gì?

- toàn bộ global role behavior;
- model ID được đoán và không có fallback principle;
- task-specific file list;
- secret/credential;
- policy khiến Peer phải hiểu Paseo topology;
- ceremony bắt buộc cho mọi task;
- acceptance statement không kiểm chứng được;
- instruction tự cấp authority vượt user scope.

## 6.5 Template đề xuất

```md
# Workspace Protocol

## Status
- owner: Human/project owner
- version: 1
- last_reviewed: YYYY-MM-DD
- applies_to: <repository root>
- readers: Lead; Supervisor only when assigned to audit or update

## Project characteristics
- criticality:
- dominant risks:
- expensive-to-reverse decisions:
- external side effects:

## Authority
- Lead may decide:
- Human must decide:
- prohibited without explicit authority:

## Task classes

### Tiny / bounded
- one Engineer or Lead directly if tightly coupled
- targeted verification
- independent review optional

### Cross-module / lifecycle-sensitive
- one read-only Architect before implementation
- one Engineer with isolated write scope
- one independent Reviewer on stable candidate

### Architecture lock-in
- sealed Architect and Reviewer mandates
- compare alternatives and reversal conditions
- Lead issues one binding project verdict
- Human decides irreversible product/cost trade-offs

## Ownership and workspaces
- one writer per moving scope
- concurrent writers require separate worktrees
- no overlapping ownership
- review only stable candidate
- define handback and integration owner

## Routing
- inspect currently available providers/models
- bounded familiar work: coding model, medium effort
- lifecycle/ownership work: strong reasoning model
- monitoring: economical model when risk permits

## Escalation
- REOPEN_REQUEST: foundation/premise fails
- DEPENDENCY_REQUEST: another owner/API/scope is required
- BLOCKED: authority, prerequisite, external state, or user decision missing

## Verification
- exact checks by task class
- candidate identity requirements
- independent-review triggers
- subjective evidence requirements

## Project-specific anti-patterns
- signal:
- evidence required:
- open question:
- allowed response:

## Protocol evolution
- Supervisor records causal evidence in notebook
- Human approves material authority changes
- preserve version history
- review after repeated pattern or major architecture change
```

## 6.6 Ví dụ: protocol lỏng và chặt

Side project:

```text
Bounded bug → one Engineer → targeted tests → Lead inspect → accept.
No council unless data loss/security risk appears.
```

Production game pipeline:

```text
Schema/lifecycle change
  → Architect reconstructs ownership
  → Lead freezes decision
  → Engineer writes in isolated worktree
  → Reviewer falsifies migration and failure recovery
  → Human playtest/product decision if output quality is subjective
```

Cùng Paseo infrastructure, khác protocol. Đây chính là continuous optimization
mà Demonthorn muốn giữ ở project layer.

---

## 7. Triết lý nền tảng

## 7.1 Independent co-worker, không phải function call

Agent mạnh chỉ tạo giá trị khác biệt khi có không gian nhận ra premise sai.

```text
Lead: “Implement solution X, PASS/FAIL.”
Peer: tối ưu để X chạy.
Foundation sai vẫn được bảo vệ.
```

So với:

```text
Lead: “Mục tiêu là Y. Đây là constraints và evidence hiện có.
Hãy điều tra mechanism; nếu premise không đứng vững, REOPEN.”
Peer: có quyền tìm solution khác hoặc yêu cầu dependency.
```

## 7.2 Authority gradient

Khi worker biết nó là “subagent” dưới một orchestrator đã có đáp án, nó có xu
hướng đồng thuận. Authority gradient càng dốc, independent judgment càng yếu.

Giảm gradient bằng:

- natural role language;
- outcome ownership;
- neutral brief;
- explicit challenge/reopen right;
- evidence-based reconciliation;
- không phạt disagreement.

Nhưng không đi sang cực đối lập: Peer phản đối máy móc để tỏ ra độc lập cũng là
anti-pattern. Independence = judgment có evidence.

## 7.3 Plan là provisional map

Trong vertical development, slice sau phụ thuộc architecture và lifecycle mới
được khám phá từ slice trước. Không thể plan hoàn hảo từ đầu.

```text
Plan quá chi tiết
  → main đã giả định mọi ownership/API/failure mode
  → Peer chỉ implement assumption
  → dependency thật xuất hiện muộn
  → compatibility patch chồng lên foundation sai
```

Plan tốt định nghĩa outcome, boundary, risk và checkpoint. Nó không giả vờ rằng
mọi file/API đã biết chắc.

## 7.4 One writer, stable snapshot

Review một moving target tạo false confidence:

```text
Reviewer đọc file A lúc 10:00
Writer sửa file A lúc 10:02
Reviewer approve lúc 10:05
Candidate được integrate không phải candidate đã review
```

Stable candidate có thể là commit hoặc deterministic workspace snapshot nếu
user không cấp commit authority.

## 7.5 Verification không đồng nghĩa acceptance

- Engineer sở hữu proof cho write của mình.
- Reviewer falsify exact candidate.
- Lead chốt project acceptance.
- Human chốt owner-only trade-off.

Test pass chứng minh một tập behavior; không chứng minh architecture tốt, product
đúng hoặc change được phép deploy.

## 7.6 Sparse, event-driven supervision

Orchestration quality phụ thuộc attention. Monitoring liên tục tiêu attention
nhưng không tạo information mới. Supervisor/Lead chỉ nên can thiệp khi có event,
evidence hoặc deadline có nghĩa.

## 7.7 Continuous optimization thuộc protocol

Infrastructure thay đổi chậm và dùng chung. Workflow thay đổi theo repo và theo
bài học mới.

```text
Anti-pattern mới được quan sát
  → Supervisor ghi causal context
  → Human/Lead xem có lặp lại không
  → patch Workspace Protocol version mới
  → không fork Paseo thành một bản riêng
```

## 7.8 Skill topology theo attention

- Lead: macro skills — decomposition, architecture framing, routing, review,
  synthesis, verification.
- Supervisor: strategy/management — timeline analysis, anti-pattern detection,
  causal notebook, recovery.
- Peer: micro skills — language/framework/test/debug/research.

Đừng cho Lead quá nhiều implementation skill hoặc Peer quá nhiều orchestration
skill. Tool khả dụng cũng định hình attention và hành vi.

---

## 8. Anti-pattern catalog

## 8.1 Sheep / authority-gradient compliance

**Dấu hiệu:** Peer lặp lại premise của Lead, không kiểm foundation, mọi response
đều “agreed”.

**Cơ chế:** brief đã chứa verdict; Peer tối ưu để làm vừa authority.

**Phản ứng:** gửi evidence và câu hỏi mở; yêu cầu reaction `CONFIRM`, `PARTIAL`,
`CHALLENGE`, `BLOCK`; không yêu cầu “hãy phản biện”.

**Cực đối lập cần tránh:** contrarianism biểu diễn — phản đối không evidence.

## 8.2 Pre-solving / perfect-plan trap

**Dấu hiệu:** plan định trước toàn bộ file, API, lifecycle và solution; Peer chỉ
được PASS/FAIL.

**Cơ chế:** Lead đã implement trong plan bằng assumptions chưa được thử.

**Phản ứng:** chuyển plan thành provisional map; cho Peer reopen premise.

## 8.3 Parachute optimization instead of brakes

Ví dụ trực tiếp của Demonthorn: nhiều agent cùng tối ưu chiếc dù để xe đạp giảm
tốc từ 100 xuống 0, trong khi Lead phải nhận ra cần làm phanh.

**Dấu hiệu:** correction thứ ba vẫn sửa cùng symptom; complexity tăng nhưng root
mechanism không đổi.

**Phản ứng:** dừng local patch, hỏi “shared mechanism nào tạo ra cả chuỗi lỗi?”.

## 8.4 Architecture lock-in

**Dấu hiệu:** feature vẫn chạy nhưng mỗi thay đổi sau cần adapter/exception mới;
agent coi architecture ban đầu là bất biến.

**Cơ chế:** Agent mạnh có thể ép feature chạy trên foundation yếu lâu hơn Human,
nên failure lộ ra muộn nhưng debt lớn.

**Phản ứng:** independent architecture review, alternatives, strongest
counterargument, reversal conditions; double-check quyết định khó đảo ngược.

## 8.5 Architecture fog

**Dấu hiệu:** nhiều abstraction, layer và term nhưng ownership/lifecycle không
thể nói bằng một câu; agent tiếp tục thêm wrapper để tránh quyết định.

**Phản ứng:** yêu cầu concrete state owner, transition, failure semantics và
deletion test: bỏ abstraction nào thì behavior nào mất?

## 8.6 Moving-scope collision

**Dấu hiệu:** hai Engineer sửa cùng subsystem; reviewer đọc giữa lúc writer đang
thay đổi.

**Phản ứng:** one writer per moving scope, worktree isolation, explicit handback,
stable candidate digest.

## 8.7 Self-benchmark / self-acceptance

**Dấu hiệu:** cùng agent thiết kế benchmark, implement, chạy benchmark và tuyên
bố thành công.

**Cơ chế:** metric và implementation chia sẻ cùng blind spot.

**Phản ứng:** Human/Lead xác định success boundary; independent Reviewer cho
decision quan trọng; Engineer vẫn chịu trách nhiệm proof cho writes.

## 8.8 Test-shaped proof

**Dấu hiệu:** test được viết để khớp implementation, mock mất failure thật, hoặc
test pass nhưng không chứng minh user outcome.

**Phản ứng:** hỏi test sẽ fail dưới mechanism sai nào; bổ sung integration,
migration, cancellation hoặc human evidence phù hợp.

## 8.9 Overengineering an edge case

**Dấu hiệu:** hàng nghìn dòng infrastructure để che một edge case nhỏ; cost bảo
trì lớn hơn risk.

**Phản ứng:** lượng hóa frequency, impact, simpler fallback và reversal cost;
không mặc định “đầy đủ hơn” là tốt hơn.

## 8.10 Polling/loop debt

**Dấu hiệu:** Lead liên tục hỏi agent đã xong chưa; retry cùng tool call khi
prerequisite không đổi; heartbeat trở thành worker ẩn.

**Phản ứng:** event-driven notification, bounded wait, sau hai failure giống nhau
kiểm prerequisite/quota/auth/authority.

## 8.11 Ceremony capture

**Dấu hiệu:** mọi task đều council, nhiều vote, nhiều report; process nhiều hơn
evidence.

**Cơ chế:** số agent tạo cảm giác chắc chắn giả và làm loãng attention.

**Phản ứng:** smallest useful topology; council chỉ cho proposition thật sự độc
lập và decision-changing; provider count không tạo authority.

## 8.12 Debate framing capture

**Dấu hiệu:** Lead đặt hai lựa chọn đều nằm trong framing sai; challenger chỉ
tranh luận bên trong khung đó.

**Phản ứng:** yêu cầu Architect reconstruct real problem trước khi xem preferred
solution; dùng sealed report khi cần.

## 8.13 Forked independence

**Dấu hiệu:** Reviewer là fork của Lead rồi được gọi là “independent”.

**Phản ứng:** fresh session, neutral brief, exact candidate, không inherit hidden
chain-of-thought/framing.

## 8.14 Root attention dilution

**Dấu hiệu:** Human hỏi Root mọi câu; Root dành context giải thích thay vì giữ
dependency, topology và acceptance state.

**Phản ứng:** dùng Supervisor hoặc ordinary advisory session cho Q&A; gửi owner
decision đã cô đọng tới Lead/Root.

## 8.15 Skill pollution

**Dấu hiệu:** Peer tự orchestrate; Lead lao vào framework micro-details; mỗi role
load hàng chục skill không liên quan.

**Phản ứng:** macro skill cho Lead, strategy skill cho Supervisor, micro skill
cho Peer; progressive disclosure.

## 8.16 Status-as-acceptance

**Dấu hiệu:** `finished` hoặc “tests pass” được báo thành hoàn tất mà không xem
diff, scope, candidate hay independent evidence.

**Phản ứng:** lifecycle status chỉ wake owner; acceptance chạy trên exact
artifact và authority chain.

## 8.17 Supervisor overreach

**Dấu hiệu:** Supervisor thấy issue rồi trực tiếp sửa code, ra architecture
verdict hoặc micromanage Peer.

**Cơ chế:** governance plane biến thành một Lead thứ hai; authority conflict.

**Phản ứng:** Supervisor đặt evidence-backed question, relay owner decision hoặc
đề xuất handoff/new Lead; chỉ can thiệp implementation khi có recovery mandate
rõ ràng.

---

## 9. Topology theo độ khó

### Tiny task

```text
Lead → one Engineer → focused checks → Lead inspect
```

Không cần committee.

### Bounded implementation

```text
Lead
  → Engineer in isolated workspace
  → stable candidate
  → Reviewer if protocol/risk requires
  → Lead verdict
```

### Architecture-sensitive vertical slice

```text
Lead
  → Architect (read-only, neutral brief)
  → Lead binding design decision
  → Engineer (one moving scope)
  → independent Reviewer (falsification)
  → correction in same Engineer session
  → new stable candidate
  → Lead verdict
```

### Difficult council

```text
Lead
  ├── Architect A: ownership/lifecycle/alternatives
  └── Reviewer B: failure/falsification/migration risk

sealed reports
  → Lead extracts 3–5 material propositions
  → verify only decision-changing claims
  → at most one challenge/response per proposition
  → one binding verdict
```

Council không phải vote popularity. Mỗi seat cần distinct mandate.

### Nhiều project/workspace

```text
Human
  ├── Supervisor quan sát workflow của nhiều workspace
  ├── Lead project A → Peer(s) → evidence A
  └── Lead project B → Peer(s) → evidence B
```

Mỗi Lead vẫn sở hữu project authority trong workspace của mình. Supervisor nhìn
ngang qua nhiều workflow để phát hiện pattern, nhưng không dùng evidence của
project A để accept project B và không trở thành Lead chung của cả hai.

---

## 10. Checklist vận hành

### Trước khi launch

- [ ] Đúng repository root và project identity.
- [ ] Lead đã đọc `WORKSPACE_PROTOCOL.md`.
- [ ] Provider/model/workspace ID được inspect, không đoán.
- [ ] Task có objective, ownership, exclusions, authority, verification.
- [ ] Concurrent writer có worktree riêng.
- [ ] Brief không chứa verdict trá hình.

### Khi task đang chạy

- [ ] Không polling vô hạn.
- [ ] Peer có quyền `REOPEN`, `DEPENDENCY`, `BLOCKED`.
- [ ] Scope expansion chỉ được đề xuất, chưa tự thi hành.
- [ ] Finding là hypothesis có evidence.
- [ ] Supervisor/Lead không coi disagreement là disobedience.
- [ ] Repeated correction kích hoạt root-mechanism check.

### Trước acceptance

- [ ] Candidate ổn định và có exact identity.
- [ ] Actual diff/artifact đã được inspect.
- [ ] Verification command/result có thật.
- [ ] Reviewer độc lập nếu protocol yêu cầu.
- [ ] Review đúng exact candidate.
- [ ] Unresolved finding còn hiển thị.
- [ ] Người accept có đúng authority.
- [ ] Không còn heartbeat/schedule task-local bị bỏ quên.

---

## 11. Kết luận

Giá trị lớn nhất trong mô hình Demonthorn không nằm ở tên `Root`, `Lead`,
`Supervisor` hay số agent. Nó nằm ở cách bảo vệ **independent judgment và
attention**.

```text
Profile
  → giữ role invariant

Workspace Protocol
  → giữ chiến thuật riêng của repo

Task prompt
  → cấp bounded ownership và authority

Paseo
  → giữ lifecycle, workspace và control-plane truth

Evidence chain
  → giữ acceptance không trượt thành cảm giác
```

Một hệ thống orchestration tốt không làm Peer phục tùng hơn. Nó làm cho:

- đúng người có đúng authority;
- mỗi agent nhìn đúng lượng context;
- disagreement có đường đi;
- moving code có owner;
- review gắn với candidate thật;
- strategy có thể tiến hóa mà không phải fork infrastructure.

Điểm kết tinh của mô hình là tách **governance Supervisor** khỏi **Project
Lead**, giữ Peer như một independent co-worker, và đưa chiến thuật riêng của
từng repository vào `WORKSPACE_PROTOCOL.md` thay vì đóng cứng trong control
plane hay nhồi vào mọi task prompt.

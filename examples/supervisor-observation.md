# Example: Supervisor observation

Khuôn này minh họa cách Supervisor chuyển một quan sát thành evidence-backed
question. Supervisor không sửa code, không điều phối Peer — chỉ gửi observation
cho Lead hoặc Human.

```text
OBSERVATION:
Lead assigned two Engineer Peers (T-003, T-004) with overlapping OWNED_SCOPE
in src/storage/**. Two writers on the same moving scope risk lost updates.

EVIDENCE:
- create_agent T-003 at 09:12: owned scope "src/storage/**"
- create_agent T-004 at 09:15: owned scope "src/storage/**"
- No worktree isolation was requested for either agent.

IMPACT:
Possible moving-scope collision: reviewers read one state while writers
overwrite another; integration cost and revert risk increase.

OPEN_QUESTION:
Should one of the two writers be moved to an isolated worktree, or should the
scope be split into non-overlapping ownership?

RECOMMENDATION:
Split the scope or isolate one writer before both produce candidates.

ESCALATION:
None — decision is within Lead authority.
```

Ghi chú: nếu observation lặp lại lần thứ ba cùng một symptom, hãy nêu câu hỏi
root-mechanism thay vì yêu cầu một local patch khác.

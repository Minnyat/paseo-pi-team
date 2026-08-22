import assert from "node:assert/strict";
import {
	degradedSentence,
	humanizeError,
	missingSetup,
	overallHealth,
	permitSentence,
	relativeTime,
	roleLabel,
	statusLabel,
	toolMeaning,
} from "../webui/public/humanize.js";

// This module is the entire non-technical vocabulary of the WebUI, so it is
// kept DOM-free and tested here rather than eyeballed in a browser.

// --- labels ---------------------------------------------------------------
assert.equal(roleLabel("lead"), "Trưởng nhóm");
assert.equal(roleLabel("peer"), "Thành viên");
assert.equal(roleLabel(undefined), "Chưa rõ vai trò", "an unknown role is never silently blank");
assert.equal(statusLabel("running"), "Đang làm việc");
assert.equal(statusLabel("ERROR"), "Gặp lỗi", "status casing from the daemon does not matter");
assert.equal(statusLabel("something-new"), "something-new", "an unmapped status is shown as-is, not swallowed");

// --- tool risk ------------------------------------------------------------
assert.equal(toolMeaning("write").risk, "high");
assert.equal(toolMeaning("bash").risk, "high");
assert.equal(toolMeaning("archive_agent").risk, "high");
assert.equal(toolMeaning("read").risk, "low");
assert.equal(toolMeaning("list_agents").risk, "low");
// The important one: anything unclassified must NOT be presented as safe.
assert.equal(toolMeaning("frobnicate_9000").risk, "unknown");
assert.equal(toolMeaning("").risk, "unknown");
assert.equal(toolMeaning(undefined).risk, "unknown");
assert.match(toolMeaning("bash").what, /chạy lệnh/);

assert.match(permitSentence({ tool: "write" }, "Fix login bug"), /Fix login bug.*sửa hoặc tạo file/s);
assert.match(permitSentence({ tool: "write" }, ""), /^Một agent/);

// --- errors carry an action, never just a code ---------------------------
{
	const daemon = humanizeError({ code: "CLI_FAILED", stderr: "paseo daemon unreachable" });
	assert.match(daemon.title, /Chưa kết nối/);
	assert.match(daemon.advice, /paseo start/);

	const timeout = humanizeError({ stderr: "paseo-team timed out" });
	assert.match(timeout.advice, /paseo restart/);

	const auth = humanizeError({ code: "UNAUTHORIZED", message: "missing or invalid bearer token" });
	assert.match(auth.title, /hết hạn/);

	const install = humanizeError({ stderr: "prompt not installed for role 'lead'" });
	assert.match(install.advice, /install/);

	// Unknown failures still get a next step instead of a dead end.
	const unknown = humanizeError({ code: "WAT", message: "something odd" });
	assert.equal(unknown.title, "Có lỗi xảy ra");
	assert.match(unknown.advice, /Chi tiết kỹ thuật/);
	assert.match(unknown.technical, /something odd/);

	// The raw text is preserved for whoever does read codes.
	assert.match(humanizeError({ command: "paseo-team graph", stderr: "boom" }).technical, /paseo-team graph.*boom/);
}

// --- relative time --------------------------------------------------------
const now = Date.parse("2026-08-21T12:00:00.000Z");
assert.equal(relativeTime("2026-08-21T11:59:58.000Z", now), "vừa xong");
assert.equal(relativeTime("2026-08-21T11:59:30.000Z", now), "30 giây trước");
assert.equal(relativeTime("2026-08-21T11:45:00.000Z", now), "15 phút trước");
assert.equal(relativeTime("2026-08-21T09:00:00.000Z", now), "3 giờ trước");
assert.equal(relativeTime("2026-08-19T12:00:00.000Z", now), "2 ngày trước");
assert.equal(relativeTime("not a date", now), "không rõ");
assert.equal(relativeTime(undefined, now), "không rõ");

// --- setup gaps -----------------------------------------------------------
{
	const complete = { presence: { policyExtension: true, paseoConfig: true, prompts: { supervisor: true, lead: true, peer: true } } };
	assert.deepEqual(missingSetup(complete), []);

	const partial = { presence: { policyExtension: false, paseoConfig: true, prompts: { supervisor: true, lead: false, peer: false } } };
	const missing = missingSetup(partial);
	assert.equal(missing.length, 2);
	assert.match(missing[1], /Trưởng nhóm.*Thành viên/, "missing prompts are named by role, not by filename");
}

// --- the home headline ranks by urgency -----------------------------------
{
	const status = { presence: { policyExtension: true, paseoConfig: true, prompts: { supervisor: true, lead: true, peer: true } } };
	const graph = { ok: true, nodes: [{ status: "running" }, { status: "idle" }] };

	assert.equal(overallHealth({}).level, "bad", "no status at all is a problem, not a green light");

	// A blocked agent outranks everything else — it is the only thing that
	// stops work until a human answers.
	const waiting = overallHealth({ status, graph, permits: { count: 2 } });
	assert.equal(waiting.level, "attention");
	assert.match(waiting.headline, /2 việc đang chờ bạn duyệt/);

	const one = overallHealth({ status, graph, permits: { count: 1 } });
	assert.match(one.headline, /1 việc/, "singular is not '1 việc(s)'");

	const brokenList = overallHealth({ status, graph: { ok: false }, permits: { count: 0 } });
	assert.equal(brokenList.level, "bad");

	const notInstalled = overallHealth({
		status: { presence: { policyExtension: false, paseoConfig: true, prompts: {} } },
		graph,
		permits: { count: 0 },
	});
	assert.equal(notInstalled.level, "attention");
	assert.match(notInstalled.detail, /install/);

	const errored = overallHealth({ status, graph: { ok: true, nodes: [{ status: "error" }] }, permits: { count: 0 } });
	assert.match(errored.headline, /1 agent đang gặp lỗi/);

	const fine = overallHealth({ status, graph, permits: { count: 0 } });
	assert.equal(fine.level, "good");
	assert.match(fine.headline, /1 agent đang làm việc/);
}

// --- degraded data is stated, never hidden --------------------------------
assert.equal(degradedSentence([], 0), "", "a clean snapshot says nothing");
assert.match(degradedSentence([{ reason: "PARENT_NOT_LISTED" }], 0), /ngoài danh sách/);
assert.match(degradedSentence([{ reason: "TIMEOUT" }, { reason: "INSPECT_FAILED" }], 0), /2 mục không lấy được/);
assert.match(degradedSentence([{ reason: "PERMIT_SHAPE_UNRECOGNIZED" }], 0), /không đọc được nội dung/);
assert.match(degradedSentence([], 5), /còn 5 agent chưa xếp xong/);

console.log("humanize tests passed");

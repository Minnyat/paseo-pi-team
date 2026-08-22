/**
 * app.js — the WebUI client.
 *
 * It renders whatever `paseo-team` returned and nothing else: no field is
 * computed here that the CLI did not send, so what you see on screen can
 * always be reproduced by running the same command in a terminal.
 *
 * Two audiences share this page. The default ("Chế độ đơn giản") is written for
 * someone who will never open a terminal: their job is to watch the team and
 * answer permission requests, so every code, id and file path is either
 * translated or hidden behind a disclosure. Advanced mode adds the editors that
 * only make sense if you know what a JSON config is.
 *
 * Everything is inserted with textContent, never innerHTML: agent names and
 * chat bodies are model-authored text, and this page holds a token that can
 * approve permission requests.
 */

import {
	ROLE_HINT,
	degradedSentence,
	humanizeError,
	missingSetup,
	overallHealth,
	permitSentence,
	relativeTime,
	RISK_LABEL,
	roleLabel,
	statusLabel,
	toolMeaning,
} from "./humanize.js";

// --- token -----------------------------------------------------------------

const TOKEN_KEY = "paseo-team-token";

function bootToken() {
	const fromHash = /(?:^|[#&])token=([^&]+)/.exec(location.hash || "");
	if (fromHash) {
		sessionStorage.setItem(TOKEN_KEY, decodeURIComponent(fromHash[1]));
		// Drop it from the address bar so a screenshot or a shared URL does not
		// hand over the ability to approve tool calls.
		history.replaceState(null, "", location.pathname + location.search);
	}
	return sessionStorage.getItem(TOKEN_KEY) ?? "";
}

let token = bootToken();

// --- tiny DOM helpers ------------------------------------------------------

const $ = (id) => document.getElementById(id);

function el(tag, props = {}, children = []) {
	const node = document.createElement(tag);
	for (const [key, value] of Object.entries(props)) {
		if (key === "class") node.className = value;
		else if (key === "text") node.textContent = value;
		else if (key.startsWith("on")) node.addEventListener(key.slice(2), value);
		else if (value !== null && value !== undefined) node.setAttribute(key, value);
	}
	for (const child of [].concat(children)) {
		if (child) node.appendChild(typeof child === "string" ? document.createTextNode(child) : child);
	}
	return node;
}

function svgEl(tag, props = {}, children = []) {
	const node = document.createElementNS("http://www.w3.org/2000/svg", tag);
	for (const [key, value] of Object.entries(props)) {
		if (key === "text") node.textContent = value;
		else if (key.startsWith("on")) node.addEventListener(key.slice(2), value);
		else if (value !== null && value !== undefined) node.setAttribute(key, value);
	}
	for (const child of [].concat(children)) node.appendChild(child);
	return node;
}

function clear(node) {
	while (node.firstChild) node.removeChild(node.firstChild);
	return node;
}

/** An error the reader can act on, with the raw text one click away. */
function errorBlock(error) {
	const info = error?.human ?? humanizeError({ message: error?.message });
	return el("div", { class: "error-block" }, [
		el("strong", { text: info.title }),
		el("p", { text: info.advice }),
		el("details", {}, [el("summary", { text: "Chi tiết kỹ thuật" }), el("pre", { text: info.technical })]),
	]);
}

let toastTimer = null;
function toast(message, isError = false) {
	const node = $("toast");
	node.textContent = message;
	node.classList.toggle("err", isError);
	node.classList.remove("hidden");
	clearTimeout(toastTimer);
	toastTimer = setTimeout(() => node.classList.add("hidden"), isError ? 10_000 : 3500);
}

function toastError(error) {
	const info = error?.human ?? humanizeError({ message: error?.message });
	toast(`${info.title}. ${info.advice}`, true);
}

// --- API -------------------------------------------------------------------

let inFlight = 0;
/** The CLI command behind the last answer — shown only in advanced mode. */
let lastCommand = "";

function paintConnection(state, extra = "") {
	const node = $("conn");
	node.className = `conn ${state}`;
	node.textContent =
		state === "busy" ? "đang cập nhật…" : state === "err" ? "mất kết nối" : `đã cập nhật ${extra}`.trim();
}

async function api(path, { method = "GET", body = null, raw = null } = {}) {
	inFlight += 1;
	paintConnection("busy");
	const headers = { authorization: `Bearer ${token}` };
	if (body !== null || raw !== null) headers["content-type"] = "application/json";
	let response;
	try {
		response = await fetch(path, {
			method,
			headers,
			body: raw !== null ? raw : body !== null ? JSON.stringify(body) : undefined,
		});
	} catch (cause) {
		inFlight -= 1;
		paintConnection("err");
		const error = new Error(cause.message);
		error.human = {
			title: "Không liên lạc được với máy chủ trên máy bạn",
			advice: "Cửa sổ dòng lệnh chạy 'paseo-team web' có thể đã bị đóng. Mở lại rồi tải lại trang.",
			technical: String(cause.message),
		};
		throw error;
	}
	inFlight -= 1;
	const payload = await response
		.json()
		.catch(() => ({ ok: false, code: "BAD_RESPONSE", message: "máy chủ trả về nội dung không đọc được" }));
	if (payload.command) lastCommand = payload.command;
	if (!response.ok || payload.ok === false) {
		paintConnection("err");
		if (response.status === 401) {
			// The stored token outlived the server that issued it. Drop it, or
			// every later action fails with the same opaque 401.
			sessionStorage.removeItem(TOKEN_KEY);
			token = "";
		}
		const error = new Error(payload.message ?? payload.code ?? `HTTP ${response.status}`);
		error.human = humanizeError(payload);
		error.payload = payload;
		throw error;
	}
	if (inFlight === 0) paintConnection("ok", "vừa xong");
	return payload;
}

// --- simple / advanced mode ------------------------------------------------

const ADVANCED_KEY = "paseo-team-advanced";
let advanced = localStorage.getItem(ADVANCED_KEY) === "1";

function applyMode() {
	document.body.classList.toggle("advanced", advanced);
	$("advanced-toggle").checked = advanced;
	// Leaving a hidden tab selected would show an empty page.
	if (!advanced && (activeTab === "config" || activeTab === "roles")) selectTab("home");
}

$("advanced-toggle").addEventListener("change", (event) => {
	advanced = event.target.checked;
	localStorage.setItem(ADVANCED_KEY, advanced ? "1" : "0");
	applyMode();
});

// --- tabs ------------------------------------------------------------------

const loaders = {};
let activeTab = "home";

function selectTab(name) {
	activeTab = name;
	for (const button of document.querySelectorAll("#tabs button")) {
		button.classList.toggle("active", button.dataset.tab === name);
	}
	for (const section of document.querySelectorAll(".tab")) {
		section.classList.toggle("active", section.id === `tab-${name}`);
	}
	loaders[name]?.();
}

$("tabs").addEventListener("click", (event) => {
	const tab = event.target?.closest?.("button")?.dataset?.tab;
	if (tab) selectTab(tab);
});

// --- shared state ----------------------------------------------------------

let lastGraph = null;
let lastStatus = null;
let lastPermits = null;

function setBadge(count) {
	const badge = $("permit-badge");
	badge.textContent = String(count);
	badge.classList.toggle("hidden", !count);
}

function kvTable(pairs) {
	const table = el("table");
	for (const [key, value] of pairs) {
		table.appendChild(
			el("tr", {}, [
				el("th", { text: key }),
				el("td", { class: "v", text: value === true ? "có" : value === false ? "không" : String(value ?? "—") }),
			]),
		);
	}
	return table;
}

// --- home ------------------------------------------------------------------

const HEALTH_ICON = { good: "✓", attention: "!", bad: "×" };

function paintHealth() {
	const health = overallHealth({ status: lastStatus, graph: lastGraph, permits: lastPermits });
	$("health").className = `health ${health.level}`;
	$("health-icon").textContent = HEALTH_ICON[health.level] ?? "…";
	$("health-headline").textContent = health.headline;
	$("health-detail").textContent = health.detail;

	const actions = clear($("health-actions"));
	if ((lastPermits?.count ?? 0) > 0) {
		actions.appendChild(
			el("button", { class: "primary big", text: "Xem việc chờ duyệt", onclick: () => selectTab("permissions") }),
		);
	} else if (lastGraph?.nodes?.some((node) => node.status === "error")) {
		actions.appendChild(el("button", { class: "big", text: "Xem agent gặp lỗi", onclick: () => selectTab("graph") }));
	}

	const nodes = lastGraph?.nodes ?? [];
	$("stat-running").textContent = nodes.filter((node) => node.status === "running").length;
	$("stat-permits").textContent = lastPermits?.count ?? 0;
	$("stat-errors").textContent = nodes.filter((node) => node.status === "error").length;
	$("stat-total").textContent = nodes.length;
}

function paintSetup() {
	const body = clear($("setup-body"));
	if (!lastStatus) {
		body.appendChild(el("p", { class: "hint", text: "Chưa đọc được." }));
		return;
	}
	const missing = missingSetup(lastStatus);
	if (missing.length === 0) {
		body.appendChild(el("p", { class: "ok", text: "✓ Đã cài đủ: bộ quy tắc phân quyền, mô tả vai trò và cấu hình Paseo." }));
	} else {
		body.appendChild(el("p", { class: "no", text: `Còn thiếu: ${missing.join(", ")}.` }));
		body.appendChild(
			el("p", { class: "hint", text: "Mở cửa sổ dòng lệnh trong thư mục dự án và chạy: npm run paseo-team -- install" }),
		);
	}
	if (advanced) {
		body.appendChild(
			el("details", {}, [el("summary", { text: "Đường dẫn file" }), kvTable(Object.entries(lastStatus.paths ?? {}))]),
		);
	}
}

loaders.home = async () => {
	paintHealth();
	paintSetup();
	await Promise.allSettled([refreshStatus(), refreshGraph({ silent: true }), refreshPermits({ silent: true })]);
	paintHealth();
	paintSetup();
};

async function refreshStatus() {
	try {
		lastStatus = (await api("/api/status")).data;
	} catch (error) {
		lastStatus = null;
		if (activeTab === "home") toastError(error);
	}
}

$("preflight-run").addEventListener("click", async () => {
	const body = clear($("preflight-body"));
	body.appendChild(el("p", { class: "hint", text: "Đang kiểm tra… việc này mất khoảng 30 giây." }));
	try {
		const { data } = await api("/api/preflight");
		const checks = Array.isArray(data?.checks) ? data.checks : [];
		clear(body);
		if (checks.length === 0) {
			body.appendChild(el("pre", { text: JSON.stringify(data, null, 2).slice(0, 4000) }));
			return;
		}
		const failed = checks.filter((check) => check.status !== "pass");
		body.appendChild(
			el("p", {
				class: failed.length === 0 ? "ok" : "no",
				text:
					failed.length === 0
						? `✓ ${checks.length} mục đều đạt.`
						: `${failed.length}/${checks.length} mục chưa đạt.`,
			}),
		);
		const table = el("table");
		for (const check of failed.length > 0 ? failed : checks) {
			table.appendChild(
				el("tr", {}, [
					el("th", { text: check.id ?? "mục" }),
					el("td", { class: check.status === "pass" ? "ok" : "no", text: check.status ?? "?" }),
					el("td", { text: check.detail ?? "" }),
				]),
			);
		}
		body.appendChild(table);
	} catch (error) {
		clear(body).appendChild(errorBlock(error));
	}
});

// --- permissions -----------------------------------------------------------

function nodeFor(agentId) {
	return lastGraph?.nodes?.find((node) => node.id === agentId) ?? null;
}

function agentNameFor(agentId) {
	return nodeFor(agentId)?.name ?? "";
}

async function decide(action, permit, card) {
	const meaning = toolMeaning(permit.tool);
	if (action === "allow" && meaning.risk !== "low") {
		// A high-impact approval gets one deliberate extra step. A non-technical
		// reader cannot judge a tool name, so the confirm restates the effect.
		if (!confirm(`Cho phép agent ${meaning.what}?\n\nHành động này thực hiện ngay trên máy của bạn.`)) return;
	}
	for (const button of card.querySelectorAll("button")) button.disabled = true;
	try {
		await api("/api/permits/decide", {
			method: "POST",
			body: { action, agentId: permit.agentId, requestId: permit.requestId },
		});
		toast(action === "allow" ? "Đã cho phép. Agent sẽ chạy tiếp." : "Đã từ chối.");
		await refreshPermits();
		renderPermits();
	} catch (error) {
		toastError(error);
		for (const button of card.querySelectorAll("button")) button.disabled = false;
	}
}

function permitCard(permit) {
	const meaning = toolMeaning(permit.tool);
	const node = nodeFor(permit.agentId);
	const card = el("div", { class: `permit risk-${meaning.risk}` });
	card.appendChild(el("div", { class: "risk-tag", text: RISK_LABEL[meaning.risk] }));
	card.appendChild(el("p", { class: "permit-headline", text: permitSentence(permit, agentNameFor(permit.agentId)) }));

	const facts = el("dl", { class: "facts" });
	const addFact = (term, value) => {
		if (!value) return;
		facts.appendChild(el("dt", { text: term }));
		facts.appendChild(el("dd", { text: String(value) }));
	};
	addFact("Agent", agentNameFor(permit.agentId) || "không rõ tên");
	if (node) addFact("Vai trò", roleLabel(node.role));
	if (node) addFact("Thư mục", node.cwd);
	if (advanced) {
		addFact("Công cụ", permit.tool ?? "không rõ");
		addFact("Mã yêu cầu", permit.requestId);
	}
	card.appendChild(facts);

	const allow = el("button", { class: "primary big", text: "Cho phép" });
	const deny = el("button", { class: "danger big", text: "Từ chối" });
	allow.addEventListener("click", () => decide("allow", permit, card));
	deny.addEventListener("click", () => decide("deny", permit, card));
	card.appendChild(el("div", { class: "permit-actions" }, [allow, deny]));

	if (advanced) {
		card.appendChild(
			el("details", {}, [el("summary", { text: "Dữ liệu gốc" }), el("pre", { text: JSON.stringify(permit.raw, null, 2) })]),
		);
	}
	return card;
}

let permitsRenderedSig = "";

function renderPermits() {
	// The 20s poll calls this even when nothing changed; a rebuild would
	// collapse an open disclosure mid-read, so an identical payload is a no-op.
	const sig = `${advanced}|${lastPermits ? JSON.stringify(lastPermits) : "loading"}`;
	if (sig === permitsRenderedSig) return;
	permitsRenderedSig = sig;
	const body = clear($("permits-body"));
	if (!lastPermits) {
		body.appendChild(el("p", { class: "hint", text: "Đang tải…" }));
		return;
	}
	const permits = lastPermits.permits ?? [];
	const unclassified = lastPermits.unclassified ?? [];
	if (permits.length === 0 && unclassified.length === 0) {
		body.appendChild(
			el("div", { class: "empty" }, [
				el("div", { class: "empty-icon", text: "✓" }),
				el("p", { text: "Không có việc nào chờ bạn duyệt." }),
				el("p", {
					class: "hint",
					text: "Khi một agent cần bạn đồng ý, nó sẽ hiện ở đây và con số trên tab sẽ nhảy lên.",
				}),
			]),
		);
		return;
	}
	for (const permit of permits) body.appendChild(permitCard(permit));
	for (const raw of unclassified) {
		body.appendChild(
			el("div", { class: "permit unclassified" }, [
				el("strong", { text: "Có yêu cầu xin phép nhưng không đọc được nội dung" }),
				el("p", {
					text: "Không xác định được agent nào và xin phép điều gì, nên không cho duyệt từ đây — để tránh đồng ý nhầm.",
				}),
				el("p", { class: "hint", text: "Nhờ người phụ trách xử lý bằng lệnh: paseo permit ls" }),
				el("details", {}, [el("summary", { text: "Dữ liệu gốc" }), el("pre", { text: JSON.stringify(raw, null, 2) })]),
			]),
		);
	}
}

async function refreshPermits({ silent = false } = {}) {
	try {
		lastPermits = (await api("/api/permits")).data;
		setBadge(lastPermits.count ?? 0);
	} catch (error) {
		if (!silent) toastError(error);
	}
}

loaders.permissions = async () => {
	renderPermits();
	await refreshPermits();
	renderPermits();
};

$("permits-refresh").addEventListener("click", () => loaders.permissions());

// --- team view: diagram + list --------------------------------------------

const NODE_W = 210;
const NODE_H = 56;
const COL_GAP = 90;
const ROW_GAP = 14;

let viewMode = "diagram";

function setView(mode) {
	viewMode = mode;
	$("view-diagram").classList.toggle("active", mode === "diagram");
	$("view-list").classList.toggle("active", mode === "list");
	$("diagram-wrap").classList.toggle("hidden", mode !== "diagram");
	$("list-wrap").classList.toggle("hidden", mode === "diagram");
	if (lastGraph) renderTeam(lastGraph);
}

$("view-diagram").addEventListener("click", () => setView("diagram"));
$("view-list").addEventListener("click", () => setView("list"));

/** Depth = distance to a root through parentId, cycle-guarded. */
function depthOf(node, byId, seen = new Set()) {
	let depth = 0;
	let current = node;
	while (current?.parentId && byId.has(current.parentId) && !seen.has(current.id)) {
		seen.add(current.id);
		current = byId.get(current.parentId);
		depth += 1;
		if (depth > 32) break;
	}
	return depth;
}

function roleClass(role) {
	return ["supervisor", "lead", "peer"].includes(role) ? role : "unknown";
}

function renderDiagram(graph) {
	const svg = clear($("graph"));
	const nodes = graph.nodes ?? [];
	const byId = new Map(nodes.map((node) => [node.id, node]));
	const columns = new Map();
	const placed = new Map();

	for (const node of nodes) {
		const depth = depthOf(node, byId);
		const column = columns.get(depth) ?? [];
		column.push(node);
		columns.set(depth, column);
	}

	let maxRows = 0;
	for (const [depth, column] of [...columns.entries()].sort((a, b) => a[0] - b[0])) {
		maxRows = Math.max(maxRows, column.length);
		column.forEach((node, row) => {
			placed.set(node.id, { x: 24 + depth * (NODE_W + COL_GAP), y: 24 + row * (NODE_H + ROW_GAP), node });
		});
	}

	const width = 48 + (columns.size || 1) * (NODE_W + COL_GAP);
	const height = Math.max(240, 48 + maxRows * (NODE_H + ROW_GAP));
	svg.setAttribute("viewBox", `0 0 ${width} ${height}`);
	svg.setAttribute("height", `${Math.min(height, 2400)}`);
	// Left-align instead of the default centring: a two-column tree in a wide
	// viewport would otherwise float in the middle with the roots off-centre.
	svg.setAttribute("preserveAspectRatio", "xMinYMin meet");

	for (const edge of graph.edges ?? []) {
		const from = placed.get(edge.from);
		const to = placed.get(edge.to);
		if (!from || !to) continue;
		const x1 = from.x + NODE_W;
		const y1 = from.y + NODE_H / 2;
		const x2 = to.x;
		const y2 = to.y + NODE_H / 2;
		const mid = (x1 + x2) / 2;
		svg.appendChild(
			svgEl("path", { class: `edge ${edge.type}`, d: `M ${x1} ${y1} C ${mid} ${y1}, ${mid} ${y2}, ${x2} ${y2}` }),
		);
	}

	for (const { x, y, node } of placed.values()) {
		const group = svgEl("g", { class: "node-box", transform: `translate(${x} ${y})`, onclick: () => openDrawer(node) });
		group.appendChild(
			svgEl("rect", {
				class: "node-rect",
				width: NODE_W,
				height: NODE_H,
				rx: 10,
				fill: "#1b2120",
				stroke: `var(--${roleClass(node.role)})`,
				"stroke-width": node.status === "running" ? 2.5 : 1.2,
				"stroke-dasharray": node.status === "error" ? "4 3" : null,
			}),
		);
		// A hover tooltip carries the untruncated name; the box shows a slice.
		group.appendChild(
			svgEl("title", { text: `${node.name || "(không tên)"} — ${roleLabel(node.role)}, ${statusLabel(node.status)}` }),
		);
		group.appendChild(svgEl("text", { class: "node-label", x: 12, y: 23, text: (node.name || "(không tên)").slice(0, 24) }));
		group.appendChild(
			svgEl("text", { class: "node-sub", x: 12, y: 41, text: `${roleLabel(node.role)} · ${statusLabel(node.status)}` }),
		);
		if (node.pendingPermissions > 0) {
			group.appendChild(svgEl("circle", { class: "badge-permit", cx: NODE_W - 16, cy: 16, r: 10 }));
			group.appendChild(
				svgEl("text", { class: "badge-text", x: NODE_W - 19.5, y: 20, text: String(node.pendingPermissions) }),
			);
		}
		svg.appendChild(group);
	}
}

function renderList(graph) {
	const wrap = clear($("agent-list"));
	// What needs a human first goes first: waiting on approval, then broken,
	// then working, then idle.
	const rank = (node) =>
		node.pendingPermissions > 0 ? 0 : node.status === "error" ? 1 : node.status === "running" ? 2 : 3;
	const nodes = [...(graph.nodes ?? [])].sort((a, b) => rank(a) - rank(b));
	if (nodes.length === 0) {
		wrap.appendChild(el("div", { class: "empty" }, [el("p", { text: "Chưa có agent nào." })]));
		return;
	}
	const byId = new Map(nodes.map((node) => [node.id, node]));
	const table = el("table", { class: "list" }, [
		el("tr", {}, [
			el("th", { text: "Tên việc" }),
			el("th", { text: "Vai trò" }),
			el("th", { text: "Trạng thái" }),
			el("th", { text: "Người giao việc" }),
			el("th", { text: "" }),
		]),
	]);
	for (const node of nodes) {
		const parent = node.parentId ? byId.get(node.parentId) : null;
		table.appendChild(
			el("tr", { class: node.status === "error" ? "row-error" : "" }, [
				el("td", {}, [
					el("span", { class: `dot-role ${roleClass(node.role)}` }),
					el("span", { text: node.name || "(không tên)" }),
					node.pendingPermissions > 0 ? el("span", { class: "pill", text: `${node.pendingPermissions} chờ duyệt` }) : null,
				]),
				el("td", { text: roleLabel(node.role) }),
				el("td", { class: node.status === "error" ? "no" : "", text: statusLabel(node.status) }),
				el("td", { text: parent ? parent.name || "(không tên)" : node.orphan ? "ngoài danh sách này" : "—" }),
				el("td", {}, [el("button", { text: "Chi tiết", onclick: () => openDrawer(node) })]),
			]),
		);
	}
	wrap.appendChild(table);
}

let teamRenderedSig = "";

function renderTeam(graph) {
	// Same payload, same picture: skip the diagram/list rebuild so the 5s poll
	// does not wipe hover state while idle. collectedAt / pendingParents /
	// inspectSpent move on every snapshot but only feed the meta line, the
	// degraded notice and diagnostics, which repaint below regardless.
	const { collectedAt, pendingParents, inspectSpent, ...stable } = graph;
	const sig = `${viewMode}|${advanced}|${JSON.stringify(stable)}`;
	if (sig !== teamRenderedSig) {
		teamRenderedSig = sig;
		if (viewMode === "diagram") renderDiagram(graph);
		else renderList(graph);
	}

	const counts = graph.counts ?? {};
	$("graph-meta").textContent = `${counts.agents ?? 0} agent · cập nhật ${relativeTime(graph.collectedAt)}`;

	const notice = $("graph-degraded");
	const sentence = degradedSentence(graph.degraded ?? [], graph.pendingParents ?? 0);
	notice.textContent = sentence;
	notice.classList.toggle("hidden", sentence === "");
}

function openDrawer(node) {
	const drawer = $("node-drawer");
	const body = clear($("drawer-body"));
	drawer.classList.remove("hidden");
	body.appendChild(el("h3", { text: node.name || "(không tên)" }));
	body.appendChild(el("p", { class: "drawer-sub", text: `${roleLabel(node.role)} · ${statusLabel(node.status)}` }));
	if (ROLE_HINT[node.role]) body.appendChild(el("p", { class: "hint", text: ROLE_HINT[node.role] }));

	const facts = [
		["Thư mục làm việc", node.cwd],
		["Chờ bạn duyệt", node.pendingPermissions || "không có"],
	];
	if (node.orphan) facts.push(["Người giao việc", "không có trong danh sách này (có thể đã lưu trữ)"]);
	if (advanced) facts.push(["Mã agent", node.id], ["Nhà cung cấp", node.provider], ["Mức suy nghĩ", node.thinking]);
	body.appendChild(kvTable(facts));

	body.appendChild(el("h4", { text: "Nhắn cho agent này" }));
	const input = el("textarea", { class: "drawer-input", placeholder: "Ví dụ: dừng lại và báo cáo tiến độ hiện tại" });
	const send = el("button", {
		class: "primary big",
		text: "Gửi",
		onclick: async () => {
			if (!input.value.trim()) {
				toast("Chưa nhập nội dung.", true);
				return;
			}
			send.disabled = true;
			try {
				await api("/api/agent/send", { method: "POST", body: { agentId: node.id, prompt: input.value } });
				toast("Đã gửi. Agent sẽ đọc khi rảnh.");
				input.value = "";
			} catch (error) {
				toastError(error);
			} finally {
				send.disabled = false;
			}
		},
	});
	body.appendChild(input);
	body.appendChild(send);
	if (advanced && lastCommand) body.appendChild(el("p", { class: "cmd", text: lastCommand }));
}

$("drawer-close").addEventListener("click", () => $("node-drawer").classList.add("hidden"));

async function refreshGraph({ silent = false } = {}) {
	try {
		lastGraph = (await api(`/api/graph${$("graph-all").checked ? "?all=1" : ""}`)).data;
		if (activeTab === "graph") renderTeam(lastGraph);
	} catch (error) {
		if (!silent) toastError(error);
	}
}

loaders.graph = async () => {
	if (lastGraph) renderTeam(lastGraph);
	await refreshGraph();
};

$("graph-refresh").addEventListener("click", () => refreshGraph());
$("graph-all").addEventListener("change", () => refreshGraph());

// A paseo round trip costs ~3s, so 5s is the floor that still leaves the daemon
// idle between polls. The server caches, so extra tabs cost nothing.
setInterval(() => {
	if (activeTab === "graph" && !document.hidden) refreshGraph({ silent: true });
}, 5000);

// The pending-approval count is the one thing worth knowing from any tab: an
// agent sitting on a permission request is stopped until somebody answers.
setInterval(async () => {
	if (document.hidden) return;
	await refreshPermits({ silent: true });
	if (activeTab === "permissions") renderPermits();
	if (activeTab === "home") paintHealth();
}, 20_000);

// --- roles -----------------------------------------------------------------

async function loadPrompt() {
	const role = $("role-select").value;
	$("role-hint").textContent = ROLE_HINT[role] ?? "";
	try {
		const { data } = await api(`/api/prompts?role=${encodeURIComponent(role)}`);
		$("prompt-editor").value = data.content ?? "";
		$("prompt-meta").textContent = data.path ?? "";
	} catch (error) {
		$("prompt-meta").textContent = "";
		toastError(error);
	}
}

$("prompt-load").addEventListener("click", loadPrompt);
$("role-select").addEventListener("change", loadPrompt);
$("prompt-save").addEventListener("click", async () => {
	const role = $("role-select").value;
	try {
		await api(`/api/prompts?role=${encodeURIComponent(role)}`, { method: "POST", body: { content: $("prompt-editor").value } });
		toast("Đã lưu. Bản cũ được sao lưu tự động.");
	} catch (error) {
		toastError(error);
	}
});

loaders.roles = async () => {
	if (!$("prompt-editor").value) await loadPrompt();
	if (!$("env-table").hasChildNodes()) await loadEnvTable();
};

async function loadEnvTable() {
	try {
		const { data } = await api("/api/env");
		const table = el("table", {}, [
			el("tr", {}, [el("th", { text: "Thiết lập" }), el("th", { text: "Hiện tại" }), el("th", { text: "Tác dụng" })]),
		]);
		for (const entry of data.env ?? []) {
			table.appendChild(
				el("tr", {}, [
					el("td", { class: "v", text: entry.key }),
					el("td", { class: entry.current ? "ok" : "k", text: entry.current ?? "chưa đặt" }),
					el("td", { text: entry.purpose }),
				]),
			);
		}
		clear($("env-table")).appendChild(table);
	} catch (error) {
		clear($("env-table")).appendChild(errorBlock(error));
	}
}

// --- config ----------------------------------------------------------------

async function loadConfig() {
	const section = $("config-section").value;
	try {
		const { data } = await api(`/api/config?section=${encodeURIComponent(section)}`);
		$("config-editor").value = JSON.stringify(data.data ?? {}, null, 2);
		$("config-meta").textContent = `${data.path}${data.exists ? "" : " (chưa tồn tại)"}`;
	} catch (error) {
		toastError(error);
	}
}

$("config-load").addEventListener("click", loadConfig);
$("config-section").addEventListener("change", loadConfig);
$("config-save").addEventListener("click", async () => {
	const section = $("config-section").value;
	const text = $("config-editor").value;
	try {
		JSON.parse(text); // fail here, before anything touches the file
	} catch (cause) {
		toast(`Nội dung chưa đúng định dạng JSON: ${cause.message}`, true);
		return;
	}
	try {
		await api(`/api/config?section=${encodeURIComponent(section)}`, { method: "POST", raw: text });
		toast("Đã lưu. Bản cũ được sao lưu kèm thời gian.");
	} catch (error) {
		toastError(error);
	}
});

loaders.config = async () => {
	if (!$("config-editor").value) await loadConfig();
};

// --- chat ------------------------------------------------------------------

loaders.chat = async () => {
	try {
		const { data } = await api("/api/chat");
		const select = clear($("chat-room"));
		const rooms = data.rooms ?? [];
		if (rooms.length === 0) {
			clear($("chat-body")).appendChild(
				el("div", { class: "empty" }, [
					el("div", { class: "empty-icon", text: "…" }),
					el("p", { text: "Chưa có phòng trao đổi nào." }),
					el("p", { class: "hint", text: "Phòng do người phụ trách tạo bằng lệnh: paseo chat create <tên>" }),
				]),
			);
			return;
		}
		for (const room of rooms) {
			const name = room?.name ?? room?.id ?? String(room);
			select.appendChild(el("option", { value: name, text: name }));
		}
	} catch (error) {
		clear($("chat-body")).appendChild(errorBlock(error));
	}
};

$("chat-load").addEventListener("click", async () => {
	const room = $("chat-room").value;
	if (!room) return;
	try {
		const { data } = await api(`/api/chat/read?room=${encodeURIComponent(room)}&limit=100`);
		const body = clear($("chat-body"));
		const messages = Array.isArray(data.messages) ? data.messages : [];
		if (messages.length === 0) {
			body.appendChild(el("p", { class: "hint", text: "Phòng này chưa có tin nhắn nào." }));
			return;
		}
		for (const message of messages) {
			const author = message.agentId ?? message.author ?? "";
			body.appendChild(
				el("div", { class: "message" }, [
					el("div", {
						class: "meta",
						text: `${agentNameFor(author) || author || "không rõ"} · ${relativeTime(message.createdAt ?? message.ts)}`,
					}),
					el("div", { text: String(message.body ?? message.message ?? JSON.stringify(message)) }),
				]),
			);
		}
	} catch (error) {
		toastError(error);
	}
});

// --- boot ------------------------------------------------------------------

applyMode();
if (!token) {
	toast("Thiếu mã truy cập. Mở đúng đường dẫn có #token=… mà cửa sổ dòng lệnh vừa in ra.", true);
}
selectTab("home");

import assert from "node:assert/strict";
import {
	ROUTES,
	bearerToken,
	createCache,
	handleApi,
	isAllowedHost,
	startServer,
} from "../webui/server.mjs";

// --- the route table is the whole attack surface ---------------------------
// There is no dynamic argv assembly: a path that is not a key here cannot
// reach the CLI at all.
{
	const echo = (args, stdin) => Promise.resolve({ exitCode: 0, stdout: "{}", stderr: "", args, stdin });

	await assert.rejects(
		handleApi({ method: "GET", pathname: "/api/nope", query: {}, exec: echo }),
		(error) => error.status === 404 && error.code === "NO_ROUTE",
	);
	// Same path, wrong verb: a GET-only route must not be reachable by POST.
	await assert.rejects(
		handleApi({ method: "POST", pathname: "/api/status", query: {}, exec: echo }),
		(error) => error.status === 404,
	);

	const status = await handleApi({ method: "GET", pathname: "/api/status", query: {}, exec: echo });
	assert.deepEqual(status.args, ["status"]);

	const graph = await handleApi({ method: "GET", pathname: "/api/graph", query: { all: "1", maxInspect: "8" }, exec: echo });
	assert.deepEqual(graph.args, ["graph", "--all", "--max-inspect", "8"]);

	const agents = await handleApi({ method: "GET", pathname: "/api/agents", query: {}, exec: echo });
	assert.deepEqual(agents.args, ["agents"], "a missing flag is absent, never the string 'undefined'");
}

// --- parameters are checked before they become argv ------------------------
{
	const echo = () => Promise.resolve({ exitCode: 0, stdout: "{}", stderr: "" });
	const rejects = (pathname, query, method = "GET", rawBody = "") =>
		assert.rejects(
			handleApi({ method, pathname, query, rawBody, exec: echo }),
			(error) => error.status === 400 && error.code === "PARAM_INVALID",
		);

	await rejects("/api/config", { section: "../../etc/passwd" });
	await rejects("/api/config", { section: "unknown" });
	await rejects("/api/prompts", { role: "root" });
	await rejects("/api/agent", { id: "not an id" });
	await rejects("/api/skill", { name: "../secret" });
	await rejects("/api/chat/read", { room: "a room with spaces" });
	await rejects("/api/graph", { maxInspect: "99999" });
	await rejects("/api/permits/decide", {}, "POST", JSON.stringify({ action: "approve-all", agentId: "aaaaaaaa", requestId: "r" }));
	await rejects("/api/permits/decide", {}, "POST", JSON.stringify({ action: "allow", agentId: "; rm -rf /", requestId: "r" }));

	// The happy path still builds the exact delegate command.
	const decided = await handleApi({
		method: "POST",
		pathname: "/api/permits/decide",
		query: {},
		rawBody: JSON.stringify({ action: "deny", agentId: "aaaa1111-2222-3333-4444-555555555555", requestId: "req-9" }),
		exec: echo,
	});
	assert.deepEqual(decided.args, ["permits", "deny", "aaaa1111-2222-3333-4444-555555555555", "req-9"]);
}

// --- config write forwards the raw document, not a re-serialized copy ------
{
	const raw = '{\n  "agents": { "providers": {} }\n}';
	const seen = await handleApi({
		method: "POST",
		pathname: "/api/config",
		query: { section: "providers" },
		rawBody: raw,
		exec: (args, stdin) => Promise.resolve({ exitCode: 0, stdout: "{}", stderr: "", stdin }),
	});
	assert.deepEqual(seen.args, ["config", "write", "providers"]);
	assert.equal(seen.stdin, raw, "the CLI receives the document byte-for-byte");
}

// --- host / origin checks --------------------------------------------------
assert.equal(isAllowedHost({ headers: { host: "127.0.0.1:4321" } }, 4321), true);
assert.equal(isAllowedHost({ headers: { host: "localhost:4321" } }, 4321), true);
// DNS rebinding: the name resolves to 127.0.0.1 but the Host header does not.
assert.equal(isAllowedHost({ headers: { host: "evil.example.com:4321" } }, 4321), false);
assert.equal(isAllowedHost({ headers: { host: "127.0.0.1:9999" } }, 4321), false);
assert.equal(isAllowedHost({ headers: { host: "127.0.0.1:4321", origin: "http://evil.example.com" } }, 4321), false);
assert.equal(isAllowedHost({ headers: {} }, 4321), false);

assert.equal(bearerToken({ headers: { authorization: "Bearer abc.def" } }), "abc.def");
assert.equal(bearerToken({ headers: { authorization: "Basic abc" } }), null);
assert.equal(bearerToken({ headers: {} }), null);

// --- cache: coalesce, expire, never memoize a failure ----------------------
{
	const cache = createCache();
	let calls = 0;
	const slow = () => new Promise((resolve) => setTimeout(() => { calls += 1; resolve({ exitCode: 0, stdout: "{}" }); }, 20));

	// Three tabs polling the same thing must cost one spawn, not three.
	const [a, b, c] = await Promise.all([
		cache.run("graph", 1000, slow),
		cache.run("graph", 1000, slow),
		cache.run("graph", 1000, slow),
	]);
	assert.equal(calls, 1, "concurrent identical requests are single-flighted");
	assert.ok(b.coalesced || c.coalesced);
	assert.equal(a.exitCode, 0);

	const hit = await cache.run("graph", 1000, slow);
	assert.equal(calls, 1);
	assert.equal(hit.cached, true);

	const expired = await cache.run("graph", 0, slow);
	assert.equal(calls, 2, "ttl 0 always re-runs");
	assert.ok(!expired.cached);

	// A failure must not stick: the daemon coming back has to be visible on
	// the very next poll.
	let failures = 0;
	const failing = () => { failures += 1; return Promise.resolve({ exitCode: 2, stdout: "", stderr: "boom" }); };
	await cache.run("bad", 10_000, failing);
	await cache.run("bad", 10_000, failing);
	assert.equal(failures, 2, "failed answers are never cached");
}

// --- end to end over a real socket ----------------------------------------
{
	const calls = [];
	const handle = await startServer({
		port: 0,
		quiet: true,
		token: "test-token",
		runCli: (args) => {
			calls.push(args.join(" "));
			return Promise.resolve({ exitCode: 0, stdout: JSON.stringify({ ok: true, args }), stderr: "" });
		},
	});
	const base = `http://127.0.0.1:${handle.port}`;
	try {
		const anonymous = await fetch(`${base}/api/status`);
		assert.equal(anonymous.status, 401, "no token, no API");
		assert.equal(calls.length, 0, "an unauthorized request never reaches the CLI");

		const wrong = await fetch(`${base}/api/status`, { headers: { authorization: "Bearer nope" } });
		assert.equal(wrong.status, 401);

		const ok = await fetch(`${base}/api/status`, { headers: { authorization: "Bearer test-token" } });
		assert.equal(ok.status, 200);
		const payload = await ok.json();
		assert.equal(payload.ok, true);
		// Every answer names the command that produced it — that is what makes
		// "the CLI is the source of truth" checkable rather than aspirational.
		assert.equal(payload.command, "paseo-team status");
		assert.deepEqual(payload.data.args, ["status"]);

		const unknown = await fetch(`${base}/api/does-not-exist`, { headers: { authorization: "Bearer test-token" } });
		assert.equal(unknown.status, 404);

		// Static assets are public (they carry no data), but must not escape
		// the public directory.
		const page = await fetch(`${base}/`);
		assert.equal(page.status, 200);
		assert.match(await page.text(), /paseo-team/);
		const escape = await fetch(`${base}/..%2Fserver.mjs`);
		assert.ok(escape.status === 403 || escape.status === 404, `traversal blocked (got ${escape.status})`);
	} finally {
		await handle.close();
	}
}

// --- a failing CLI is surfaced, not swallowed ------------------------------
{
	const handle = await startServer({
		port: 0,
		quiet: true,
		token: "t",
		runCli: () => Promise.resolve({ exitCode: 3, stdout: "", stderr: "paseo daemon unreachable" }),
	});
	try {
		const response = await fetch(`http://127.0.0.1:${handle.port}/api/status`, { headers: { authorization: "Bearer t" } });
		assert.equal(response.status, 502);
		const payload = await response.json();
		assert.equal(payload.ok, false);
		assert.equal(payload.code, "CLI_FAILED");
		assert.match(payload.stderr, /daemon unreachable/);
	} finally {
		await handle.close();
	}
}

// --- every route is a real CLI subcommand ---------------------------------
{
	const known = new Set(["status", "preflight", "config", "prompts", "skills", "env", "install", "agents", "agent", "permits", "chat", "graph", "watchdog", "web"]);
	for (const [key, route] of Object.entries(ROUTES)) {
		const { args } = route.build(
			{ section: "providers", role: "lead", id: "aaaa1111-2222-3333-4444-555555555555", name: "paseo-team-lead", room: "team" },
			{ agentId: "aaaa1111-2222-3333-4444-555555555555", action: "allow", requestId: "r", name: "paseo-team-lead", room: "team" },
			"{}",
		);
		assert.ok(known.has(args[0]), `${key} maps to a real subcommand (got '${args[0]}')`);
	}
}

// --- busy port: fall forward by default, fail friendly when pinned ----------
{
	const blocker = await startServer({ port: 0, quiet: true, token: "t" });
	try {
		const handle = await startServer({ port: blocker.port, quiet: true, token: "t", autoPort: true });
		assert.ok(
			handle.port > blocker.port && handle.port <= blocker.port + 8,
			`autoPort must fall forward past the busy port (blocked ${blocker.port}, got ${handle.port})`,
		);
		await handle.close();
	} finally {
		await blocker.close();
	}

	// a pinned port is the user's decision: reject with actionable text,
	// never a raw EADDRINUSE stack
	const pinnedBlocker = await startServer({ port: 0, quiet: true, token: "t" });
	await assert.rejects(
		() => startServer({ port: pinnedBlocker.port, quiet: true, token: "t" }),
		(err) => err.code === "WEB_PORT_BUSY" && /already in use/.test(err.message) && /--port/.test(err.message),
	);
	await pinnedBlocker.close();
}

console.log("webui-server tests passed");

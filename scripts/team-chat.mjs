#!/usr/bin/env node
/**
 * team-chat.mjs — Lead ↔ Lead and Supervisor ↔ Lead coordination.
 *
 * Peers talk to their own Lead through team-communication.mjs (parent-scoped,
 * one-way). This file is the other channel: a many-to-many bus for the seats
 * that coordinate rather than execute.
 *
 * Why chat rooms and not `paseo send`, measured 2026-08-27:
 *
 *   - `send` is fire-and-forget and NOT queryable, so a graph can only guess
 *     at it. `paseo chat read --json` returns the real author agent id, which
 *     makes every edge `confirmed` instead of `suspected`.
 *   - An `@<shortId>` mention WAKES an idle agent (34ms in the measurement)
 *     and QUEUES for a busy one. So the room is both the ledger and the
 *     doorbell; there is no need to post and then ring separately.
 *   - Mentions are delivered by agent id only. `mentionLabels` is populated by
 *     Paseo's tokenizer but does not fan out, so a domain broadcast has to be
 *     expanded here, by us, into one mention per agent.
 *
 * Three bounds exist because the transport forces them, not for taste:
 *
 *   - MAX_BODY_BYTES: `paseo chat post` takes the message as ARGV and has no
 *     --message-file. Windows caps a command line near 32K (measured: 32000
 *     chars OK, 100000 -> ENAMETOOLONG). The protocol takes the lowest
 *     platform's budget so a room stays readable from any host.
 *   - MAX_HOP / TTL: Lead↔Lead is symmetric, unlike Peer→Lead, so a relay
 *     without a bound ping-pongs forever. Note what this is NOT: a relaying
 *     agent supplies its own `hop`, so the bound is cooperative — it stops an
 *     agent that plays by the rules from looping, and gives a reader a
 *     ping-pong it can SEE, but it cannot stop an agent that always sends
 *     hop:0. Hard loop-breaking would need a daemon-side hop count.
 *   - Room allowlist: chat rooms have no membership or ACL of their own, so
 *     confinement has to come from this side.
 *
 * `paseo chat` is NOT in Paseo's published CLI documentation (checked
 * 2026-08-28) — see docs/multi-supervisor-topology.md §1.13. Treat the shape
 * as unverified upstream and keep test/paseo-contract.test.mjs honest about it.
 */

import { execFileSync } from "node:child_process";
import { importPolicyCore, isEntrypoint, resolvePaseoExec } from "./lib-common.mjs";

const { agentClustersById, clustersSeparate, normalizeCluster, selfCluster } =
	await importPolicyCore();

export const TEAM_MESSAGE_HEADER = "TEAM_MESSAGE_V1";

/**
 * `claim`/`release` exist for the scope lease (PR-C): the lease ledger is a
 * room, so its verbs are message kinds rather than a second transport.
 */
export const TEAM_MESSAGE_KINDS = Object.freeze([
	"handoff",
	"dependency",
	"claim",
	"release",
	"question",
	"decision",
	"progress",
]);

export const TEAM_CHAT_ROLES = Object.freeze(["lead", "supervisor"]);

/** Portable payload ceiling for the message text (see the argv note above). */
export const MAX_BODY_BYTES = 8192;
/**
 * Ceiling for the WHOLE posted body. argv is what the platform bounds, and the
 * mention head grows with the recipient count, so a wide `domain:` fan-out can
 * push a legal message past the budget. Kept well under the ~32K Windows limit
 * so the room stays postable from any host.
 */
export const MAX_ENVELOPE_BYTES = 16_384;
/** A message may be relayed at most this many times. */
export const MAX_HOP = 8;
export const DEFAULT_TTL = 8;

const TOKEN = /^[A-Za-z0-9._:-]{1,128}$/;
/** A mention is interpolated into the body, so its charset is what keeps the
 *  envelope from being forgeable — a newline here would inject header lines. */
const MENTION_TOKEN = /^[A-Za-z0-9-]{4,64}$/;
const AGENT_REF = /^[0-9a-fA-F][0-9a-fA-F-]{5,63}$/;
const DOMAIN_PREFIX = "domain:";
const ALLOWED_FIELDS = new Set(["room", "kind", "topic", "message", "to", "correlationId", "hop", "ttl", "replyTo", "notify"]);

function bad(code, message) {
	return Object.assign(new Error(message), { code });
}

function token(name, value) {
	if (typeof value !== "string" || !TOKEN.test(value)) {
		throw bad("FIELD_INVALID", `${name} must be a single token matching [A-Za-z0-9._:-] (max 128 chars)`);
	}
	return value;
}

/**
 * Room confinement. Unset PASEO_TEAM_ROOMS keeps the surface as open as it is
 * today (opt-in tightening, like PASEO_TEAM_LEAD_WRITE); once set it is a
 * strict allowlist, and an empty value grants nothing rather than everything.
 */
export function roomAllowed(room, allowlist) {
	if (allowlist === undefined || allowlist === null) return true;
	const allowed = String(allowlist)
		.split(",")
		.map((entry) => entry.trim())
		.filter(Boolean);
	return allowed.includes(room);
}

export function validateTeamMessage(input) {
	if (!input || typeof input !== "object" || Array.isArray(input)) {
		throw bad("MESSAGE_INVALID", "message must be an object");
	}
	for (const key of Object.keys(input)) {
		if (!ALLOWED_FIELDS.has(key)) throw bad("MESSAGE_INVALID", `unknown field '${key}'`);
	}
	const { kind, message, room, topic, to } = input;
	if (!TEAM_MESSAGE_KINDS.includes(kind)) {
		throw bad("KIND_INVALID", `kind must be one of: ${TEAM_MESSAGE_KINDS.join(", ")}`);
	}
	if (typeof message !== "string" || message.trim() === "") {
		throw bad("MESSAGE_INVALID", "message must be a non-empty string");
	}
	// Refuse to embed the marker: a body that carries it would let a relayed
	// message look like a second envelope to anything reading the room.
	if (message.includes(TEAM_MESSAGE_HEADER)) {
		throw bad("MESSAGE_INVALID", `message must not contain the ${TEAM_MESSAGE_HEADER} marker`);
	}
	const bytes = Buffer.byteLength(message, "utf8");
	if (bytes > MAX_BODY_BYTES) {
		throw bad(
			"MESSAGE_TOO_LARGE",
			`message is ${bytes} bytes, too large (max ${MAX_BODY_BYTES}). Send large evidence by pointer — a path, a SHA, or an agent ref — not inline.`,
		);
	}
	token("room", room);
	token("topic", topic);
	// `notify: false` marks a RECORD rather than a request — a ledger entry that
	// belongs in the room's history but that nobody has to wake up for. Mentions
	// are what wake an agent, so a record simply has none. Default is true: a
	// message with no audience must be a deliberate choice, never an omission.
	const notify = input.notify === undefined ? true : input.notify;
	if (typeof notify !== "boolean") throw bad("FIELD_INVALID", "notify must be a boolean");
	if (notify) {
		if (!Array.isArray(to) || to.length === 0) {
			throw bad("RECIPIENTS_MISSING", "to must be a non-empty array of agent refs or 'domain:<name>' entries");
		}
	} else if (Array.isArray(to) && to.length > 0) {
		throw bad("FIELD_INVALID", "notify: false posts a record, so it cannot also carry recipients");
	}
	const hop = input.hop === undefined ? 0 : input.hop;
	if (!Number.isInteger(hop) || hop < 0 || hop >= MAX_HOP) {
		throw bad("HOP_EXCEEDED", `hop must be an integer in [0, ${MAX_HOP}) — a relay past that is a loop`);
	}
	const ttl = input.ttl === undefined ? DEFAULT_TTL : input.ttl;
	if (!Number.isInteger(ttl) || ttl <= 0 || ttl > DEFAULT_TTL) {
		throw bad("TTL_INVALID", `ttl must be an integer in (0, ${DEFAULT_TTL}]`);
	}
	return {
		room,
		kind,
		topic,
		message: message.trim(),
		to: notify ? [...to] : [],
		notify,
		hop,
		ttl,
		replyTo: input.replyTo === undefined ? null : token("replyTo", input.replyTo),
		correlationId:
			input.correlationId === undefined
				? `team-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
				: token("correlationId", input.correlationId),
	};
}

/**
 * Cluster for a `paseo ls` row — from the state file, or not at all.
 *
 * This used to fall back to the row's `cwd`, which looked like free information
 * and was in fact a guess that NARROWS. `agentCluster` resolves
 * `team.cluster → workspaceId → cwd`, so a seat whose state file exists
 * normally answers on the `workspaceId` rung while a seat Paseo has not written
 * state for yet would answer on the `cwd` rung. Comparing those two is
 * comparing different axes: `clustersSeparate` says "separate", and a perfectly
 * legitimate recipient is dropped from a broadcast in silence.
 *
 * So an unresolvable row is null — "could not tell" — and null never narrows
 * anything. The cost is that a freshly created foreign seat stays in an
 * audience until Paseo writes its state; the alternative cost is silently not
 * delivering to one of our own, which is the worse of the two.
 */
function rowCluster(row, clusters) {
	return (row?.id ? clusters[row.id] : null) ?? null;
}

/**
 * Turn `to` entries into mention tokens. `domain:<name>` is expanded here
 * because Paseo delivers mentions by agent id only (measured) — a label
 * mention parses but never reaches anyone.
 *
 * The expansion runs `paseo ls -g`, and `-g` is precisely the flag that escapes
 * cwd scoping — so before the cluster axis existed, `domain:backend` mentioned
 * every `backend` seat ON THE HOST, and a mention WAKES an idle agent. A team
 * naming its seats `backend` in two repos silently rang both. Recipients are
 * therefore confined to this seat's cluster, and the two kinds of recipient
 * fail differently on purpose:
 *
 *   - a `domain:` entry is a BROADCAST, so a foreign seat is simply not in the
 *     audience — dropped quietly, and NO_RECIPIENTS still fires if that empties
 *     the list, so the fan-out can never shrink to silence unnoticed;
 *   - an explicit agent ref is a DELIBERATE address, and silently dropping one
 *     would post a message its author believes was delivered. That one throws.
 */
export async function expandRecipients(to, options = {}) {
	const run = options.runPaseo ?? runPaseo;
	const self = options.selfAgentId ?? null;
	const own =
		options.cluster === undefined ? selfCluster() : normalizeCluster(options.cluster);
	const mentions = [];
	const agentIds = [];
	const seen = new Set();

	const add = (id, shortId) => {
		if (self && (id === self || (shortId && self.startsWith(shortId)))) return;
		const mention = shortId ?? String(id).slice(0, 7);
		// Explicit recipients are AGENT_REF-checked above; rows from `paseo ls` are
		// not, and they end up inside the message body. Fail closed rather than
		// embed whatever the daemon happened to return.
		if (!MENTION_TOKEN.test(mention)) {
			throw bad("RECIPIENT_INVALID", `refusing to embed mention ${JSON.stringify(mention)}: not a plain token`);
		}
		if (seen.has(mention)) return;
		seen.add(mention);
		mentions.push(mention);
		if (id) agentIds.push(id);
	};

	for (const entry of to) {
		if (typeof entry !== "string") throw bad("RECIPIENT_INVALID", `invalid recipient ${JSON.stringify(entry)}`);
		if (entry.startsWith(DOMAIN_PREFIX)) {
			const domain = token("domain", entry.slice(DOMAIN_PREFIX.length));
			let rows;
			try {
				rows = await run(["ls", "-g", "--label", `team.domain=${domain}`]);
			} catch (error) {
				// Never post to a guessed audience: an unresolvable broadcast is a
				// failure, not a smaller broadcast.
				throw bad("RECIPIENT_EXPANSION_FAILED", `RECIPIENT_EXPANSION_FAILED: could not resolve domain '${domain}': ${String(error?.message ?? error)}`);
			}
			const all = Array.isArray(rows) ? rows : [];
			const clusters = agentClustersById(all.map((row) => row?.id));
			const list = all.filter((row) => !clustersSeparate(rowCluster(row, clusters), own));
			for (const row of list) add(row?.id, typeof row?.shortId === "string" ? row.shortId : undefined);
			if (list.length === 0 || list.every((row) => row?.id === self)) {
				throw bad(
					"NO_RECIPIENTS",
					all.length === 0
						? `no recipient carries team.domain=${domain}`
						: `no recipient carries team.domain=${domain} inside this seat's cluster ${JSON.stringify(own)} (${all.length} seat(s) carry it in other clusters, and a domain broadcast does not cross a cluster)`,
				);
			}
			continue;
		}
		if (!AGENT_REF.test(entry)) throw bad("RECIPIENT_INVALID", `invalid recipient '${entry}'`);
		const targetCluster = agentClustersById([entry])[entry] ?? null;
		if (clustersSeparate(targetCluster, own)) {
			throw bad(
				"RECIPIENT_OUT_OF_CLUSTER",
				`RECIPIENT_OUT_OF_CLUSTER: agent ${entry} is in cluster ${JSON.stringify(targetCluster)}, not this seat's ${JSON.stringify(own)}. Coordination stays inside one cluster; if these really are one cluster, set team.cluster/PASEO_TEAM_CLUSTER on both seats.`,
			);
		}
		add(entry, entry.slice(0, 7));
	}
	if (mentions.length === 0) throw bad("NO_RECIPIENTS", "no recipient resolved");
	return { mentions, agentIds };
}

/**
 * The wire format. Mentions come FIRST because Paseo parses delivery targets
 * out of the message body; the envelope follows so a reader (and the graph)
 * gets a stable, parseable header.
 */
export function buildEnvelope(message, { fromAgentId, fromRole, fromDomain, mentions = [] }) {
	const head = mentions.map((m) => `@${m}`).join(" ");
	const block = [
		TEAM_MESSAGE_HEADER,
		`KIND: ${message.kind}`,
		`CORRELATION_ID: ${message.correlationId}`,
		`TOPIC: ${message.topic}`,
		`FROM_AGENT_ID: ${fromAgentId}`,
		`FROM_ROLE: ${fromRole}`,
		`FROM_DOMAIN: ${fromDomain || "-"}`,
		`HOP: ${message.hop}`,
		`TTL: ${message.ttl}`,
		"",
		message.message,
	].join("\n");
	return head ? `${head}\n${block}` : block;
}

const HEADER_LINE = /^([A-Z_]+):\s*(.+)$/;

/**
 * Parse the FIRST envelope out of a room message. Fail-closed: a block missing
 * any field, or carrying a kind outside the set, yields null rather than a
 * half-populated edge — the same rule parsePeerMessage follows.
 */
export function parseTeamMessage(text) {
	if (typeof text !== "string") return null;
	const start = text.indexOf(TEAM_MESSAGE_HEADER);
	if (start < 0) return null;
	const lines = text.slice(start).split(/\r?\n/).slice(1);
	const fields = {};
	for (const line of lines) {
		if (line.trim() === "") break;
		const match = HEADER_LINE.exec(line.trim());
		if (!match) break;
		fields[match[1]] = match[2].trim();
	}
	const kind = fields.KIND;
	if (!TEAM_MESSAGE_KINDS.includes(kind)) return null;
	for (const required of ["CORRELATION_ID", "TOPIC", "FROM_AGENT_ID", "FROM_ROLE", "HOP", "TTL"]) {
		if (!fields[required]) return null;
	}
	const hop = Number.parseInt(fields.HOP, 10);
	const ttl = Number.parseInt(fields.TTL, 10);
	if (!Number.isInteger(hop) || !Number.isInteger(ttl)) return null;
	return {
		kind,
		correlationId: fields.CORRELATION_ID,
		topic: fields.TOPIC,
		fromAgentId: fields.FROM_AGENT_ID,
		fromRole: fields.FROM_ROLE,
		fromDomain: fields.FROM_DOMAIN && fields.FROM_DOMAIN !== "-" ? fields.FROM_DOMAIN : null,
		hop,
		ttl,
	};
}

/**
 * Turn a failed CLI invocation into something a Lead can act on.
 *
 * Taking "the first non-empty line" seemed reasonable until Paseo answered with
 * a pretty-printed JSON error and the Lead was told the operation failed with
 * the message `{`. Prefer the structured message when the output is JSON, and
 * otherwise fall back to the first line that carries actual words.
 */
/**
 * The first complete JSON object in a blob of CLI output, or null.
 *
 * Slicing from the first `{` to the END of the text was wrong in the one case
 * that always happens: runPaseo concatenates stderr, stdout AND the spawn
 * error message, so the JSON is followed by `Command failed: paseo ...`, the
 * parse throws, and the caller falls back to the first line with letters in it
 * — reporting the failure as `"error": {`. That is the same unreadable answer
 * the line-scan fallback was written to prevent, one line lower down.
 *
 * Depth counting, string-aware, so a brace inside a message value cannot end
 * the object early.
 */
function firstJsonObject(raw) {
	const start = raw.indexOf("{");
	if (start < 0) return null;
	let depth = 0;
	let inString = false;
	let escaped = false;
	for (let i = start; i < raw.length; i += 1) {
		const char = raw[i];
		if (inString) {
			if (escaped) escaped = false;
			else if (char === "\\") escaped = true;
			else if (char === '"') inString = false;
			continue;
		}
		if (char === '"') inString = true;
		else if (char === "{") depth += 1;
		else if (char === "}") {
			depth -= 1;
			if (depth === 0) {
				try {
					return JSON.parse(raw.slice(start, i + 1));
				} catch {
					return null;
				}
			}
		}
	}
	return null;
}

/**
 * Turn a parsed Paseo error object into one line a Lead can act on.
 *
 * Measured against the real daemon: a failing `chat read` answers
 *   { error: { name, requestId, requestType, code } }
 * with **no `message` field at all**. Reading only `message` therefore found
 * nothing, fell through to the line scan, and reported the failure as
 * `"error": {` — while the one word that mattered, `chat_room_not_found`, was
 * sitting in `code`. So `code` is a first-class source here, not a fallback.
 */
function describeCliError(json) {
	const error = json?.error;
	const pick = (value) =>
		typeof value === "string" && value.trim() !== "" ? value.trim() : null;

	const message = pick(error?.message) ?? pick(json?.message);
	if (message) return message;
	if (typeof error === "string") return error.trim() || null;

	const code = pick(error?.code) ?? pick(json?.code);
	if (code) {
		const where = pick(error?.requestType);
		return where ? `${code} (${where})` : code;
	}
	return pick(error?.name) ?? null;
}

export function cliErrorMessage(text) {
	const raw = String(text ?? "").trim();
	if (raw === "") return "paseo chat failed";
	const json = firstJsonObject(raw);
	if (json) {
		const described = describeCliError(json);
		if (described) return described;
	}
	const informative = raw
		.split("\n")
		.map((line) => line.trim())
		.find((line) => /[A-Za-z0-9]/.test(line));
	return informative ?? raw.slice(0, 400);
}

export function runPaseo(args, timeoutMs = 20_000) {
	const [bin, ...prefix] = resolvePaseoExec((reason) => {
		throw bad("PASEO_EXEC_INVALID", `PASEO_TEAM_PASEO_EXEC ${reason}`);
	});
	try {
		return JSON.parse(
			execFileSync(bin, [...prefix, ...args, "--json"], {
				encoding: "utf8",
				timeout: timeoutMs,
				stdio: ["ignore", "pipe", "pipe"],
				env: process.env,
				windowsHide: true,
			}),
		);
	} catch (error) {
		const text = `${error?.stderr ?? ""}\n${error?.stdout ?? ""}\n${error?.message ?? error}`;
		throw bad("CLI_ERROR", cliErrorMessage(text));
	}
}

function selfContext(options) {
	const role = (options.role ?? process.env.PASEO_PI_ROLE ?? "").trim().toLowerCase();
	if (!TEAM_CHAT_ROLES.includes(role)) {
		throw bad("ROLE_NOT_ALLOWED", `ROLE_NOT_ALLOWED: team_chat is for ${TEAM_CHAT_ROLES.join(" and ")} only (a Peer uses peer_ask_lead)`);
	}
	const selfAgentId = (options.selfAgentId ?? process.env.PASEO_AGENT_ID ?? "").trim();
	if (!selfAgentId) throw bad("AGENT_ID_MISSING", "PASEO_AGENT_ID is missing");
	return {
		role,
		selfAgentId,
		domain: (options.domain ?? process.env.PASEO_TEAM_DOMAIN ?? "").trim() || null,
		cluster:
			options.cluster === undefined
				? selfCluster()
				: normalizeCluster(options.cluster),
		rooms: options.rooms ?? process.env.PASEO_TEAM_ROOMS,
	};
}

export async function postTeamMessage(input, options = {}) {
	const ctx = selfContext(options);
	const message = validateTeamMessage(input);
	if (!roomAllowed(message.room, ctx.rooms)) {
		throw bad("ROOM_NOT_ALLOWED", `ROOM_NOT_ALLOWED: '${message.room}' is outside this agent's room allowlist`);
	}
	const run = options.runPaseo ?? runPaseo;
	// A record resolves no recipients, so it also costs no `paseo ls` round trip.
	const { mentions, agentIds } = message.notify
		? await expandRecipients(message.to, {
				runPaseo: run,
				selfAgentId: ctx.selfAgentId,
				cluster: ctx.cluster,
			})
		: { mentions: [], agentIds: [] };
	const body = buildEnvelope(message, {
		fromAgentId: ctx.selfAgentId,
		fromRole: ctx.role,
		fromDomain: ctx.domain,
		mentions,
	});
	const envelopeBytes = Buffer.byteLength(body, "utf8");
	if (envelopeBytes > MAX_ENVELOPE_BYTES) {
		throw bad(
			"MESSAGE_TOO_LARGE",
			`the envelope is ${envelopeBytes} bytes with ${mentions.length} mention(s), too large (max ${MAX_ENVELOPE_BYTES}). Narrow the recipients or send the detail by pointer.`,
		);
	}
	const args = ["chat", "post", message.room, body];
	if (message.replyTo) args.push("--reply-to", message.replyTo);
	// One shot. `post` is a mutation with delivery ambiguity: a retry would
	// double-deliver, and correlationId is for reader-side dedup, not transport.
	const response = await run(args);
	return {
		ok: true,
		room: message.room,
		kind: message.kind,
		topic: message.topic,
		correlationId: message.correlationId,
		recipients: agentIds,
		mentions,
		bytes: envelopeBytes,
		response,
	};
}

export async function readRoom(input, options = {}) {
	const ctx = selfContext(options);
	const room = token("room", input?.room);
	if (!roomAllowed(room, ctx.rooms)) {
		throw bad("ROOM_NOT_ALLOWED", `ROOM_NOT_ALLOWED: '${room}' is outside this agent's room allowlist`);
	}
	const run = options.runPaseo ?? runPaseo;
	const args = ["chat", "read", room];
	if (input?.since !== undefined) args.push("--since", token("since", String(input.since)));
	if (input?.limit !== undefined) {
		// The ceiling is high because the scope-lease ledger reads a whole time
		// window rather than a page: a live lease that falls outside the read is
		// invisible, and invisible reads as free. A human reading a room still
		// wants a small limit, so the DEFAULT stays whatever the caller asks for.
		if (!Number.isInteger(input.limit) || input.limit < 1 || input.limit > 5000) {
			throw bad("FIELD_INVALID", "limit must be an integer in [1, 5000]");
		}
		args.push("--limit", String(input.limit));
	}
	const rows = await run(args);
	const messages = (Array.isArray(rows) ? rows : []).map((row) => ({
		id: row?.id ?? null,
		author: row?.author ?? null,
		createdAt: row?.createdAt ?? null,
		body: row?.body ?? "",
		envelope: parseTeamMessage(row?.body),
	}));
	return { ok: true, room, count: messages.length, messages };
}

/**
 * `paseo chat ls` is fleet-wide: it returns every room on the daemon, including
 * rooms opened by a team working in a different repository. Listing them
 * unfiltered defeats the allowlist that `post` and `read` enforce — an agent
 * that may not read a room should not learn its name and id either, because a
 * discovered room is one the model will try to talk into. Measured 2026-08-30:
 * a Supervisor in one repo found another repo's lease room this way, addressed
 * that team's Lead, and reported the WRONG PROJECT'S status back to the human.
 *
 * Unset PASEO_TEAM_ROOMS still lists everything, so this only tightens the
 * configuration that already asked to be tightened.
 */
export async function listRooms(options = {}) {
	const ctx = selfContext(options);
	const run = options.runPaseo ?? runPaseo;
	const rows = await run(["chat", "ls"]);
	const all = Array.isArray(rows) ? rows : [];
	// A room is addressable by either name or id, so either matching the
	// allowlist keeps it visible; neither matching hides it.
	const rooms = all.filter(
		(row) => roomAllowed(row?.name, ctx.rooms) || roomAllowed(row?.id, ctx.rooms),
	);
	const hidden = all.length - rooms.length;
	return hidden > 0 ? { ok: true, rooms, hidden } : { ok: true, rooms };
}

async function main() {
	const command = process.argv[2];
	let input = {};
	if (process.argv[3] !== undefined) {
		try {
			input = JSON.parse(process.argv[3]);
		} catch (error) {
			throw bad("INPUT_INVALID", `invalid JSON input: ${String(error?.message ?? error)}`);
		}
	}
	if (command === "post") return console.log(JSON.stringify(await postTeamMessage(input), null, 2));
	if (command === "read") return console.log(JSON.stringify(await readRoom(input), null, 2));
	if (command === "rooms") return console.log(JSON.stringify(await listRooms(), null, 2));
	throw bad("USAGE", "usage: team-chat.mjs post|read '<json>' | rooms");
}

export function isMainModule(entry = process.argv[1], moduleUrl = import.meta.url) {
	return isEntrypoint(moduleUrl, entry);
}

if (isMainModule()) {
	main().catch((error) => {
		console.error(JSON.stringify({ ok: false, code: error.code ?? "TEAM_CHAT_FAILED", message: error.message }));
		process.exit(2);
	});
}

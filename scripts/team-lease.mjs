#!/usr/bin/env node
/**
 * team-lease.mjs — who is allowed to put a writer on which files.
 *
 * "One writer per moving scope" is the oldest invariant in this pack, and until
 * now it held for a reason that is about to stop being true: there was exactly
 * one Lead, so nobody could contend. With several Leads, two of them can staff
 * engineers on the same files, and that failure does not announce itself — it
 * shows up later as a tangled working tree or a lost commit.
 *
 * The ledger is a Paseo chat room, reached through team-chat.mjs so a lease
 * message is an ordinary TEAM_MESSAGE_V1 with `KIND: claim|release` and a
 * LEASE_V1 block in the body. That choice buys three things measured on
 * 2026-08-27: the room is queryable, its messages carry a daemon-stamped author,
 * and concurrent posts land in a total order with none lost.
 *
 * What it does NOT buy is compare-and-swap: every CLAIM succeeds, including the
 * losing one. So the ledger is append-only evidence and arbitration happens on
 * READ, in policy-core's resolveLeases() — which is pure, and therefore the part
 * that is actually tested. This file only fetches and posts.
 *
 * The rule is enforced where it can be enforced: the adapters call the pure
 * guard before a Lead's create_agent, so a Lead that skips the claim is stopped
 * by its own policy rather than trusted to be polite.
 */

import {
	LEASE_ACTIONS,
	LEASE_MAX_TTL_MS,
	leaseHolderFor,
	normalizeScope,
	resolveLeases,
} from "../extensions/paseo-team-core/policy-core.ts";
import { isEntrypoint } from "./lib-common.mjs";
import { postTeamMessage, readRoom, runPaseo } from "./team-chat.mjs";

/** The room that holds the ledger. One room, so the total order is global. */
export const LEASE_ROOM = "leases";
/** Default lease length. Long enough for real work, short enough that a Lead
 *  that dies holding one does not block the scope for a whole day. */
export const DEFAULT_TTL_MS = 3_600_000;
export const MAX_TTL_MS = 12 * 3_600_000;
/**
 * How far BACK the ledger is read, in time rather than in messages.
 *
 * Counting messages was wrong in the one way that matters: a live claim can be
 * pushed out of a fixed window by ordinary traffic — or deliberately, since
 * records are cheap to post — and a lease that falls outside the window reads as
 * no lease at all, which is the silent two-writer outcome. Time is safe because
 * one fact bounds it: nothing can outlive LEASE_MAX_TTL_MS, so a window that
 * covers that cannot hide anything still live. The margin absorbs clock skew
 * between the Lead's host and the daemon.
 */
export const LEDGER_WINDOW_MS = LEASE_MAX_TTL_MS + 3_600_000;
/**
 * Safety valve, not a window. If a read comes back at the cap the board may
 * have been cut short, and a truncated board that reads as "free" is precisely
 * the bug this replaced — so that answer is reported as unreadable rather than
 * as empty.
 */
export const LEDGER_MAX_MESSAGES = 2000;

function bad(code, message) {
	return Object.assign(new Error(message), { code });
}

function leaseBody(action, scope, ttlMs) {
	const lines = ["LEASE_V1", `ACTION: ${action}`, `SCOPE: ${scope}`];
	if (action !== "release") lines.push(`TTL_MS: ${ttlMs}`);
	return lines.join("\n");
}

/**
 * Read the ledger and resolve it to the set of live leases.
 *
 * Returns null — never an empty map — when the room could not be read. The
 * difference matters: an empty ledger means "nobody holds anything", while an
 * unreadable one means "we do not know", and the guard treats those opposite
 * ways. Collapsing them would turn a daemon hiccup into permission to start a
 * second writer.
 */
export async function fetchLeases(options = {}) {
	const run = options.runPaseo ?? runPaseo;
	const now = options.now ?? Date.now();
	try {
		const room = await readLedgerRoom(options, run, now);
		return { ok: true, leases: resolveLeases(room.messages, { now }) };
	} catch (error) {
		return {
			ok: false,
			leases: null,
			code: error?.code ?? "LEASE_LEDGER_UNREADABLE",
			message: String(error?.message ?? error),
		};
	}
}

/**
 * Read the ledger over a window that cannot hide a live lease, and refuse to
 * pretend a possibly-truncated answer is the whole board.
 */
async function readLedgerRoom(options, run, now) {
	const limit = options.maxMessages ?? LEDGER_MAX_MESSAGES;
	const room = await readRoom(
		{
			room: options.room ?? LEASE_ROOM,
			since: new Date(now - (options.windowMs ?? LEDGER_WINDOW_MS)).toISOString(),
			limit,
		},
		{ ...options, runPaseo: run },
	);
	if (room.count >= limit) {
		throw bad(
			"LEASE_LEDGER_TRUNCATED",
			`the lease ledger returned ${room.count} messages, at or above the ${limit} cap — the board may be incomplete, so it cannot be treated as authoritative`,
		);
	}
	return room;
}

function requireScope(scope) {
	const normalized = normalizeScope(scope);
	if (!normalized) {
		throw bad("SCOPE_INVALID", `scope must be a repo-relative path (got ${JSON.stringify(scope)})`);
	}
	return normalized;
}

function requireTtl(ttlMs) {
	const value = ttlMs === undefined ? DEFAULT_TTL_MS : ttlMs;
	if (!Number.isInteger(value) || value <= 0 || value > MAX_TTL_MS) {
		throw bad("TTL_INVALID", `ttlMs must be an integer in (0, ${MAX_TTL_MS}]`);
	}
	return value;
}

/**
 * Post a lease event.
 *
 * A claim is deliberately NOT checked against the ledger before posting: the
 * room has no compare-and-swap, so a pre-check would only produce a
 * comfortable-looking race. Post the intent, then let the read side arbitrate —
 * and report the resolved holder back so the caller learns immediately whether
 * it won.
 */
async function postLease(action, input, options = {}) {
	if (!LEASE_ACTIONS.includes(action)) throw bad("ACTION_INVALID", `unknown lease action '${action}'`);
	const scope = requireScope(input?.scope);
	const ttlMs = action === "release" ? null : requireTtl(input?.ttlMs);
	const room = input?.room ?? LEASE_ROOM;
	const run = options.runPaseo ?? runPaseo;

	const post = () =>
		postTeamMessage(
		{
			room,
			kind: action === "release" ? "release" : "claim",
			topic: input?.taskId ?? "lease",
			message: leaseBody(action, scope, ttlMs),
			// A lease event is a record, not a request: it belongs in the room's
			// history, but no Lead should be pulled out of its work to read it.
			notify: false,
			hop: 0,
		},
			{ ...options, runPaseo: run },
		);

	let posted;
	try {
		posted = await post();
	} catch (error) {
		// First run on a fresh machine: nobody has created the ledger room yet.
		// Making that the operator's problem means the very first claim fails
		// with a CLI error and the Lead has no idea a setup step existed. Create
		// it and retry once — but surface the ORIGINAL failure if that does not
		// help, because "could not create the room" is rarely the real cause.
		try {
			await run(["chat", "create", room, "--purpose", "paseo-pi-team scope lease ledger"]);
		} catch {
			throw error;
		}
		posted = await post().catch(() => {
			throw error;
		});
	}

	const after = await fetchLeases({ ...options, room, runPaseo: run });
	const holder = after.ok ? leaseHolderFor(after.leases, scope) : null;
	const self = options.selfAgentId ?? process.env.PASEO_AGENT_ID ?? null;
	return {
		ok: true,
		action,
		scope,
		ttlMs,
		room,
		correlationId: posted.correlationId,
		ledgerReadable: after.ok,
		holder,
		// The only field a caller should branch on: did WE end up holding it.
		granted: Boolean(holder && self && holder.agentId === self),
	};
}

export const claimScope = (input, options) => postLease("claim", input, options);
export const renewScope = (input, options) => postLease("renew", input, options);
export const releaseScope = (input, options) => postLease("release", input, options);

/**
 * The raw ledger, for a caller that will arbitrate itself.
 *
 * The policy adapters use this rather than leaseStatus(): arbitration must run
 * in ONE place (policy-core's resolveLeases) with the caller's own clock, so a
 * guard decision can never differ from what the guard's own core would conclude.
 */
export async function leaseLedger(input = {}, options = {}) {
	const run = options.runPaseo ?? runPaseo;
	try {
		const room = await readLedgerRoom({ ...options, room: input.room ?? LEASE_ROOM }, run, options.now ?? Date.now());
		return {
			ok: true,
			room: room.room,
			entries: room.messages.map(({ author, createdAt, body }) => ({ author, createdAt, body })),
		};
	} catch (error) {
		// Fail LOUD, not empty: the guard has to tell "nobody holds it" apart from
		// "we could not find out", and those lead to opposite decisions.
		return {
			ok: false,
			code: error?.code ?? "LEASE_LEDGER_UNREADABLE",
			message: String(error?.message ?? error),
			entries: null,
		};
	}
}

/** Everything currently held, for a Lead deciding where it can work. */
export async function leaseStatus(input = {}, options = {}) {
	const result = await fetchLeases({ ...options, room: input.room ?? LEASE_ROOM });
	if (!result.ok) {
		return { ok: false, code: result.code, message: result.message, leases: null };
	}
	const held = [...result.leases.values()].sort((a, b) => a.claimedAt - b.claimedAt);
	const scope = input.scope === undefined ? null : requireScope(input.scope);
	return {
		ok: true,
		room: input.room ?? LEASE_ROOM,
		count: held.length,
		leases: held.map((holder) => ({ ...holder, expiresAtIso: new Date(holder.expiresAt).toISOString() })),
		...(scope ? { scope, holder: leaseHolderFor(result.leases, scope) } : {}),
	};
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
	const handlers = { claim: claimScope, renew: renewScope, release: releaseScope, status: leaseStatus, ledger: leaseLedger };
	const handler = handlers[command];
	if (!handler) throw bad("USAGE", `usage: team-lease.mjs ${Object.keys(handlers).join("|")} '<json>'`);
	console.log(JSON.stringify(await handler(input), null, 2));
}

export function isMainModule(entry = process.argv[1], moduleUrl = import.meta.url) {
	return isEntrypoint(moduleUrl, entry);
}

if (isMainModule()) {
	main().catch((error) => {
		console.error(JSON.stringify({ ok: false, code: error.code ?? "LEASE_FAILED", message: error.message }));
		process.exit(2);
	});
}

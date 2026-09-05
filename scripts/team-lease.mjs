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
 * The ledger is an append-only file this pack owns — see lease-ledger.mjs. It
 * used to be a Paseo chat room, until Paseo retired chat rooms in 0.4.0 rather
 * than migrate them to its new storage. Renting the one invariant that cannot
 * lapse from a surface the vendor was in the middle of deleting is the mistake
 * that swap corrects; nothing about the lease itself changed.
 *
 * The ledger is append-only evidence and arbitration happens on READ, in
 * policy-core's resolveLeases() — which is pure, and therefore the part that is
 * actually tested. This file only fetches and appends.
 *
 * The rule is enforced where it can be enforced: the adapters call the pure
 * guard before a Lead's create_agent, so a Lead that skips the claim is stopped
 * by its own policy rather than trusted to be polite.
 */

import { importPolicyCore, isEntrypoint } from "./lib-common.mjs";

// Resolved at runtime, not by a static specifier: the installed layout puts the
// core one directory level away from where a checkout puts it, and a static
// import that is wrong there fails at IMPORT time — which the caller then
// misreports as an unreadable lease ledger. See policyCorePath in lib-common.
const {
	LEASE_ACTIONS,
	LEASE_MAX_TTL_MS,
	leaseHolderFor,
	normalizeCluster,
	normalizeScope,
	resolveLeases,
	selfCluster,
} = await importPolicyCore();
import { createLedger } from "./lease-ledger.mjs";

/**
 * Who may touch the board at all.
 *
 * This gate used to be inherited for free: the ledger was a chat room, chat was
 * Lead/Supervisor-only, so a Peer could not post a lease either. With the room
 * gone that inheritance goes with it, and an invariant that silently stops being
 * enforced is worse than one that was never claimed — so it is stated here, in
 * the file that now owns the board.
 */
export const LEASE_ROLES = Object.freeze(["lead", "supervisor"]);
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

/** The board to work against; injectable so a test never touches a real home. */
function ledgerFor(options) {
	return options.ledger ?? createLedger(options.ledgerPath ? { path: options.ledgerPath } : {});
}

/**
 * The seat this record is written on behalf of.
 *
 * The daemon used to stamp the author, so an anonymous record was impossible.
 * A file cannot stamp anything, and a record whose author is unknown is dropped
 * by resolveLeases — silently, and as a lease that was never taken. Refusing up
 * front turns that into an error the caller can see.
 */
function requireSelf(options) {
	const self = (options.selfAgentId ?? process.env.PASEO_AGENT_ID ?? "").trim();
	if (!self) {
		throw bad(
			"SELF_UNKNOWN",
			"SELF_UNKNOWN: a lease record needs the agent id claiming it — set PASEO_AGENT_ID or pass selfAgentId",
		);
	}
	return self;
}

/** @see LEASE_ROLES — the gate the chat room used to provide. */
function requireRole(options) {
	const role = (options.role ?? process.env.PASEO_PI_ROLE ?? "").trim().toLowerCase();
	if (!LEASE_ROLES.includes(role)) {
		throw bad(
			"ROLE_NOT_ALLOWED",
			`ROLE_NOT_ALLOWED: the scope lease is for ${LEASE_ROLES.join(" and ")} only (a Peer uses peer_ask_lead)`,
		);
	}
	return role;
}

/**
 * The LEASE_V1 wire record.
 *
 * CLUSTER is APPENDED rather than folded into SCOPE, and that is what keeps the
 * upgrade safe. SCOPE keeps its exact old meaning, so a pack that has not been
 * updated still reads every record; and a record written before the field
 * existed parses with cluster null, which collides with everything — the
 * pre-cluster behaviour. Rewriting SCOPE instead would have made every live
 * lease in the room unreadable to the other side of a rolling upgrade, and an
 * unreadable lease reads as a free scope, which is two writers on one tree.
 *
 * Omitted entirely when the cluster is underivable: an empty `CLUSTER:` line
 * would parse to null anyway, and a field that is sometimes a lie is worse than
 * a field that is sometimes absent.
 */
function leaseBody(action, scope, ttlMs, cluster) {
	const lines = ["LEASE_V1", `ACTION: ${action}`, `SCOPE: ${scope}`];
	if (cluster) lines.push(`CLUSTER: ${cluster}`);
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
	const now = options.now ?? Date.now();
	try {
		const board = await readBoard(options, now);
		return { ok: true, leases: resolveLeases(board.messages, { now }) };
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
async function readBoard(options, now) {
	const limit = options.maxMessages ?? LEDGER_MAX_MESSAGES;
	const board = await ledgerFor(options).read({
		since: new Date(now - (options.windowMs ?? LEDGER_WINDOW_MS)).toISOString(),
		limit,
	});
	if (board.count >= limit) {
		throw bad(
			"LEASE_LEDGER_TRUNCATED",
			`the lease ledger returned ${board.count} records, at or above the ${limit} cap — the board may be incomplete, so it cannot be treated as authoritative`,
		);
	}
	return board;
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
	requireRole(options);
	const self = requireSelf(options);
	const ledger = ledgerFor(options);
	const now = options.now ?? Date.now();
	// A scope is repo-relative, so it only identifies a tree together with the
	// cluster it belongs to. Without this, `src` in one project held `src` in
	// every other project checked out on the same host.
	const cluster =
		options.cluster === undefined
			? selfCluster()
			: normalizeCluster(options.cluster);

	// A lease event is a record, not a request. Under the chat room it was
	// posted with notify:false so no Lead was woken for bookkeeping; a file
	// wakes nobody by construction, which is the same guarantee for free.
	const written = await ledger.append({ author: self, body: leaseBody(action, scope, ttlMs, cluster), now });

	const after = await fetchLeases({ ...options, ledger, now });
	const holder = after.ok ? leaseHolderFor(after.leases, scope, cluster) : null;
	return {
		ok: true,
		action,
		scope,
		cluster,
		ttlMs,
		ledger: ledger.path,
		recordId: written.id,
		ledgerReadable: after.ok,
		holder,
		// The only field a caller should branch on: did WE end up holding it.
		granted: Boolean(holder && holder.agentId === self),
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
export async function leaseLedger(_input = {}, options = {}) {
	try {
		const board = await readBoard(options, options.now ?? Date.now());
		return {
			ok: true,
			ledger: board.path,
			entries: board.messages.map(({ author, createdAt, body }) => ({ author, createdAt, body })),
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
	const result = await fetchLeases(options);
	if (!result.ok) {
		return { ok: false, code: result.code, message: result.message, leases: null };
	}
	const held = [...result.leases.values()].sort((a, b) => a.claimedAt - b.claimedAt);
	const scope = input.scope === undefined ? null : requireScope(input.scope);
	const cluster =
		input.cluster === undefined ? selfCluster() : normalizeCluster(input.cluster);
	return {
		ok: true,
		cluster,
		count: held.length,
		// The whole board, every cluster, deliberately: a Lead reading status is
		// entitled to SEE that another project holds something. Only the `holder`
		// answer below — the one a decision is actually made on — is narrowed.
		leases: held.map((holder) => ({ ...holder, expiresAtIso: new Date(holder.expiresAt).toISOString() })),
		...(scope ? { scope, holder: leaseHolderFor(result.leases, scope, cluster) } : {}),
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

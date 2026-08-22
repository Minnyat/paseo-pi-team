/**
 * graph-cache.mjs — parent-link cache for the team graph.
 *
 * Why a cache exists at all: `paseo ls` does NOT carry the parent link, only
 * `paseo inspect <id>` does, and every paseo invocation costs ~3s (see
 * paseo-bridge.mjs). Rebuilding the supervisor -> lead -> peer tree from
 * scratch would mean N x 3s per refresh — 21 live agents on the reference
 * machine is over a minute of wall clock for a graph that barely changes.
 *
 * The parent link is *nearly* immutable: it is assigned at spawn time and only
 * `paseo agent detach` can clear it. So entries are cached with a timestamp
 * and a TTL rather than forever — a detached agent heals on its own within one
 * TTL instead of showing a phantom edge until someone clears the cache by hand.
 *
 * Stored in the controller-local team config dir, never in the repo.
 */

import { join } from "node:path";
import { existsSync, unlinkSync } from "node:fs";
import * as cw from "./config-walker.mjs";

export const CACHE_VERSION = 1;
export const DEFAULT_PARENT_TTL_MS = 15 * 60_000;

export function graphCachePath() {
	return join(cw.teamConfigDir(), "graph-cache.json");
}

function emptyCache() {
	return { version: CACHE_VERSION, parents: {} };
}

/**
 * A corrupt or foreign-version cache is discarded, not repaired: it is
 * derived data, and guessing at a half-written shape is how stale edges get
 * drawn as facts.
 */
export function readParentCache(path = graphCachePath()) {
	const raw = cw.readJsonOrNull(path);
	if (!raw || raw.version !== CACHE_VERSION || typeof raw.parents !== "object" || raw.parents === null) {
		return emptyCache();
	}
	const parents = {};
	for (const [id, entry] of Object.entries(raw.parents)) {
		if (!entry || typeof entry !== "object") continue;
		const parentId = entry.parentId === null || typeof entry.parentId === "string" ? entry.parentId : undefined;
		const checkedAt = typeof entry.checkedAt === "number" ? entry.checkedAt : undefined;
		if (parentId === undefined || checkedAt === undefined) continue;
		parents[id] = { parentId, checkedAt };
	}
	return { version: CACHE_VERSION, parents };
}

export function writeParentCache(cache, path = graphCachePath()) {
	cw.atomicWrite(path, JSON.stringify({ version: CACHE_VERSION, parents: cache.parents ?? {} }, null, 2) + "\n");
	return path;
}

export function clearParentCache(path = graphCachePath()) {
	if (existsSync(path)) unlinkSync(path);
	return path;
}

/** Entries older than the TTL are re-inspected; unknown ids always are. */
export function isFresh(entry, { now = Date.now(), ttlMs = DEFAULT_PARENT_TTL_MS } = {}) {
	if (!entry || typeof entry.checkedAt !== "number") return false;
	return now - entry.checkedAt < Math.max(0, ttlMs);
}

/**
 * Ids that still need a `paseo inspect`, oldest-first so a cold cache fills
 * deterministically across successive polls instead of re-picking at random.
 */
export function staleIds(ids, cache, options = {}) {
	return ids
		.filter((id) => !isFresh(cache.parents?.[id], options))
		.sort((a, b) => (cache.parents?.[a]?.checkedAt ?? 0) - (cache.parents?.[b]?.checkedAt ?? 0));
}

export function rememberParent(cache, id, parentId, now = Date.now()) {
	cache.parents ??= {};
	cache.parents[id] = { parentId: parentId ?? null, checkedAt: now };
	return cache;
}

/** Drop ids the daemon no longer lists, so the file cannot grow forever. */
export function pruneCache(cache, liveIds) {
	const live = new Set(liveIds);
	for (const id of Object.keys(cache.parents ?? {})) {
		if (!live.has(id)) delete cache.parents[id];
	}
	return cache;
}

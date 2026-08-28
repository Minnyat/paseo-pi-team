import assert from "node:assert/strict";
import { classifyLeases, classifyStaleAgents, DEFAULT_GLOBAL_DEADLINE_MS, DEFAULT_INSPECT_CONCURRENCY } from "../scripts/watchdog.mjs";

const now = Date.parse("2026-08-08T12:00:00.000Z");
const result = classifyStaleAgents(
  [
    { id: "old", status: "running", updatedAt: "2026-08-08T11:50:00.000Z", inspectOk: true },
    { id: "recent", status: "running", updatedAt: "2026-08-08T11:59:50.000Z", inspectOk: true },
    { id: "idle", status: "idle", updatedAt: "2026-08-08T10:00:00.000Z" },
    { id: "invalid", status: "running", updatedAt: "not-a-date", inspectOk: true },
    { id: "unreachable", status: "running", updatedAt: "2026-08-08T11:00:00.000Z", inspectOk: false },
  ],
  { now, staleAfterMs: 5 * 60_000 },
);
assert.deepEqual(result.map((agent) => agent.id), ["old", "recent", "invalid", "unreachable"]);
assert.equal(result.find((agent) => agent.id === "old").stale, true);
assert.equal(result.find((agent) => agent.id === "recent").stale, false);
assert.equal(result.find((agent) => agent.id === "invalid").confidence, "unknown");
assert.equal(result.find((agent) => agent.id === "invalid").stale, false);
assert.equal(result.find((agent) => agent.id === "unreachable").confidence, "unknown");
assert.equal(result.find((agent) => agent.id === "unreachable").stale, false);
assert.equal(DEFAULT_INSPECT_CONCURRENCY, 6);
assert.equal(DEFAULT_GLOBAL_DEADLINE_MS, 30_000);

{
  let active = 0;
  let peak = 0;
  const result = await (await import("../scripts/watchdog.mjs")).collectWatchdogSnapshot({
    concurrency: 2,
    globalDeadlineMs: 2_000,
    commandTimeoutMs: 500,
    maxAttempts: 1,
    runPaseoJson: async (args) => {
      if (args[0] === "ls") {
        return Array.from({ length: 6 }, (_, index) => ({ id: `agent-${index}`, status: "running" }));
      }
      active += 1;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, 25));
      active -= 1;
      return { Status: "running", UpdatedAt: "2026-08-08T11:00:00.000Z", PendingPermissions: [] };
    },
    now,
  });
  assert.equal(peak, 2, "watchdog inspect concurrency is bounded");
  assert.equal(result.agents.length, 6);
  assert.equal(result.partial, false);

  const capped = await (await import("../scripts/watchdog.mjs")).collectWatchdogSnapshot({
    maxAgents: 2,
    globalDeadlineMs: 2_000,
    commandTimeoutMs: 500,
    maxAttempts: 1,
    runPaseoJson: async (args) => args[0] === "ls"
      ? Array.from({ length: 3 }, (_, index) => ({ id: `agent-${index}`, status: "running" }))
      : { Status: "running", UpdatedAt: "2026-08-08T11:00:00.000Z", PendingPermissions: [] },
    now,
  });
  assert.equal(capped.agents.length, 2);
  assert.equal(capped.partial, true, "maxAgents cap is reported as partial");
}

// --- lease board: the second way a scope gets stuck --------------------------
// A held scope blocks every other Lead, so the two ways it goes wrong deserve an
// operator's attention: the holder disappeared, or the lease lapsed under a
// holder that is still running. Neither is something the watchdog may fix —
// reclaiming ground from a Lead that might be mid-write is exactly how a second
// writer appears.
{
	const now = 10_000_000;
	const ALIVE = "aaaaaaaa-1111-4111-8111-111111111111";
	const GONE = "bbbbbbbb-2222-4222-8222-222222222222";
	const leases = new Map([
		["src/ok", { agentId: ALIVE, scope: "src/ok", claimedAt: now - 1000, expiresAt: now + 1000 }],
		["src/orphan", { agentId: GONE, scope: "src/orphan", claimedAt: now - 1000, expiresAt: now + 1000 }],
		["src/lapsed", { agentId: ALIVE, scope: "src/lapsed", claimedAt: now - 5000, expiresAt: now - 1 }],
	]);
	const rows = classifyLeases(leases, [{ id: ALIVE }], { now });

	assert.equal(rows.length, 2, "a healthy lease is not reported — noise would train the operator to skim");
	const orphan = rows.find((row) => row.scope === "src/orphan");
	assert.equal(orphan.holderListed, false);
	assert.equal(orphan.expired, false);
	assert.match(orphan.suspicion, /not in the agent listing/);

	const lapsed = rows.find((row) => row.scope === "src/lapsed");
	assert.equal(lapsed.holderListed, true);
	assert.equal(lapsed.expired, true);
	assert.match(lapsed.suspicion, /refused/, "the Lead is told what will happen, not merely that it is late");

	// Nothing to report, and nothing to throw, when the board is empty or absent.
	assert.deepEqual(classifyLeases(new Map(), [{ id: ALIVE }], { now }), []);
	assert.deepEqual(classifyLeases(null, null, { now }), []);
}

console.log("watchdog tests passed");

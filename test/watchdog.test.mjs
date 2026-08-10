import assert from "node:assert/strict";
import { classifyStaleAgents, DEFAULT_GLOBAL_DEADLINE_MS, DEFAULT_INSPECT_CONCURRENCY } from "../scripts/watchdog.mjs";

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

console.log("watchdog tests passed");

import assert from "node:assert/strict";
import { classifyStaleAgents } from "../scripts/watchdog.mjs";

const now = Date.parse("2026-08-08T12:00:00.000Z");
const result = classifyStaleAgents(
  [
    { id: "old", status: "running", updatedAt: "2026-08-08T11:50:00.000Z" },
    { id: "recent", status: "running", updatedAt: "2026-08-08T11:59:50.000Z" },
    { id: "idle", status: "idle", updatedAt: "2026-08-08T10:00:00.000Z" },
    { id: "invalid", status: "running", updatedAt: "not-a-date" },
  ],
  { now, staleAfterMs: 5 * 60_000 },
);
assert.deepEqual(result.map((agent) => agent.id), ["old", "recent", "invalid"]);
assert.equal(result.find((agent) => agent.id === "old").stale, true);
assert.equal(result.find((agent) => agent.id === "recent").stale, false);
assert.equal(result.find((agent) => agent.id === "invalid").confidence, "unknown");
console.log("watchdog tests passed");

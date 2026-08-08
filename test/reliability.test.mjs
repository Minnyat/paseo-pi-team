import assert from "node:assert/strict";
import {
  classifyRemoteFailure,
  computeRetryDelayMs,
  isStaleAgent,
  retryWithBackoff,
} from "../scripts/reliability.mjs";

assert.equal(classifyRemoteFailure({ code: "CLI_ERROR", error: "ECONNRESET" }), "retryable");
assert.equal(classifyRemoteFailure({ code: "CLI_ERROR", error: "operation timed out" }), "retryable");
assert.equal(classifyRemoteFailure({ code: "ENDPOINT_ENV_MISSING" }), "non-retryable");
assert.equal(classifyRemoteFailure({ code: "USAGE" }), "non-retryable");
assert.equal(classifyRemoteFailure({ code: "CLI_ERROR", error: "permission denied" }), "non-retryable");

assert.equal(computeRetryDelayMs(0, { baseMs: 100, maxMs: 1000, jitter: 0 }), 100);
assert.equal(computeRetryDelayMs(1, { baseMs: 100, maxMs: 1000, jitter: 0 }), 200);
assert.equal(computeRetryDelayMs(20, { baseMs: 100, maxMs: 1000, jitter: 0 }), 1000);

const attempts = [];
const value = await retryWithBackoff(
  async (attempt) => {
    attempts.push(attempt);
    if (attempt < 2) throw Object.assign(new Error("ECONNRESET"), { code: "CLI_ERROR" });
    return "ok";
  },
  { maxAttempts: 3, baseMs: 0, jitter: 0 },
);
assert.equal(value, "ok");
assert.deepEqual(attempts, [0, 1, 2]);

await assert.rejects(
  retryWithBackoff(
    async () => { throw Object.assign(new Error("bad authority"), { code: "USAGE" }); },
    { maxAttempts: 3, baseMs: 0, jitter: 0 },
  ),
  /bad authority/,
);
await assert.rejects(
  retryWithBackoff(
    async () => { throw Object.assign(new Error("ECONNRESET"), { code: "CLI_ERROR" }); },
    { maxAttempts: 3, baseMs: 10, jitter: 0, deadlineMs: Date.now() - 1 },
  ),
  /deadline exceeded/,
);

const now = Date.parse("2026-08-08T12:00:00.000Z");
assert.equal(isStaleAgent({ status: "running", updatedAt: "2026-08-08T11:59:00.000Z" }, { now, staleAfterMs: 30_000 }), true);
assert.equal(isStaleAgent({ status: "running", updatedAt: "2026-08-08T11:59:50.000Z" }, { now, staleAfterMs: 30_000 }), false);
assert.equal(isStaleAgent({ status: "idle", updatedAt: "2026-08-08T11:00:00.000Z" }, { now, staleAfterMs: 30_000 }), false);

console.log("reliability tests passed");

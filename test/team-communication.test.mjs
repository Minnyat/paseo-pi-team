import assert from "node:assert/strict";
import {
  MESSAGE_KINDS,
  parentAgentIdFromInspect,
  runPaseo,
  sendPeerMessage,
  validatePeerMessage,
} from "../scripts/team-communication.mjs";
import { classifyRemoteFailure } from "../scripts/reliability.mjs";

assert.deepEqual([...MESSAGE_KINDS], ["question", "blocked", "dependency", "progress"]);
assert.deepEqual(
  validatePeerMessage({ kind: "question", message: "Need clarification", taskId: "T-1", correlationId: "c-1" }),
  { kind: "question", message: "Need clarification", taskId: "T-1", correlationId: "c-1" },
);
assert.throws(() => validatePeerMessage({ kind: "broadcast", message: "x" }), /kind must be/);
assert.throws(() => validatePeerMessage({ kind: "blocked", message: "   " }), /non-empty/);
assert.throws(() => validatePeerMessage({ kind: "blocked", message: "x".repeat(12_001) }), /12000/);
for (const field of ["taskId", "correlationId"]) {
  assert.throws(
    () => validatePeerMessage({ kind: "question", message: "x", [field]: "bad\\nheader" }),
    new RegExp(`${field}.*token`),
  );
  assert.throws(
    () => validatePeerMessage({ kind: "question", message: "x", [field]: "x".repeat(257) }),
    new RegExp(`${field}.*token`),
  );
}

assert.equal(parentAgentIdFromInspect({ ParentAgentId: "lead-1" }), "lead-1");
assert.equal(parentAgentIdFromInspect({ parentAgentId: "lead-2" }), "lead-2");
assert.equal(parentAgentIdFromInspect({ labels: { "paseo.parent-agent-id": "lead-3" } }), "lead-3");
assert.equal(parentAgentIdFromInspect({ ParentAgentId: null }), null);

{
  const previousAgentId = process.env.PASEO_AGENT_ID;
  process.env.PASEO_AGENT_ID = "peer-1";
  const calls = [];
  await assert.rejects(
    sendPeerMessage(
      { kind: "blocked", message: "Lead needed", taskId: "T-1", correlationId: "c-1" },
      {
        maxAttempts: 3,
        baseMs: 0,
        runPaseo: async (args) => {
          calls.push(args);
          if (args[0] === "inspect") return { ok: true, data: { ParentAgentId: "lead-1" } };
          throw Object.assign(new Error("connection reset after delivery"), { code: "CLI_ERROR" });
        },
      },
    ),
    /connection reset after delivery/,
  );
  assert.deepEqual(calls.map((args) => args[0]), ["inspect", "send"], "send mutation is never retried");
  if (previousAgentId === undefined) delete process.env.PASEO_AGENT_ID;
  else process.env.PASEO_AGENT_ID = previousAgentId;
}

// A malformed PASEO_TEAM_PASEO_EXEC must fail before any spawn, with a code
// reliability.mjs treats as non-retryable — retrying a config fault only
// delays the operator seeing it.
{
  const previous = process.env.PASEO_TEAM_PASEO_EXEC;
  for (const [override, expected] of [
    ['""', /is set but empty/],
    ['"unclosed', /unterminated quote/],
  ]) {
    process.env.PASEO_TEAM_PASEO_EXEC = override;
    assert.throws(
      () => runPaseo(["inspect", "x"]),
      (error) => {
        assert.equal(error.code, "PASEO_EXEC_INVALID");
        assert.match(error.message, expected);
        assert.equal(classifyRemoteFailure(error), "non-retryable");
        return true;
      },
    );
  }
  if (previous === undefined) delete process.env.PASEO_TEAM_PASEO_EXEC;
  else process.env.PASEO_TEAM_PASEO_EXEC = previous;
}

console.log("team communication tests passed");

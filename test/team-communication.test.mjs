import assert from "node:assert/strict";
import {
  MESSAGE_KINDS,
  parentAgentIdFromInspect,
  validatePeerMessage,
} from "../scripts/team-communication.mjs";

assert.deepEqual([...MESSAGE_KINDS], ["question", "blocked", "dependency", "progress"]);
assert.deepEqual(
  validatePeerMessage({ kind: "question", message: "Need clarification", taskId: "T-1", correlationId: "c-1" }),
  { kind: "question", message: "Need clarification", taskId: "T-1", correlationId: "c-1" },
);
assert.throws(() => validatePeerMessage({ kind: "broadcast", message: "x" }), /kind must be/);
assert.throws(() => validatePeerMessage({ kind: "blocked", message: "   " }), /non-empty/);
assert.throws(() => validatePeerMessage({ kind: "blocked", message: "x".repeat(12_001) }), /12000/);

assert.equal(parentAgentIdFromInspect({ ParentAgentId: "lead-1" }), "lead-1");
assert.equal(parentAgentIdFromInspect({ parentAgentId: "lead-2" }), "lead-2");
assert.equal(parentAgentIdFromInspect({ labels: { "paseo.parent-agent-id": "lead-3" } }), "lead-3");
assert.equal(parentAgentIdFromInspect({ ParentAgentId: null }), null);

console.log("team communication tests passed");

import assert from "node:assert/strict";
import {
  buildConsultBody,
  chooseSupervisor,
  CONSULT_KINDS,
  MESSAGE_KINDS,
  parentAgentIdFromInspect,
  runPaseo,
  sendLeadConsult,
  sendPeerMessage,
  validateConsult,
  validatePeerMessage,
} from "../scripts/team-communication.mjs";
import * as core from "../extensions/paseo-team-core/policy-core.ts";
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

// ---------------------------------------------------------------------------
// Lead -> Supervisor consult (PR-H)
//
// The routing is the interesting half. A Peer's recipient is a fact
// (ParentAgentId); a Lead's is a SEARCH, and the ways a search can come back
// wrong are the ways this channel silently degrades back into "ask the Human".
// ---------------------------------------------------------------------------

assert.deepEqual([...CONSULT_KINDS], ["decision", "question", "risk"]);
// The tool's kinds and the parser's must be the same set, or a Lead can ask for
// something the receiving runtime files as malformed.
assert.deepEqual([...CONSULT_KINDS].sort(), [...core.LEAD_CONSULT_KINDS].sort());

const CONSULT = {
  kind: "decision",
  question: "Retry the token refresh, or fail the step?",
  options: "a) retry once with backoff\nb) fail and report",
  evidence: "the run failed once with ECONNRESET; a manual rerun passed",
  scope: "src/auth/token.ts",
  reversibility: "reversible",
  taskId: "T-9",
};

{
  const valid = validateConsult(CONSULT, core.LEAD_CONSULT_FIELD_NAMES);
  assert.equal(valid.scope, "src/auth/token.ts");
  assert.match(valid.correlationId, /^consult-/);
  assert.equal(valid.text.RECOMMENDATION, undefined, "recommendation stays optional");

  // Every field a delegation criterion is checked against is required at the
  // SENDER, so an unanswerable consult never costs a round trip.
  for (const field of ["question", "options", "evidence", "scope"]) {
    assert.throws(
      () => validateConsult({ ...CONSULT, [field]: "  " }, core.LEAD_CONSULT_FIELD_NAMES),
      new RegExp(field),
    );
  }
  assert.throws(() => validateConsult({ ...CONSULT, kind: "escalation" }, core.LEAD_CONSULT_FIELD_NAMES), /kind must be/);
  assert.throws(() => validateConsult({ ...CONSULT, reversibility: "maybe" }, core.LEAD_CONSULT_FIELD_NAMES), /reversibility must be/);

  // A pasted log line that happens to be a real field name would come back as a
  // duplicate field and get the whole consult refused as malformed — one round
  // trip away from the text the Lead could have fixed. So it is refused here.
  assert.throws(
    () => validateConsult({ ...CONSULT, evidence: "SCOPE: src/other.ts" }, core.LEAD_CONSULT_FIELD_NAMES),
    /reads as a field/,
  );
  // An unknown ALLCAPS line is ordinary prose and must pass.
  assert.ok(validateConsult({ ...CONSULT, evidence: "ERROR: connection reset" }, core.LEAD_CONSULT_FIELD_NAMES));
}

// The envelope this sender writes must be the envelope the receiving runtime
// parses. Both halves are pinned here because they live in different languages
// and different processes.
{
  const valid = validateConsult(CONSULT, core.LEAD_CONSULT_FIELD_NAMES);
  const body = buildConsultBody(valid, {
    self: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
    domain: "backend.auth",
    header: core.LEAD_CONSULT_HEADER,
  });
  const parsed = core.parseLeadConsultBlock(body);
  assert.ok(parsed, "the core must be able to parse what this script writes");
  assert.deepEqual(parsed.malformed, [], parsed.malformed.join("; "));
  assert.equal(parsed.kind, "decision");
  assert.equal(parsed.domain, "backend.auth");
  assert.equal(parsed.fields.get("SCOPE"), "src/auth/token.ts");
  assert.match(parsed.fields.get("OPTIONS"), /fail and report/);
}

// --- recipient resolution -----------------------------------------------------
{
  const seat = (agentId, domain = null) => ({ agentId, domain, cluster: "shop" });

  assert.equal(
    chooseSupervisor({ seats: [seat("s1")], topology: "single", leadDomain: null, domainCovers: core.domainCovers }).agentId,
    "s1",
  );

  // Zero is the ONLY case where asking the Human is correct, so it is named and
  // it carries the call that fixes it.
  assert.throws(
    () => chooseSupervisor({ seats: [], topology: "single", leadDomain: null, domainCovers: core.domainCovers }),
    (error) => {
      assert.equal(error.code, "NO_SUPERVISOR_SEAT");
      assert.match(error.message, /create_agent/);
      assert.match(error.message, /purpose/);
      return true;
    },
  );

  // Two claimants is a governance question the sender must not settle: the
  // Lead's own runtime refuses BOTH in that situation, so a guessed answer
  // would be thrown away on arrival.
  assert.throws(
    () => chooseSupervisor({ seats: [seat("s1"), seat("s2")], topology: "single", leadDomain: null, domainCovers: core.domainCovers }),
    (error) => {
      assert.equal(error.code, "SUPERVISOR_AMBIGUOUS");
      assert.match(error.message, /s1/);
      assert.match(error.message, /s2/);
      return true;
    },
  );

  // Under multi the candidates are narrowed by jurisdiction: a Supervisor that
  // could not issue a binding decision here is not an address.
  const seats = [seat("s-backend", "backend"), seat("s-frontend", "frontend")];
  assert.equal(
    chooseSupervisor({ seats, topology: "multi", leadDomain: "backend.auth", domainCovers: core.domainCovers }).agentId,
    "s-backend",
  );
  assert.throws(
    () => chooseSupervisor({ seats, topology: "multi", leadDomain: "payments", domainCovers: core.domainCovers }),
    (error) => {
      assert.equal(error.code, "NO_SUPERVISOR_SEAT");
      // "there are seats, none of them governs you" is a different fix from
      // "there are no seats", and the message must not conflate them.
      assert.match(error.message, /none carries a team\.domain/);
      return true;
    },
  );

  // An explicitly named seat still has to be eligible.
  assert.equal(
    chooseSupervisor({ seats, topology: "multi", leadDomain: "backend.auth", domainCovers: core.domainCovers, requested: "s-backend" }).agentId,
    "s-backend",
  );
  assert.throws(
    () => chooseSupervisor({ seats, topology: "multi", leadDomain: "backend.auth", domainCovers: core.domainCovers, requested: "s-frontend" }),
    (error) => {
      assert.equal(error.code, "SUPERVISOR_NOT_ELIGIBLE");
      return true;
    },
  );
}

// --- end to end, with the core stubbed ----------------------------------------
{
  const stub = {
    ...core,
    supervisorSeats: () => [{ agentId: "sup-1", domain: "backend", cluster: "shop" }],
    selfCluster: () => "shop",
    teamTopology: () => "single",
  };
  const calls = [];
  const result = await sendLeadConsult(CONSULT, {
    core: stub,
    env: { PASEO_AGENT_ID: "lead-1" },
    runPaseo: async (args) => {
      calls.push(args);
      return { ok: true, data: { queued: true } };
    },
  });
  assert.equal(result.ok, true);
  assert.equal(result.recipient, "sup-1");
  assert.match(result.awaiting, /SUPERVISOR_DECISION/);
  assert.deepEqual(calls.map((args) => args[0]), ["send"], "one send, never a retry");
  assert.equal(calls[0][1], "sup-1");
  assert.match(calls[0][3], new RegExp(`^${core.LEAD_CONSULT_HEADER}`, "m"));
  assert.match(calls[0][3], /FROM_AGENT_ID: lead-1/);
  assert.ok(calls[0].includes("--no-wait"));

  // "I could not look" must never be reported as "there is nobody" — that is
  // the difference between a Lead that retries and a Lead that asks the Human.
  await assert.rejects(
    sendLeadConsult(CONSULT, {
      core: { ...stub, supervisorSeats: () => { throw new Error("state unreadable"); } },
      env: { PASEO_AGENT_ID: "lead-1" },
      runPaseo: async () => ({ ok: true, data: {} }),
    }),
    (error) => {
      assert.equal(error.code, "SUPERVISOR_LOOKUP_FAILED");
      return true;
    },
  );

  await assert.rejects(
    sendLeadConsult(CONSULT, { core: stub, env: {}, runPaseo: async () => ({ ok: true, data: {} }) }),
    (error) => {
      assert.equal(error.code, "AGENT_ID_MISSING");
      return true;
    },
  );
}

console.log("team communication tests passed");

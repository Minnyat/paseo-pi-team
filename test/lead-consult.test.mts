/**
 * lead-consult.test.mts — PR-H: the Lead's own escalation path.
 *
 * The failure this pack shipped with was not that a Lead disobeyed a
 * SUPERVISOR_DECISION — PR-D fixed that direction. It was the other one: a Lead
 * with a question of its own had exactly one addressable party in its contract,
 * the Human, because nothing in the pack let a Lead SPEAK FIRST to the
 * Supervisor. Every rule here exists to make that first move possible and to
 * make the answer obligatory.
 *
 * Fixture-driven like governance.test.mts: no daemon, no agent, no clock.
 */

import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
	LEAD_CONSULT_ACTIONABLE,
	LEAD_CONSULT_CLUSTER_MISMATCH,
	LEAD_CONSULT_HEADER,
	LEAD_CONSULT_HUMAN_BOUND,
	LEAD_CONSULT_JURISDICTION_UNDECLARED,
	LEAD_CONSULT_MALFORMED,
	LEAD_CONSULT_OUT_OF_JURISDICTION,
	LEAD_CONSULT_SENDER_UNVERIFIED,
	LEAD_CONSULT_TOOL,
	leadAskSupervisorToolDescription,
	leadConsultAttribution,
	leadConsultToolBlockReason,
	leadConsultTurnNotice,
	leadConsultVerdict,
	leadCreateSupervisorArgsBlockReason,
	parseLeadConsultBlock,
	policyFor,
	teamToolBlockReason,
} from "../extensions/paseo-team-core/policy-core.ts";

const SUP_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const SUP_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const LEAD_A = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const PEER_B = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";

/** A well-formed consult, so each test can spoil exactly one thing. */
function consultText(overrides: Record<string, string> = {}, body = ""): string {
	const fields: Record<string, string> = {
		KIND: "decision",
		CORRELATION_ID: "consult-1",
		TASK_ID: "T-9",
		FROM_AGENT_ID: LEAD_A,
		SCOPE: "src/auth/token.ts",
		REVERSIBILITY: "reversible",
		...overrides,
	};
	const head = Object.entries(fields)
		.filter(([, value]) => value !== "")
		.map(([key, value]) => `${key}: ${value}`);
	return [
		"here is some preamble the runtime may prepend",
		LEAD_CONSULT_HEADER,
		...head,
		"",
		"QUESTION:",
		"Retry the token refresh, or fail the step?",
		"",
		"OPTIONS:",
		"a) retry once with backoff",
		"b) fail and report",
		"",
		"EVIDENCE:",
		body || "the run failed once with ECONNRESET; the second manual run passed",
	].join("\n");
}

// ---------------------------------------------------------------------------
// Parsing — a consult the Supervisor cannot read is a consult it must not
// answer, and prose must not be able to invent fields.
// ---------------------------------------------------------------------------

test("a complete consult parses into the fields the delegation criteria need", () => {
	const block = parseLeadConsultBlock(consultText());
	assert.ok(block);
	assert.deepEqual(block.malformed, []);
	assert.equal(block.kind, "decision");
	assert.equal(block.irreversible, false);
	assert.equal(block.fields.get("FROM_AGENT_ID"), LEAD_A);
	assert.equal(block.fields.get("SCOPE"), "src/auth/token.ts");
	// Multi-line sections are joined, not truncated at the field line: EVIDENCE
	// is prose by nature, and a parser that kept only the header line would read
	// every honest consult as an empty one.
	assert.match(block.fields.get("OPTIONS") ?? "", /retry once with backoff/);
	assert.match(block.fields.get("OPTIONS") ?? "", /fail and report/);
	assert.match(block.fields.get("EVIDENCE") ?? "", /ECONNRESET/);
});

test("text that merely mentions the header is not a consult", () => {
	assert.equal(parseLeadConsultBlock("see LEAD_CONSULT_V1 in the docs"), null);
	assert.equal(parseLeadConsultBlock(""), null);
	assert.equal(parseLeadConsultBlock(null), null);
});

test("prose inside a section cannot invent a field", () => {
	// `ERROR:` is exactly the shape of a pasted log line. If it became a field,
	// an honest consult would parse strangely; if it became a DUPLICATE of a real
	// field, an honest consult would be refused outright.
	const block = parseLeadConsultBlock(
		consultText({}, ["ERROR: connection reset by peer", "NOTE: happened once"].join("\n")),
	);
	assert.ok(block);
	assert.deepEqual(block.malformed, []);
	assert.equal(block.fields.has("ERROR"), false);
	assert.match(block.fields.get("EVIDENCE") ?? "", /connection reset by peer/);
});

test("a consult missing anything a criterion is checked against is malformed", () => {
	for (const missing of ["SCOPE", "REVERSIBILITY"]) {
		const block = parseLeadConsultBlock(consultText({ [missing]: "" }));
		assert.ok(block);
		assert.ok(
			block.malformed.some((entry) => entry.startsWith(missing)),
			`${missing}: ${block.malformed.join("; ")}`,
		);
	}
	// The prose sections are required for the same reason — criterion 3 is
	// "sufficient evidence", and it cannot be evaluated against nothing.
	const noEvidence = parseLeadConsultBlock(
		[LEAD_CONSULT_HEADER, "KIND: decision", `FROM_AGENT_ID: ${LEAD_A}`, "SCOPE: x", "REVERSIBILITY: reversible", "QUESTION:", "why?", "OPTIONS:", "a or b"].join("\n"),
	);
	assert.ok(noEvidence);
	assert.ok(noEvidence.malformed.some((entry) => entry.startsWith("EVIDENCE")));
});

test("a bad KIND or REVERSIBILITY is recorded rather than guessed", () => {
	const badKind = parseLeadConsultBlock(consultText({ KIND: "escalation" }));
	assert.ok(badKind?.malformed.some((entry) => entry.startsWith("KIND")));
	const badReversibility = parseLeadConsultBlock(consultText({ REVERSIBILITY: "maybe" }));
	assert.ok(badReversibility?.malformed.some((entry) => entry.startsWith("REVERSIBILITY")));
	const duplicate = parseLeadConsultBlock(
		consultText().replace("SCOPE: src/auth/token.ts", "SCOPE: a\nSCOPE: b"),
	);
	assert.ok(duplicate?.malformed.includes("duplicate field SCOPE"));
});

// ---------------------------------------------------------------------------
// Attribution — the mirror of supervisorAttribution, and load-bearing for the
// mirrored reason: the notice tells the Supervisor to answer with a decision
// the Lead's runtime will then treat as BINDING.
// ---------------------------------------------------------------------------

/** A temp PASEO_HOME whose agent states make attribution answerable. */
function consultHome(): { env: Record<string, string>; cleanup: () => void } {
	const home = mkdtempSync(join(tmpdir(), "pteam-consult-"));
	const dir = join(home, "agents", "D--Code-shop");
	mkdirSync(dir, { recursive: true });
	const write = (id: string, provider: string, labels: Record<string, string>) =>
		writeFileSync(join(dir, `${id}.json`), JSON.stringify({ id, provider, labels }));
	write(LEAD_A, "pi-lead/anthropic/model", { "team.domain": "backend.auth", "team.cluster": "shop" });
	write(SUP_A, "pi-supervisor/anthropic/model", { "team.domain": "backend", "team.cluster": "shop" });
	write(PEER_B, "pi-peer/anthropic/model", { "team.cluster": "shop" });
	write(SUP_B, "pi-lead/anthropic/model", { "team.cluster": "other-repo" });
	return { env: { PASEO_HOME: home }, cleanup: () => rmSync(home, { recursive: true, force: true }) };
}

test("only a real Lead seat verifies as the sender of a consult", () => {
	const { env, cleanup } = consultHome();
	try {
		const verified = leadConsultAttribution(LEAD_A, env);
		assert.equal(verified.status, "verified");
		assert.equal(verified.role, "lead");
		assert.equal(verified.cluster, "shop");

		// A Peer that types the header is not a Lead asking a question.
		const peer = leadConsultAttribution(PEER_B, env);
		assert.equal(peer.status, "unverified");
		assert.equal(peer.role, "peer");

		// Unknown id, and no id at all, are different failures and say so.
		assert.equal(leadConsultAttribution("00000000-0000-4000-8000-000000000000", env).status, "unverified");
		assert.equal(leadConsultAttribution(null, env).status, "unclaimed");
	} finally {
		cleanup();
	}
});

// ---------------------------------------------------------------------------
// The verdict, and the directive that is the whole point of it
// ---------------------------------------------------------------------------

const verified = { fromAgentId: LEAD_A, role: "lead" as const, status: "verified" as const, reason: "agent holds a Lead seat", cluster: "shop" };

function verdictFor(text: string, extra: Record<string, unknown> = {}) {
	const block = parseLeadConsultBlock(text);
	assert.ok(block);
	return {
		block,
		verdict: leadConsultVerdict({
			block,
			attribution: verified,
			supervisorCluster: "shop",
			...extra,
		}),
	};
}

test("a well-formed consult from a verified Lead is actionable, and says DECIDE OR ESCALATE", () => {
	const { block, verdict } = verdictFor(consultText());
	assert.equal(verdict.code, LEAD_CONSULT_ACTIONABLE);
	assert.equal(verdict.severity, "accept");

	const notice = leadConsultTurnNotice({ block, verdict, attribution: verified });
	assert.ok(notice);
	// The directive, not the fact, is what changes behaviour — the same lesson
	// PR-D learned on the Lead's side. A Supervisor told only "this consult is
	// in your jurisdiction" answers with a recommendation and leaves the Lead
	// exactly where it was.
	assert.match(notice, /DECIDE OR ESCALATE/);
	assert.match(notice, /SUPERVISOR_DECISION/);
	assert.match(notice, /HUMAN_DECISION_REQUIRED: no/);
	assert.match(notice, /naming WHICH criterion/i);
	assert.match(notice, /Answering is NOT optional/);
	assert.match(notice, /consult-1/, "the correlation id travels so the Lead can match the answer");
});

test("a consult the Lead itself marked irreversible is answerable, but only upward", () => {
	const { block, verdict } = verdictFor(consultText({ REVERSIBILITY: "irreversible" }));
	// Accepting: it is a legitimate consult and must still be answered. What is
	// settled in advance is the SHAPE of the answer — criterion 2 has already
	// failed, and self-deciding it would violate the Supervisor's own contract.
	assert.equal(verdict.code, LEAD_CONSULT_HUMAN_BOUND);
	assert.equal(verdict.severity, "accept");
	assert.equal(verdict.ok, true);

	const notice = leadConsultTurnNotice({ block, verdict, attribution: verified });
	assert.ok(notice);
	assert.match(notice, /ESCALATE/);
	assert.match(notice, /HUMAN_DECISION_REQUIRED: yes/);
	assert.match(notice, /Do NOT fill a\s*\n?SUPERVISOR_DECISION block/);
});

test("an unverified sender gets an answer, but never a delegated decision", () => {
	const block = parseLeadConsultBlock(consultText());
	assert.ok(block);
	const attribution = { fromAgentId: PEER_B, role: "peer" as const, status: "unverified" as const, reason: "agent resolves to peer", cluster: "shop" };
	const verdict = leadConsultVerdict({ block, attribution, supervisorCluster: "shop" });
	assert.equal(verdict.code, LEAD_CONSULT_SENDER_UNVERIFIED);
	assert.equal(verdict.severity, "warn");
	const notice = leadConsultTurnNotice({ block, verdict, attribution });
	assert.ok(notice);
	assert.match(notice, /Do NOT issue a SUPERVISOR_DECISION/);
});

test("a malformed consult is refused before any of it is weighed", () => {
	const { block, verdict } = verdictFor(consultText({ SCOPE: "" }));
	assert.equal(verdict.code, LEAD_CONSULT_MALFORMED);
	assert.equal(verdict.severity, "refuse");
	const notice = leadConsultTurnNotice({ block, verdict, attribution: verified });
	assert.ok(notice);
	// Refusing silently would park the Lead exactly as an unanswered consult
	// does, so even the refusal has to go back.
	assert.match(notice, new RegExp(`BLOCKED: ${LEAD_CONSULT_MALFORMED}`));
	assert.match(notice, /can route the question correctly/);
});

test("a consult from another cluster is refused on every topology", () => {
	const block = parseLeadConsultBlock(consultText());
	assert.ok(block);
	const foreign = { ...verified, cluster: "other-repo" };
	for (const topology of ["single", "multi"] as const) {
		const verdict = leadConsultVerdict({
			block,
			attribution: foreign,
			supervisorCluster: "shop",
			supervisorDomain: "*",
			topology,
		});
		assert.equal(verdict.code, LEAD_CONSULT_CLUSTER_MISMATCH, topology);
		assert.equal(verdict.severity, "refuse", topology);
	}
	// Separation must be PROVEN: an underivable cluster on either side restricts
	// nothing, exactly as everywhere else in the pack.
	const unknown = leadConsultVerdict({
		block,
		attribution: { ...verified, cluster: null },
		supervisorCluster: "shop",
	});
	assert.equal(unknown.code, LEAD_CONSULT_ACTIONABLE);
});

test("jurisdiction bounds the consult only under multi", () => {
	const inside = verdictFor(consultText({ DOMAIN: "backend.auth" }), {
		topology: "multi",
		supervisorDomain: "backend",
	});
	assert.equal(inside.verdict.code, LEAD_CONSULT_ACTIONABLE);

	const outside = verdictFor(consultText({ DOMAIN: "frontend" }), {
		topology: "multi",
		supervisorDomain: "backend",
	});
	assert.equal(outside.verdict.code, LEAD_CONSULT_OUT_OF_JURISDICTION);
	assert.equal(outside.verdict.severity, "refuse");

	// No DOMAIN under multi, and an unlabelled Supervisor, are both undeclared
	// jurisdiction — fail-closed, and each names its own half of the fix.
	assert.equal(
		verdictFor(consultText(), { topology: "multi", supervisorDomain: "backend" }).verdict.code,
		LEAD_CONSULT_JURISDICTION_UNDECLARED,
	);
	assert.equal(
		verdictFor(consultText({ DOMAIN: "backend.auth" }), { topology: "multi", supervisorDomain: null }).verdict.code,
		LEAD_CONSULT_JURISDICTION_UNDECLARED,
	);

	// Under `single`, a domain-less consult is the normal case and is actionable.
	assert.equal(verdictFor(consultText()).verdict.code, LEAD_CONSULT_ACTIONABLE);
});

// ---------------------------------------------------------------------------
// Who holds the channel
// ---------------------------------------------------------------------------

test("the consult tool belongs to the Lead alone", () => {
	assert.equal(leadConsultToolBlockReason("lead"), null);
	// A Peer with a second escalation path routes around its own Lead.
	assert.match(String(leadConsultToolBlockReason("peer")), /peer_ask_lead/);
	// A Supervisor holding it would be consulting itself.
	assert.match(String(leadConsultToolBlockReason("supervisor")), /team_chat/);
	// Unrelated tool names fall straight through.
	assert.equal(leadConsultToolBlockReason("peer", "team_chat"), null);

	// And the coarse gate both runtimes call agrees.
	assert.equal(teamToolBlockReason("lead", LEAD_CONSULT_TOOL, null), null);
	assert.ok(teamToolBlockReason("peer", LEAD_CONSULT_TOOL, null));
	assert.ok(teamToolBlockReason("supervisor", LEAD_CONSULT_TOOL, null));

	// The Pi surface must actually expose it, or the gate guards nothing.
	assert.ok(policyFor("lead", "read-only").allow.includes(LEAD_CONSULT_TOOL));
	assert.ok(!policyFor("supervisor", "read-only").allow.includes(LEAD_CONSULT_TOOL));
	assert.ok(!policyFor("peer", "write").allow.includes(LEAD_CONSULT_TOOL));
});

test("the tool description names the Supervisor as the default and the Human as the exception", () => {
	const text = leadAskSupervisorToolDescription();
	assert.match(text, /instead of asking the Human/i);
	assert.match(text, /NO_SUPERVISOR_SEAT/);
	assert.match(text, /irreversible/i);
});

// ---------------------------------------------------------------------------
// A Lead seating its own Supervisor — the other half of "do not ask the Human"
// ---------------------------------------------------------------------------

const SEAT_OK = {
	provider: "pi-supervisor/anthropic/claude-opus-5",
	labels: { purpose: "governance", "team.cluster": "shop" },
	settings: { thinkingOptionId: "high" },
};

test("a Lead may seat a Supervisor, but not a weakened one", () => {
	assert.equal(leadCreateSupervisorArgsBlockReason(SEAT_OK), null);
	assert.equal(
		leadCreateSupervisorArgsBlockReason({ ...SEAT_OK, provider: "claude-supervisor/claude-opus-5" }),
		null,
	);

	// A bare provider lets the daemon pick the model for the one seat whose
	// reasoning quality decides what the Human never gets asked.
	assert.match(
		String(leadCreateSupervisorArgsBlockReason({ ...SEAT_OK, provider: "pi-supervisor" })),
		/never a bare/,
	);
	assert.match(
		String(leadCreateSupervisorArgsBlockReason({ ...SEAT_OK, labels: { "team.cluster": "shop" } })),
		/purpose/,
	);
	assert.match(
		String(leadCreateSupervisorArgsBlockReason({ ...SEAT_OK, settings: {} })),
		/thinkingOptionId/,
	);
});

test("the seat gate ignores every create_agent that is not a Supervisor", () => {
	// Peers and successor Leads are governed by the lease gate and the cluster
	// gate; this one must return null for them or it would double-refuse.
	assert.equal(
		leadCreateSupervisorArgsBlockReason({ provider: "pi-peer/anthropic/model", labels: {} }),
		null,
	);
	assert.equal(leadCreateSupervisorArgsBlockReason({ provider: "codex/gpt-5" }), null);
	assert.equal(leadCreateSupervisorArgsBlockReason(null), null);
});

test("under multi a Lead may not seat a Supervisor wider than itself", () => {
	const multi = { topology: "multi" as const, selfDomain: "backend" };
	const labels = (domain?: string) => ({
		purpose: "governance",
		"team.cluster": "shop",
		...(domain ? { "team.domain": domain } : {}),
	});

	assert.equal(
		leadCreateSupervisorArgsBlockReason({ ...SEAT_OK, labels: labels("backend") }, multi),
		null,
	);
	assert.equal(
		leadCreateSupervisorArgsBlockReason({ ...SEAT_OK, labels: labels("backend.auth") }, multi),
		null,
	);
	// Wider is authority this Lead does not have to give.
	assert.match(
		String(leadCreateSupervisorArgsBlockReason({ ...SEAT_OK, labels: labels("*") }, multi)),
		/never a wider one/,
	);
	// Unlabelled seat, and unlabelled Lead, are both fail-closed.
	assert.match(
		String(leadCreateSupervisorArgsBlockReason({ ...SEAT_OK, labels: labels() }, multi)),
		/team\.domain/,
	);
	assert.match(
		String(
			leadCreateSupervisorArgsBlockReason({ ...SEAT_OK, labels: labels("backend") }, {
				topology: "multi",
				selfDomain: null,
			}),
		),
		/JURISDICTION_UNVERIFIABLE/,
	);
	// Under `single` the domain question does not arise at all.
	assert.equal(leadCreateSupervisorArgsBlockReason({ ...SEAT_OK, labels: labels() }), null);
});

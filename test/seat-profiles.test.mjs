// seat-profiles.test.mjs — custom seats: the catalog, the generator, and the
// ownership rules that decide what `pteam seats apply` may overwrite.
// Run: node --test test/seat-profiles.test.mjs   (node >= 22)

import assert from "node:assert/strict";
import {
	SEAT_CAPABILITIES,
	SEAT_CAPABILITY_IDS,
	SEAT_ID_RE,
	applySeatsToPaseoConfig,
	baseRole,
	capabilitiesByBase,
	capabilitiesForBase,
	listSeats,
	materializeSeat,
	materializeSeats,
	resolveSeatGrants,
	seatCapability,
	seatEnv,
	seatLedgerPath,
	seatProviderName,
	seatsPath,
	validateSeats,
} from "../scripts/seat-profiles.mjs";
import { ROLE_PROVIDERS, TEAM_ROLES } from "../scripts/model-routing.mjs";
import { parseRoleProvider, leadCreateSupervisorArgsBlockReason } from "../extensions/paseo-team-core/policy-core.js";

// --- the catalog is the allowlist ------------------------------------------
// Every capability must name real roles and a real family, or the UI would
// offer a grant `seats apply` then refuses — a form that lies about what it
// can do is worse than one that offers less.
for (const capability of SEAT_CAPABILITIES) {
	assert.ok(SEAT_CAPABILITY_IDS.includes(capability.id));
	assert.ok(capability.roles.length > 0, `${capability.id} grants to no role`);
	for (const role of capability.roles) {
		assert.ok(TEAM_ROLES.includes(role), `${capability.id} names unknown role ${role}`);
	}
	assert.ok(
		capability.tools.length > 0 || Object.keys(capability.env).length > 0,
		`${capability.id} grants nothing at all`,
	);
}

// A capability is offered for exactly the base providers whose role AND family
// it declares: web tools only exist in the Claude runtime, so offering
// `web-research` on a pi seat would generate a provider whose capability can
// never fire.
assert.deepEqual(capabilitiesForBase("claude-peer"), ["web-research"]);
assert.deepEqual(capabilitiesForBase("pi-peer"), []);
assert.deepEqual(capabilitiesForBase("claude-lead"), ["web-research", "lead-write"]);
assert.deepEqual(capabilitiesForBase("pi-lead"), ["lead-write"]);
assert.deepEqual(capabilitiesForBase("claude-supervisor"), []);
assert.deepEqual(capabilitiesForBase("not-a-provider"), []);
assert.deepEqual(Object.keys(capabilitiesByBase()).sort(), [...ROLE_PROVIDERS].sort());
assert.equal(seatCapability("nope"), null);
assert.equal(baseRole("claude-peer"), "peer");
assert.equal(baseRole("claude-peer-researcher"), null, "only durable role providers are bases");

// --- validation is fail-closed ---------------------------------------------
{
	const ok = { version: 1, seats: { researcher: { base: "claude-peer", capabilities: ["web-research"] } } };
	assert.deepEqual(validateSeats(ok), []);
	assert.deepEqual(validateSeats({}), []);
	assert.deepEqual(validateSeats(null), []);
	assert.equal(validateSeats("nope").length, 1);

	const bad = {
		seats: {
			// a capability the base role may not take
			auditor: { base: "claude-supervisor", capabilities: ["web-research"] },
			// a capability nobody defined
			ghost: { base: "claude-peer", capabilities: ["telepathy"] },
			// a base that is not one of the six durable role providers
			odd: { base: "claude-peer-researcher", capabilities: [] },
			// an id that cannot round-trip through a provider name
			"Bad Name": { base: "claude-peer", capabilities: [] },
			// an id that collides with a base role
			peer: { base: "claude-peer", capabilities: [] },
		},
	};
	const errors = validateSeats(bad);
	assert.ok(errors.some((e) => e.includes('"auditor"') && e.includes("claude-supervisor")));
	assert.ok(errors.some((e) => e.includes("telepathy")));
	assert.ok(errors.some((e) => e.includes('"odd"') && e.includes("base")));
	assert.ok(errors.some((e) => e.includes("Bad Name")));
	assert.ok(errors.some((e) => e.includes('"peer"')));
}

// Every id the validator accepts must survive the round trip back out of a
// provider name, or the graph would show the seat as an unknown provider.
for (const id of ["researcher", "web-2", "a1"]) {
	assert.ok(SEAT_ID_RE.test(id));
	const name = seatProviderName("claude-peer", id);
	assert.deepEqual(parseRoleProvider(name), { family: "claude", role: "peer", seat: id });
}
for (const id of ["9lives", "-lead", "a", "UPPER", "with.dot", "with/slash"]) {
	assert.ok(!SEAT_ID_RE.test(id), `${id} must be refused`);
}

// --- materialization --------------------------------------------------------
{
	const seat = { id: "researcher", base: "claude-peer", label: "", capabilities: ["web-research"] };
	assert.deepEqual(resolveSeatGrants(seat), { tools: ["WebFetch", "WebSearch"], env: {} });
	assert.deepEqual(seatEnv(seat), {
		PASEO_PI_ROLE: "peer",
		PASEO_TEAM_EXTRA_TOOLS: "WebFetch,WebSearch",
	});

	// The deny list is computed by the caller UNDER that env, never subtracted
	// from a base list: `lead-write` grants through an env knob, so a generator
	// that only knew about `tools` would ship a seat whose capability is dead.
	const lead = { id: "writer", base: "claude-lead", label: "", capabilities: ["lead-write"] };
	assert.deepEqual(seatEnv(lead), { PASEO_PI_ROLE: "lead", PASEO_TEAM_LEAD_WRITE: "1" });
	const seen = [];
	materializeSeat(lead, (base, env) => {
		seen.push([base, env]);
		return [];
	});
	assert.deepEqual(seen, [["claude-lead", { PASEO_PI_ROLE: "lead", PASEO_TEAM_LEAD_WRITE: "1" }]]);

	const entry = materializeSeat(seat, () => ["Task", "Agent"]);
	assert.equal(entry.extends, "claude");
	assert.equal(entry.label, "claude-peer — researcher", "a blank label is generated, never empty");
	assert.deepEqual(entry.disallowedTools, ["Task", "Agent"]);

	// pi seats carry no deny list at all: pi denies by allowlist instead, and an
	// empty `disallowedTools` key would be a Claude-shaped field on a pi provider.
	const piEntry = materializeSeat({ id: "audit", base: "pi-lead", label: "", capabilities: ["lead-write"] }, () => []);
	assert.equal(piEntry.extends, "pi");
	assert.equal("disallowedTools" in piEntry, false);
}

// The seat document the WebUI writes is a map, and the map KEY is the id.
{
	const doc = {
		version: 1,
		seats: {
			researcher: { base: "claude-peer", label: "R", capabilities: ["web-research"] },
			audit: { base: "pi-lead", capabilities: ["lead-write"] },
		},
	};
	assert.deepEqual(
		listSeats(doc).map((s) => s.id),
		["researcher", "audit"],
	);
	assert.deepEqual(listSeats({ seats: [] }), [], "an array is not the map shape");
	const providers = materializeSeats(doc);
	assert.deepEqual(Object.keys(providers), ["claude-peer-researcher", "pi-lead-audit"]);
	assert.equal(providers["claude-peer-researcher"].env.PASEO_TEAM_EXTRA_TOOLS, "WebFetch,WebSearch");
}

// --- apply: what it may and may not overwrite ------------------------------
{
	const generated = {
		"claude-peer-researcher": { extends: "claude", label: "R" },
		"pi-lead-audit": { extends: "pi", label: "A" },
	};
	const config = {
		agents: {
			providers: {
				"claude-peer": { extends: "claude", label: "base, untouched" },
				// Same name as a generated seat, but this tool never created it.
				"claude-peer-researcher": { extends: "claude", label: "hand written" },
			},
		},
	};
	const first = applySeatsToPaseoConfig(config, generated, []);
	assert.deepEqual(first.created, ["pi-lead-audit"]);
	assert.deepEqual(first.skipped, ["claude-peer-researcher"]);
	assert.equal(
		first.config.agents.providers["claude-peer-researcher"].label,
		"hand written",
		"a provider this tool did not create is never overwritten",
	);
	assert.deepEqual(first.ledger, ["pi-lead-audit"], "a skipped name is not claimed as owned");
	assert.deepEqual(first.config.agents.providers["claude-peer"], { extends: "claude", label: "base, untouched" });

	// Deleting a seat removes the provider — but only the one the ledger claims.
	const second = applySeatsToPaseoConfig(first.config, {}, ["pi-lead-audit"]);
	assert.deepEqual(second.removed, ["pi-lead-audit"]);
	assert.ok("claude-peer-researcher" in second.config.agents.providers, "a name outside the ledger survives");
	assert.ok("claude-peer" in second.config.agents.providers);

	// Re-applying an unchanged seat set is not a change.
	const third = applySeatsToPaseoConfig(second.config, {}, []);
	assert.deepEqual([third.created, third.updated, third.removed], [[], [], []]);

	// An owned provider whose definition moved on is an update, not a create.
	const fourth = applySeatsToPaseoConfig(
		{ agents: { providers: { "pi-lead-audit": { extends: "pi", label: "old" } } } },
		{ "pi-lead-audit": { extends: "pi", label: "new" } },
		["pi-lead-audit"],
	);
	assert.deepEqual(fourth.updated, ["pi-lead-audit"]);
	assert.equal(fourth.config.agents.providers["pi-lead-audit"].label, "new");

	// A config with no agents section at all is a first install, not an error.
	const fresh = applySeatsToPaseoConfig(null, generated, []);
	assert.deepEqual(Object.keys(fresh.config.agents.providers).sort(), ["claude-peer-researcher", "pi-lead-audit"]);
}

// --- the reason the parser had to be relaxed --------------------------------
// A seat on the supervisor base carries full Supervisor authority. The gate
// that governs a Lead seating one asks parseRoleProvider what role a provider
// is, so a parser blind to seat names would return null and the gate would
// return "allowed" without ever running. This asserts the gate FIRES for a
// seat provider — the deny text differs by shape, what matters is that it is
// not silently null.
{
	const bare = leadCreateSupervisorArgsBlockReason({ provider: "claude-supervisor-audit" }, { topology: "single" });
	assert.ok(
		typeof bare === "string" && bare.length > 0,
		"a Lead creating a supervisor SEAT must hit the same gate as a bare supervisor provider",
	);
	assert.equal(
		bare,
		leadCreateSupervisorArgsBlockReason({ provider: "claude-supervisor" }, { topology: "single" }),
		"the seat and the base provider are governed identically",
	);
	// A peer seat is not a supervisor create_agent and must stay out of this gate.
	assert.equal(leadCreateSupervisorArgsBlockReason({ provider: "claude-peer-researcher" }, { topology: "single" }), null);
}

// --- both files live under the directory the caller names -------------------
// Resolving the pack config dir inside this module instead would let a
// sandboxed test run write into the developer's real home — the exact hazard
// PST_TEAM_CONFIG_DIR exists to remove.
{
	const dir = process.platform === "win32" ? "C:\tmp\team" : "/tmp/team";
	assert.ok(seatsPath(dir).startsWith(dir));
	assert.ok(seatLedgerPath(dir).startsWith(dir));
	assert.notEqual(seatsPath(dir), seatLedgerPath(dir));
}

console.log("seat-profiles tests passed");

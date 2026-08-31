import assert from "node:assert/strict";
import {
	clone,
	deepMerge,
	deletePath,
	getPath,
	dependentOptionProblems,
	dependentOptions,
	numberRangeProblems,
	parseLines,
	pruneEmpty,
	setPath,
} from "../webui/public/config-form.js";

// --- path get/set/delete ----------------------------------------------------

{
	const doc = {};
	setPath(doc, "retry.provider.timeoutMs", 600000);
	assert.deepEqual(doc, { retry: { provider: { timeoutMs: 600000 } } }, "setPath creates missing parents");

	assert.equal(getPath(doc, "retry.provider.timeoutMs"), 600000);
	assert.equal(getPath(doc, "retry.provider.maxRetries"), undefined);
	assert.equal(getPath(undefined, "a.b"), undefined, "a missing root reads as undefined");

	deletePath(doc, "retry.provider.timeoutMs");
	assert.deepEqual(doc, {}, "deleting the only leaf prunes the empty parents it leaves behind");

	const keep = { retry: { enabled: true, provider: { timeoutMs: 1 } } };
	deletePath(keep, "retry.provider.timeoutMs");
	assert.deepEqual(keep, { retry: { enabled: true } }, "a surviving sibling keeps the branch");

	const alien = { packages: ["npm:x"] };
	deletePath(alien, "retry.enabled");
	assert.deepEqual(alien, { packages: ["npm:x"] }, "deleting an absent path changes nothing");
}

// --- preset merge ------------------------------------------------------------

{
	const doc = { retry: { enabled: true, provider: { timeoutMs: 0 } } };
	deepMerge(doc, { retry: { maxRetries: 6, provider: { timeoutMs: 600000 } } });
	assert.deepEqual(doc, { retry: { enabled: true, maxRetries: 6, provider: { timeoutMs: 600000 } } });
}

// --- prune: emptiness is structural, never a value ---------------------------

{
	assert.equal(pruneEmpty({}), undefined);
	assert.equal(pruneEmpty({ a: [], b: {} }), undefined);
	assert.deepEqual(
		pruneEmpty({ a: {}, b: [], c: 0, d: false, e: "", f: { g: { h: 1 } } }),
		{ c: 0, d: false, e: "", f: { g: { h: 1 } } },
		"0, false and empty-string are values, not emptiness",
	);
}

// --- range validation reaches into map items ---------------------------------

{
	const schema = {
		groups: [
			{
				fields: [
					{ path: "retry.maxRetries", type: "number", label: "Số lần thử lại", min: 0, max: 20 },
					{
						path: "hosts",
						type: "map",
						item: { fields: [{ path: "limits.writers", type: "number", label: "Số agent ghi", min: 0, max: 16 }] },
					},
				],
			},
		],
	};
	assert.deepEqual(numberRangeProblems(schema, { retry: { maxRetries: 6 } }), []);
	assert.equal(numberRangeProblems(schema, { retry: { maxRetries: 99 } }).length, 1);
	assert.equal(
		numberRangeProblems(schema, { hosts: { "win-primary": { limits: { writers: 44 } } } }).length,
		1,
		"number fields inside map cards are checked too",
	);
}

// --- misc ---------------------------------------------------------------------

{
	assert.deepEqual(parseLines("a\n b\r\n\r\n  c \n"), ["a", "b", "c"]);
	assert.deepEqual(parseLines(""), []);
	assert.deepEqual(parseLines(null), []);

	assert.deepEqual(clone({ a: { b: 1 } }), { a: { b: 1 } });
	assert.notEqual(clone({ a: { b: 1 } }).a, { a: { b: 1 } }.a);
	assert.equal(clone(undefined), undefined);
}

// --- dependentOptions (what a dependent control may offer) ------------------

{
	const spec = { path: "paseoProvider", map: { "pi-peer": ["minimal", "low"], "claude-peer": ["low", "ultracode"] } };
	const doc = { routes: { A: { paseoProvider: "claude-peer" }, B: { paseoProvider: "pi-peer" }, C: {} } };

	assert.deepEqual(dependentOptions(spec, doc, "routes.A"), ["low", "ultracode"], "options follow the sibling's value");
	assert.deepEqual(dependentOptions(spec, doc, "routes.B"), ["minimal", "low"], "a sibling in another item resolves independently");
	assert.deepEqual(
		dependentOptions(spec, doc, "routes.C"),
		[],
		"no provider chosen yet: offer nothing rather than another family's levels",
	);
	assert.deepEqual(
		dependentOptions(spec, { routes: { A: { paseoProvider: "pi-lead" } } }, "routes.A"),
		[],
		"a sibling value the map has never heard of offers nothing, it does not fall back",
	);
	assert.deepEqual(dependentOptions(null, doc, "routes.A"), null, "a field with no dependency declares none");
	assert.deepEqual(
		dependentOptions({ path: "top", map: { x: ["a"] } }, { top: "x" }),
		["a"],
		"a top-level field resolves against the document root",
	);
}

// --- dependentOptionProblems (family-specific thinking levels) ---------------

{
	const schema = {
		groups: [
			{
				fields: [
					{
						path: "routes",
						type: "map",
						item: {
							fields: [
								{ path: "paseoProvider", type: "enum", enum: ["pi-peer", "claude-peer"] },
								{
									path: "model",
									type: "enum",
									label: "Mô hình",
									optionsBy: { path: "paseoProvider", source: "models", map: { "pi-peer": ["p/a"] } },
								},
								{
									path: "thinking",
									type: "enum",
									label: "Mức suy nghĩ",
									optionsBy: {
										path: "paseoProvider",
										map: { "pi-peer": ["low", "minimal"], "claude-peer": ["low", "ultracode"] },
									},
								},
							],
						},
					},
				],
			},
		],
	};

	const ok = { routes: { A: { paseoProvider: "claude-peer", model: "claude-opus-5", thinking: "ultracode" } } };
	assert.deepEqual(dependentOptionProblems(schema, ok), [], "a level its family really has passes");

	const stranded = { routes: { A: { paseoProvider: "claude-peer", model: "claude-opus-5", thinking: "minimal" } } };
	const problems = dependentOptionProblems(schema, stranded);
	assert.equal(problems.length, 1, "a pi-only level on a Claude route is reported");
	assert.match(problems[0], /routes\.A/, "the message names the route that is wrong");
	assert.match(problems[0], /minimal/);
	assert.match(problems[0], /claude-peer/);

	assert.deepEqual(
		dependentOptionProblems(schema, { routes: { A: { paseoProvider: "pi-peer", model: "brand-new-id" } } }),
		[],
		"a model outside the daemon's list is legitimate (new id, or a daemon that was down) and must not block a save",
	);

	assert.deepEqual(
		dependentOptionProblems(schema, { routes: { A: { thinking: "minimal" } } }),
		[],
		"no provider chosen yet: nothing to validate against, so nothing to report",
	);

	assert.deepEqual(dependentOptionProblems(undefined, {}), [], "a section without a schema reports nothing");
}

console.log("config-form tests passed");

import assert from "node:assert/strict";
import {
	clone,
	deepMerge,
	deletePath,
	getPath,
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

console.log("config-form tests passed");

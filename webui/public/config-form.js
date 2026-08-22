/**
 * config-form.js — pure helpers for the schema-driven config editor.
 *
 * No DOM here on purpose: every function is plain data-in/data-out so the
 * merge semantics (a save may never drop a key the form does not know about)
 * are testable from Node like any other contract.
 */

export function clone(value) {
	return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

export function getPath(root, path) {
	let node = root;
	for (const part of path.split(".")) {
		if (node === null || typeof node !== "object") return undefined;
		node = node[part];
	}
	return node;
}

export function setPath(root, path, value) {
	const parts = path.split(".");
	let node = root;
	for (const part of parts.slice(0, -1)) {
		if (typeof node[part] !== "object" || node[part] === null) node[part] = {};
		node = node[part];
	}
	node[parts[parts.length - 1]] = value;
}

/** Delete a leaf and any now-empty parents, so a reset field leaves no `"retry": {}` husk. */
export function deletePath(root, path) {
	if (typeof root !== "object" || root === null) return;
	deleteRec(root, path.split("."));

	function deleteRec(node, parts) {
		if (parts.length === 1) {
			delete node[parts[0]];
			return;
		}
		const child = node[parts[0]];
		if (typeof child !== "object" || child === null) return;
		deleteRec(child, parts.slice(1));
		if (Object.keys(child).length === 0) delete node[parts[0]];
	}
}

/** Deep-merge a preset patch onto the working document (arrays and scalars replace). */
export function deepMerge(target, patch) {
	for (const [key, value] of Object.entries(patch ?? {})) {
		if (value !== null && typeof value === "object" && !Array.isArray(value)) {
			if (typeof target[key] !== "object" || target[key] === null) target[key] = {};
			deepMerge(target[key], value);
		} else {
			target[key] = value;
		}
	}
	return target;
}

/**
 * Drop empty objects/arrays so a save writes the smallest document that still
 * means the same thing. False, 0 and "" are values, not emptiness.
 */
export function pruneEmpty(value) {
	if (Array.isArray(value)) return value.length > 0 ? value : undefined;
	if (value !== null && typeof value === "object") {
		const out = {};
		for (const [key, child] of Object.entries(value)) {
			const kept = pruneEmpty(child);
			if (kept !== undefined) out[key] = kept;
		}
		return Object.keys(out).length > 0 ? out : undefined;
	}
	return value;
}

/** One entry per number field outside its range, with the label to show the user. */
export function numberRangeProblems(schema, doc, prefix = "") {
	const problems = [];
	for (const group of schema?.groups ?? []) {
		for (const field of group.fields ?? []) collectField(field, prefix);
	}
	function collectField(field, base) {
		const path = base ? `${base}.${field.path}` : field.path;
		if (field.type === "number") {
			const value = getPath(doc, path);
			if (value !== undefined && value !== null && value !== "") {
				const numeric = Number(value);
				if (!Number.isFinite(numeric) || numeric < (field.min ?? -Infinity) || numeric > (field.max ?? Infinity)) {
					problems.push(`${field.label} phải là số từ ${field.min ?? "−∞"} đến ${field.max ?? "∞"}`);
				}
			}
		}
		if (field.type === "map" && field.item) {
			const object = getPath(doc, path);
			for (const key of Object.keys(object ?? {})) {
				for (const child of field.item.fields ?? []) collectField(child, `${path}.${key}`);
			}
		}
	}
	return problems;
}

/** Split a textarea into argv-style lines: trimmed, blanks dropped. */
export function parseLines(text) {
	return String(text ?? "")
		.split(/\r?\n/)
		.map((line) => line.trim())
		.filter((line) => line.length > 0);
}

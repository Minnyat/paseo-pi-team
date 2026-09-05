// patch-paseo-mcp.test.mjs — the MCP protocol-version patch for Paseo's
// bundled SDK.
//
// What matters here is not that a string gets replaced, but that the REWRITTEN
// CONDITION decides correctly: a client one revision ahead gets through, and
// nothing else does. So the tests evaluate the patched expression rather than
// asserting on its text.

import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
	PATCH_MARKER,
	PATCH_TARGETS,
	PatchError,
	patchSource,
	resolveSdkDir,
	revertSource,
	runPatch,
} from "../scripts/patch-paseo-mcp.mjs";

// The shipped SDK's real check, verbatim from
// @modelcontextprotocol/sdk 1.29.0 dist/esm/server/webStandardStreamableHttp.js.
const ORIGINAL = `    validateProtocolVersion(req) {
        const protocolVersion = req.headers.get('mcp-protocol-version');
        if (protocolVersion !== null && !SUPPORTED_PROTOCOL_VERSIONS.includes(protocolVersion)) {
            this.onerror?.(new Error(\`Bad Request: Unsupported protocol version: \${protocolVersion}\`));
            return this.createJsonErrorResponse(400);
        }
        return undefined;
    }
`;

const SUPPORTED = [
	"2025-11-25",
	"2025-06-18",
	"2025-03-26",
	"2024-11-05",
	"2024-10-07",
];

/**
 * Pull the patched condition back out of the rewritten source and run it, so
 * the test exercises the shipped logic instead of a paraphrase of it.
 */
function rejects(source, protocolVersion) {
	const line = source
		.split("\n")
		.find((l) => l.includes("SUPPORTED_PROTOCOL_VERSIONS.includes"));
	assert.ok(line, "patched source must still contain the guard");
	const expression = line.trim().replace(/^if \(/, "").replace(/\) \{$/, "");
	return Function(
		"protocolVersion",
		"SUPPORTED_PROTOCOL_VERSIONS",
		`return (${expression});`,
	)(protocolVersion, SUPPORTED);
}

// --- the transform ------------------------------------------------------------

const { source: patched, state } = patchSource(ORIGINAL);
assert.equal(state, "patched");
assert.ok(patched.includes(PATCH_MARKER), "the patch marks itself");
assert.notEqual(patched, ORIGINAL);

// Applying twice is a no-op, not a double rewrite.
const second = patchSource(patched);
assert.equal(second.state, "already");
assert.equal(second.source, patched);

// Reverting restores the file byte for byte.
const reverted = revertSource(patched);
assert.equal(reverted.state, "reverted");
assert.equal(reverted.source, ORIGINAL);
assert.equal(revertSource(ORIGINAL).state, "already");

// An SDK whose guard we do not recognise must fail loudly rather than be
// half-patched: the whole point of matching the condition literally.
assert.throws(
	() => patchSource("function validateProtocolVersion() { return undefined; }"),
	(err) => err instanceof PatchError && err.code === "PATTERN_NOT_FOUND",
);

// --- the decision the patched condition makes ---------------------------------

// The bug this exists for: Claude Code sends its own latest instead of the
// negotiated version, and every post-initialize request 400s.
assert.equal(rejects(ORIGINAL, "2026-07-28"), true, "unpatched: the live bug");
assert.equal(rejects(patched, "2026-07-28"), false, "patched: let it through");

// Everything the SDK already knew still passes, patched or not.
for (const version of SUPPORTED) {
	assert.equal(rejects(patched, version), false, version);
}
// No header at all is not an error — it means "pre-negotiation request".
assert.equal(rejects(patched, null), false);

// Newer is the ONLY thing the patch adds. These must all still be refused, or
// the patch has turned a validated header into an unvalidated one.
for (const bogus of [
	"2025-06-17", // dated, well-formed, older, and not a real revision
	"2024-01-01",
	"1999-12-31",
	"", // empty header
	"latest",
	"2026-7-28", // not zero-padded: not the wire format
	"2026-07-28-beta",
	"99999-07-28",
	"x2026-07-28",
]) {
	assert.equal(rejects(patched, bogus), true, `must still reject ${JSON.stringify(bogus)}`);
}

// --- file-level apply / verify / revert ---------------------------------------

const sdkDir = mkdtempSync(join(tmpdir(), "paseo-mcp-patch-"));
for (const relative of PATCH_TARGETS) {
	const path = join(sdkDir, relative);
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, ORIGINAL);
}

assert.equal(runPatch({ sdkDir, mode: "verify" }).patched, false);

const applied = runPatch({ sdkDir, mode: "apply" });
assert.equal(applied.patched, true);
assert.deepEqual(
	applied.files.map((f) => f.state),
	PATCH_TARGETS.map(() => "patched"),
);
assert.equal(runPatch({ sdkDir, mode: "verify" }).patched, true);

// A backup of the pristine file is kept beside each target...
for (const relative of PATCH_TARGETS) {
	const backup = join(sdkDir, `${relative}.paseo-team-backup`);
	assert.ok(existsSync(backup), `${relative} must be backed up`);
	assert.equal(readFileSync(backup, "utf8"), ORIGINAL);
}

// ...and re-applying must not overwrite it with the patched copy.
runPatch({ sdkDir, mode: "apply" });
for (const relative of PATCH_TARGETS) {
	assert.equal(
		readFileSync(join(sdkDir, `${relative}.paseo-team-backup`), "utf8"),
		ORIGINAL,
		"a second apply must leave the pristine backup alone",
	);
}

runPatch({ sdkDir, mode: "revert" });
for (const relative of PATCH_TARGETS) {
	assert.equal(readFileSync(join(sdkDir, relative), "utf8"), ORIGINAL);
}
assert.equal(runPatch({ sdkDir, mode: "verify" }).patched, false);

// A missing install is a named error, not a crash.
assert.throws(
	() => runPatch({ sdkDir: join(sdkDir, "nope"), mode: "verify" }),
	(err) => err instanceof PatchError && err.code === "SDK_NOT_FOUND",
);

// --- locating the SDK ---------------------------------------------------------

// An explicit dir wins over everything; the env var wins over `npm root -g`,
// so a test or a non-global install never has to shell out.
assert.equal(resolveSdkDir("D:/explicit", {}), "D:/explicit");
assert.equal(
	resolveSdkDir(null, { PASEO_TEAM_MCP_SDK_DIR: "D:/from-env" }),
	"D:/from-env",
);

console.log("patch-paseo-mcp tests passed");

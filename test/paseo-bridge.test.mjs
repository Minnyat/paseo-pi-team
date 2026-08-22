import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
	assertArgv,
	mapWithConcurrency,
	PaseoError,
	runPaseoJson,
	DEFAULT_COMMAND_TIMEOUT_MS,
} from "../cli/lib/paseo-bridge.mjs";

const FAKE = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "fake-paseo.mjs");
const previousExec = process.env.PASEO_TEAM_PASEO_EXEC;

// --- argv validation is fail-closed ---------------------------------------
assert.throws(() => assertArgv([]), (error) => error.code === "ARGV_INVALID");
assert.throws(() => assertArgv("ls"), (error) => error.code === "ARGV_INVALID");
// The bug this guards: an undefined option becoming the argv element
// "undefined" and being sent to the daemon as if it were a real value.
assert.throws(() => assertArgv(["inspect", undefined]), (error) => error.code === "ARGV_INVALID");
assert.throws(() => assertArgv(["inspect", ""]), (error) => error.code === "ARGV_INVALID");
assert.deepEqual(assertArgv(["ls", "-g"]), ["ls", "-g"]);

// --- --json is appended exactly once, argv travels verbatim ----------------
process.env.PASEO_TEAM_PASEO_EXEC = `node "${FAKE}"`;
{
	const echoed = await runPaseoJson(["ls", "-g"]);
	assert.deepEqual(echoed.argv, ["ls", "-g", "--json"], "bridge appends --json and preserves argv order");
}

// --- a failing paseo becomes a coded error, never a silent empty result ----
await assert.rejects(
	runPaseoJson(["ls", "--fail"]),
	(error) => error instanceof PaseoError && error.code === "CLI_ERROR",
);

// --- non-JSON stdout is its own code so the caller can tell it apart -------
process.env.PASEO_TEAM_PASEO_EXEC = `node -e "process.stdout.write('not json')"`;
await assert.rejects(
	runPaseoJson(["ls"]),
	(error) => error instanceof PaseoError && error.code === "INVALID_JSON",
);

// --- a malformed override is a config fault, not a transport fault ---------
process.env.PASEO_TEAM_PASEO_EXEC = '"unclosed';
await assert.rejects(
	runPaseoJson(["ls"]),
	(error) => error instanceof PaseoError && error.code === "PASEO_EXEC_INVALID",
);

if (previousExec === undefined) delete process.env.PASEO_TEAM_PASEO_EXEC;
else process.env.PASEO_TEAM_PASEO_EXEC = previousExec;

// --- bounded concurrency, and one failure does not sink the batch ----------
{
	let active = 0;
	let peak = 0;
	const results = await mapWithConcurrency([1, 2, 3, 4, 5, 6], 2, async (item) => {
		active += 1;
		peak = Math.max(peak, active);
		await new Promise((resolve) => setTimeout(resolve, 15));
		active -= 1;
		if (item === 3) throw new PaseoError("TIMEOUT", "boom");
		return item * 2;
	});
	assert.equal(peak, 2, "concurrency stays within the limit");
	assert.equal(results.length, 6);
	assert.deepEqual(results[0], { ok: true, value: 2 });
	assert.equal(results[2].ok, false, "a failed item is reported, not thrown");
	assert.equal(results[2].error.code, "TIMEOUT");
	assert.deepEqual(results[5], { ok: true, value: 12 });
}

// A cold paseo start alone costs ~3s on the reference machine; a timeout
// tighter than that would turn every snapshot into a false failure.
assert.ok(DEFAULT_COMMAND_TIMEOUT_MS >= 10_000, "command timeout leaves room for paseo cold start");

console.log("paseo-bridge tests passed");

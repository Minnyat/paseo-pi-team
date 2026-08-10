import assert from "node:assert/strict";
import { OCR_NPM_PACKAGE, OCR_SUPPORTED_VERSION, parseOcrVersion, ensureOcr } from "../scripts/ocr-setup.mjs";

assert.equal(OCR_NPM_PACKAGE, "@alibaba-group/open-code-review");
assert.equal(OCR_SUPPORTED_VERSION, "1.8.10");
assert.equal(parseOcrVersion("open-code-review v1.8.10"), "1.8.10");
assert.equal(parseOcrVersion("open-code-review v1.8.9"), "1.8.9");
assert.equal(parseOcrVersion("ocr unknown"), null);

{
  const calls = [];
  let installed = false;
  const result = ensureOcr({
    run: (command, args) => {
      calls.push([command, args]);
      if (command === "ocr") return installed
        ? { ok: true, stdout: "open-code-review v1.8.10\n", stderr: "", status: 0 }
        : { ok: false, stdout: "", stderr: "not found", status: 1 };
      if (command === "npm") { installed = true; return { ok: true, stdout: "installed", stderr: "", status: 0 }; }
      throw new Error(`unexpected command ${command}`);
    },
  });
  assert.equal(result.installed, true);
  assert.equal(result.version, "1.8.10");
  assert.deepEqual(calls, [
    ["ocr", ["version"]],
    ["npm", ["install", "-g", "@alibaba-group/open-code-review@1.8.10", "--no-audit", "--no-fund"]],
    ["ocr", ["version"]],
  ]);
}

{
  const result = ensureOcr({
    run: () => ({ ok: true, stdout: "open-code-review v1.8.10\n", stderr: "", status: 0 }),
  });
  assert.equal(result.installed, false);
  assert.equal(result.version, "1.8.10");
}

{
  const calls = [];
  let upgraded = false;
  const result = ensureOcr({
    run: (command, args) => {
      calls.push([command, args]);
      if (command === "ocr") return upgraded
        ? { ok: true, stdout: "open-code-review v1.8.10\n", stderr: "", status: 0 }
        : { ok: true, stdout: "open-code-review v1.8.9\n", stderr: "", status: 0 };
      upgraded = true;
      return { ok: true, stdout: "installed", stderr: "", status: 0 };
    },
  });
  assert.equal(result.installed, true);
  assert.equal(result.version, "1.8.10");
  assert.equal(calls[1][0], "npm");
}

assert.throws(
  () => ensureOcr({
    run: (command) => command === "ocr"
      ? { ok: false, stdout: "", stderr: "missing", status: 1 }
      : { ok: false, stdout: "", stderr: "npm failed", status: 1 },
  }),
  /OCR_INSTALL_FAILED/,
);

console.log("ocr setup tests passed");

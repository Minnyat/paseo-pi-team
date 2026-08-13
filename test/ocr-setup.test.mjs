import assert from "node:assert/strict";
import {
  OCR_NPM_PACKAGE,
  OCR_PINNED_VERSION,
  OCR_MINIMUM_VERSION,
  parseOcrVersion,
  compareOcrVersions,
  probeDelegateCapability,
  ensureOcr,
} from "../scripts/ocr-setup.mjs";

assert.equal(OCR_NPM_PACKAGE, "@alibaba-group/open-code-review");
assert.equal(OCR_MINIMUM_VERSION, "1.8.10");
assert.ok(compareOcrVersions(OCR_PINNED_VERSION, OCR_MINIMUM_VERSION) >= 0, "pin >= minimum");
assert.equal(parseOcrVersion("open-code-review v1.8.10"), "1.8.10");
assert.equal(parseOcrVersion("open-code-review v1.9.2 (5b37b5f8e) windows/amd64"), "1.9.2");
assert.equal(parseOcrVersion("ocr unknown"), null);

assert.equal(compareOcrVersions("1.8.10", "1.8.10"), 0);
assert.equal(compareOcrVersions("1.8.9", "1.8.10"), -1);
assert.equal(compareOcrVersions("1.9.2", "1.8.10"), 1);
assert.equal(compareOcrVersions("2.0.0", "1.99.99"), 1);

const capableRun = (versionLine) => (command, args) => {
  if (command === "ocr" && args[0] === "version") {
    return { ok: true, stdout: `${versionLine}\n`, stderr: "", status: 0 };
  }
  if (command === "ocr" && args[0] === "delegate") {
    return { ok: true, stdout: "--repo <path> --from <ref> --to <ref>", stderr: "", status: 0 };
  }
  throw new Error(`unexpected command ${command} ${args.join(" ")}`);
};

// probeDelegateCapability requires --repo/--from in BOTH delegate help outputs.
assert.deepEqual(probeDelegateCapability(capableRun("open-code-review v1.9.2")), { ok: true });
assert.deepEqual(
  probeDelegateCapability(() => ({ ok: true, stdout: "no flags here", stderr: "", status: 0 })),
  { ok: false, command: "preview" },
);

// A capable install at the tested baseline is accepted as-is (no npm call).
{
  const result = ensureOcr({ run: capableRun("open-code-review v1.8.10") });
  assert.equal(result.installed, false);
  assert.equal(result.version, "1.8.10");
}

// A NEWER capable install is accepted as-is — never downgraded to the pin.
{
  const calls = [];
  const inner = capableRun("open-code-review v1.9.2");
  const result = ensureOcr({
    run: (command, args) => {
      calls.push([command, args]);
      return inner(command, args);
    },
  });
  assert.equal(result.installed, false);
  assert.equal(result.version, "1.9.2");
  assert.ok(calls.every(([command]) => command !== "npm"), "no downgrade install");
}

// Missing OCR is repaired by installing the pinned version.
{
  const calls = [];
  let installed = false;
  const capable = capableRun(`open-code-review v${OCR_PINNED_VERSION}`);
  const result = ensureOcr({
    run: (command, args) => {
      calls.push([command, args]);
      if (command === "ocr" && !installed) {
        return { ok: false, stdout: "", stderr: "not found", status: 1 };
      }
      if (command === "npm") {
        installed = true;
        return { ok: true, stdout: "installed", stderr: "", status: 0 };
      }
      return capable(command, args);
    },
  });
  assert.equal(result.installed, true);
  assert.equal(result.version, OCR_PINNED_VERSION);
  assert.deepEqual(calls[1], ["npm", ["install", "-g", `${OCR_NPM_PACKAGE}@${OCR_PINNED_VERSION}`, "--no-audit", "--no-fund"]]);
}

// A version below the verified minimum is upgraded to the pin.
{
  let upgraded = false;
  const result = ensureOcr({
    run: (command, args) => {
      if (command === "npm") {
        upgraded = true;
        return { ok: true, stdout: "installed", stderr: "", status: 0 };
      }
      const version = upgraded ? OCR_PINNED_VERSION : "1.8.9";
      return capableRun(`open-code-review v${version}`)(command, args);
    },
  });
  assert.equal(result.installed, true);
  assert.equal(result.version, OCR_PINNED_VERSION);
}

// A newer version that FAILS the capability probe is repaired with the pin —
// downgrade for real incompatibility, never for a mere version difference.
{
  let repaired = false;
  const result = ensureOcr({
    run: (command, args) => {
      if (command === "npm") {
        repaired = true;
        return { ok: true, stdout: "installed", stderr: "", status: 0 };
      }
      if (args[0] === "version") {
        return { ok: true, stdout: repaired ? `open-code-review v${OCR_PINNED_VERSION}\n` : "open-code-review v9.9.9\n", stderr: "", status: 0 };
      }
      // delegate --help: broken before repair, capable after.
      return repaired
        ? { ok: true, stdout: "--repo <path> --from <ref>", stderr: "", status: 0 }
        : { ok: true, stdout: "flags renamed", stderr: "", status: 0 };
    },
  });
  assert.equal(result.installed, true);
  assert.equal(result.version, OCR_PINNED_VERSION);
}

// npm failure is fatal and explicit.
assert.throws(
  () => ensureOcr({
    run: (command) => command === "ocr"
      ? { ok: false, stdout: "", stderr: "missing", status: 1 }
      : { ok: false, stdout: "", stderr: "npm failed", status: 1 },
  }),
  /OCR_INSTALL_FAILED/,
);

// A repair install that still lacks the delegate capability fails closed.
assert.throws(
  () => ensureOcr({
    run: (command, args) => {
      if (command === "npm") return { ok: true, stdout: "installed", stderr: "", status: 0 };
      if (args[0] === "version") return { ok: true, stdout: `open-code-review v${OCR_PINNED_VERSION}\n`, stderr: "", status: 0 };
      return { ok: true, stdout: "no delegate flags", stderr: "", status: 0 };
    },
  }),
  /OCR_CAPABILITY_MISSING/,
);

console.log("ocr setup tests passed");

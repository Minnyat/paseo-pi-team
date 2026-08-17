// Tests for the helpers shared by the support scripts. These used to exist as
// six near-identical private copies; the behaviours pinned here are the ones
// that differed between those copies and are therefore easy to regress.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { pathToFileURL } from "node:url";

import {
  PASEO_CONVENTIONAL_ENTRIES,
  compareOcrVersions,
  findOnPath,
  isEntrypoint,
  parseOcrVersion,
  resolveCmdEntry,
  resolvePaseoExec,
  searchPathDirs,
  splitCommandLine,
} from "../scripts/lib-common.mjs";

const tmp = (prefix) => mkdtempSync(join(tmpdir(), prefix));
const isWindows = process.platform === "win32";

// --- splitCommandLine --------------------------------------------------------

// The regression this whole helper exists for: team-communication.mjs used
// `override.split(/\s+/)`, which shredded any quoted path containing spaces
// into separate argv elements and made the spawn fail with ENOENT.
assert.deepEqual(
  splitCommandLine('"C:\\Program Files\\paseo\\paseo.exe"').parts,
  ["C:\\Program Files\\paseo\\paseo.exe"],
  "a quoted path with spaces stays ONE argv element",
);
assert.deepEqual(
  splitCommandLine('node "C:\\Program Files\\p\\cli.js" --json').parts,
  ["node", "C:\\Program Files\\p\\cli.js", "--json"],
);
assert.deepEqual(splitCommandLine("'/usr/local/my paseo'").parts, [
  "/usr/local/my paseo",
]);
assert.deepEqual(splitCommandLine("  paseo   --json  ").parts, [
  "paseo",
  "--json",
]);
assert.deepEqual(splitCommandLine("").parts, []);

// Unterminated quotes are reported, never guessed at: the caller maps this
// onto its own error code instead of spawning something half-parsed.
assert.equal(splitCommandLine('"unclosed').unterminated, true);
assert.equal(splitCommandLine("'unclosed").unterminated, true);
assert.equal(splitCommandLine('"closed"').unterminated, false);

// Non-strings throw instead of coercing: String(undefined) would have produced
// the argv element "undefined" and spawned a nonsense binary.
assert.throws(() => splitCommandLine(undefined), TypeError);
assert.throws(() => splitCommandLine(["paseo"]), TypeError);

// --- searchPathDirs / findOnPath ---------------------------------------------

{
  const dirs = searchPathDirs({ PATH: ["a", "", "b"].join(delimiter) });
  assert.deepEqual(dirs, ["a", "b"], "empty PATH entries are dropped");
}

{
  // %APPDATA%\npm holds npm-installed shims and is often missing from a child
  // process's PATH; on Windows it must be searched, elsewhere ignored.
  const dirs = searchPathDirs({ PATH: "a", APPDATA: join("C:", "Users", "x", "AppData") });
  if (isWindows) {
    assert.deepEqual(dirs, ["a", join("C:", "Users", "x", "AppData", "npm")]);
  } else {
    assert.deepEqual(dirs, ["a"]);
  }
}

{
  // Directory-major scan: PATH order decides the winner, not the order of the
  // names. `second.exe` sits earlier on PATH than `first.exe`, so it wins even
  // though "first.exe" is listed first.
  const dirA = tmp("libcommon-path-a-");
  const dirB = tmp("libcommon-path-b-");
  writeFileSync(join(dirA, "second.exe"), "");
  writeFileSync(join(dirB, "first.exe"), "");
  const env = { PATH: [dirA, dirB].join(delimiter) };
  assert.equal(
    findOnPath(["first.exe", "second.exe"], env),
    join(dirA, "second.exe"),
    "earlier PATH dir wins over earlier name",
  );
  assert.equal(findOnPath("first.exe", env), join(dirB, "first.exe"), "accepts a bare string");
  assert.equal(findOnPath(["absent.exe"], env), undefined);
  assert.equal(findOnPath(["absent.exe"], { PATH: "" }), undefined, "empty PATH is not a crash");
}

// --- resolveCmdEntry ---------------------------------------------------------

{
  const shimDir = tmp("libcommon-shim-");
  const entryDir = join(shimDir, "node_modules", "@getpaseo", "cli", "dist");
  mkdirSync(entryDir, { recursive: true });
  const entry = join(entryDir, "index.js");
  writeFileSync(entry, "");

  // npm has emitted both %~dp0 and the older %dp0% form.
  for (const token of ["%~dp0", "%dp0%"]) {
    const shim = join(shimDir, `paseo-${token.replace(/[%~]/g, "")}.cmd`);
    writeFileSync(
      shim,
      `@IF EXIST "${token}\\node_modules\\@getpaseo\\cli\\dist\\index.js" (\n  "${token}\\node_modules\\@getpaseo\\cli\\dist\\index.js" %*\n)\n`,
    );
    assert.equal(resolveCmdEntry(shim), entry, `shim with ${token} resolves`);
  }

  // Unparseable shim → conventional layout beside it.
  const opaque = join(shimDir, "opaque.cmd");
  writeFileSync(opaque, "@echo off\r\nrem nothing quotable here\r\n");
  assert.equal(resolveCmdEntry(opaque), undefined, "no candidates → undefined");
  assert.equal(
    resolveCmdEntry(opaque, PASEO_CONVENTIONAL_ENTRIES),
    entry,
    "falls back to the conventional dist/index.js layout",
  );

  // A shim that points at a file which does not exist must not be trusted.
  const dangling = join(shimDir, "dangling.cmd");
  writeFileSync(dangling, `"%~dp0\\node_modules\\@getpaseo\\cli\\dist\\gone.js" %*\n`);
  assert.equal(resolveCmdEntry(dangling), undefined, "parsed entry must exist on disk");

  assert.equal(resolveCmdEntry(join(shimDir, "no-such-file.cmd")), undefined, "unreadable shim");
}

{
  // Second conventional layout: bin/paseo, shipped by other @getpaseo/cli
  // versions. Without it, team-communication's old resolution would regress.
  const shimDir = tmp("libcommon-shim-bin-");
  const binDir = join(shimDir, "node_modules", "@getpaseo", "cli", "bin");
  mkdirSync(binDir, { recursive: true });
  const entry = join(binDir, "paseo");
  writeFileSync(entry, "");
  const opaque = join(shimDir, "opaque.cmd");
  writeFileSync(opaque, "@echo off\r\n");
  assert.equal(resolveCmdEntry(opaque, PASEO_CONVENTIONAL_ENTRIES), entry);
}

// --- resolvePaseoExec --------------------------------------------------------

{
  const previous = process.env.PASEO_TEAM_PASEO_EXEC;
  const restore = () => {
    if (previous === undefined) delete process.env.PASEO_TEAM_PASEO_EXEC;
    else process.env.PASEO_TEAM_PASEO_EXEC = previous;
  };

  process.env.PASEO_TEAM_PASEO_EXEC = '"C:\\Program Files\\paseo\\paseo.exe" --json';
  assert.deepEqual(
    resolvePaseoExec(),
    ["C:\\Program Files\\paseo\\paseo.exe", "--json"],
    "override keeps a spaced path intact",
  );

  // A malformed override is a hard error, never a silent fall-through to a
  // bare "paseo" that would run a different binary than the operator asked for.
  const seen = [];
  const onInvalid = (reason) => {
    seen.push(reason);
    throw new Error(`mapped: ${reason}`);
  };
  process.env.PASEO_TEAM_PASEO_EXEC = '""';
  assert.throws(() => resolvePaseoExec(onInvalid), /mapped: is set but empty/);
  process.env.PASEO_TEAM_PASEO_EXEC = '"unclosed';
  assert.throws(() => resolvePaseoExec(onInvalid), /mapped: has an unterminated quote/);
  assert.deepEqual(seen, ["is set but empty", "has an unterminated quote"]);

  // Without a mapper it still throws rather than returning something usable.
  assert.throws(() => resolvePaseoExec(), /PASEO_TEAM_PASEO_EXEC/);

  delete process.env.PASEO_TEAM_PASEO_EXEC;
  const resolved = resolvePaseoExec();
  assert.ok(Array.isArray(resolved) && resolved.length >= 1);
  if (!isWindows) {
    assert.deepEqual(resolved, ["paseo"], "non-Windows resolution is the bare name");
  }
  restore();
}

// --- isEntrypoint ------------------------------------------------------------

{
  const dir = tmp("libcommon-entry-");
  const target = join(dir, "module.mjs");
  writeFileSync(target, "export {};\n");
  const url = pathToFileURL(target).href;

  assert.equal(isEntrypoint(url, target), true);
  assert.equal(isEntrypoint(url, undefined), false, "no argv[1] → not an entrypoint");
  assert.equal(isEntrypoint(url, join(dir, "other.mjs")), false, "missing path → false, not a throw");

  // macOS temp dirs are reachable via both /var and /private/var, and installed
  // scripts are commonly symlinked: comparison must be on canonical paths.
  const link = join(dir, "link.mjs");
  try {
    symlinkSync(target, link, "file");
    assert.equal(isEntrypoint(url, link), true, "symlink alias resolves to the same module");
  } catch (error) {
    if (!isWindows) throw error; // Windows without developer mode cannot symlink
  }
}

// --- OCR version helpers -----------------------------------------------------

assert.equal(parseOcrVersion("open-code-review v1.8.10"), "1.8.10");
assert.equal(parseOcrVersion("open-code-review v1.9.2 (5b37b5f8e) windows/amd64"), "1.9.2");
assert.equal(parseOcrVersion("ocr unknown"), null);
assert.equal(parseOcrVersion(undefined), null, "non-string input is not a throw");

assert.equal(compareOcrVersions("1.8.10", "1.8.10"), 0);
assert.equal(compareOcrVersions("1.8.9", "1.8.10"), -1, "numeric compare, not lexicographic");
assert.equal(compareOcrVersions("1.10.0", "1.9.9"), 1);
assert.equal(compareOcrVersions("2", "1.9.9"), 1, "missing segments count as 0");

console.log("lib-common tests passed");

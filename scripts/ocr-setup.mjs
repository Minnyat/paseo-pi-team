#!/usr/bin/env node
// Install and verify the OpenCodeReview CLI used by ocr-review.mjs.
// The installer owns this dependency; failures are fatal and never reported
// as a successful role-pack installation.
//
// Compatibility is capability-based, not version-equality-based: any installed
// OCR at or above the verified minimum that passes the delegation capability
// probe is accepted as-is. The pinned version is only what gets installed when
// OCR is absent, too old, or fails the probe — a newer working release is
// never downgraded just because its version differs.

import { spawnSync } from "node:child_process";
import {
  compareOcrVersions,
  isEntrypoint,
  parseOcrVersion,
} from "./lib-common.mjs";

// Re-exported so the installer and the review wrapper agree on one parser:
// ocr-review.mjs used to carry a private copy of parseOcrVersion.
export { compareOcrVersions, parseOcrVersion };

export const OCR_NPM_PACKAGE = "@alibaba-group/open-code-review";
// Installed when OCR is absent, older than the minimum, or capability-broken.
export const OCR_PINNED_VERSION = "1.9.2";
// Oldest release whose delegation contract was verified end-to-end (1.8.10).
export const OCR_MINIMUM_VERSION = "1.8.10";

/**
 * Probe the delegation surface ocr-review.mjs depends on: `ocr delegate
 * preview|rule` must exist and accept `--repo`/`--from`. This — not the
 * version string — decides whether an installed OCR is usable.
 */
export function probeDelegateCapability(run) {
  for (const command of ["preview", "rule"]) {
    const help = run("ocr", ["delegate", command, "--help"]);
    if (!help.ok || !help.stdout.includes("--repo") || !help.stdout.includes("--from")) {
      return { ok: false, command };
    }
  }
  return { ok: true };
}

function defaultRun(command, args) {
  const isWindows = process.platform === "win32";
  const executable = isWindows ? process.env.ComSpec || "cmd.exe" : command;
  const commandArgs = isWindows
    ? ["/d", "/s", "/c", command, ...args]
    : args;
  const result = spawnSync(executable, commandArgs, {
    encoding: "utf8",
    timeout: 300000,
    stdio: ["ignore", "pipe", "pipe"],
    shell: false,
    env: process.env,
    windowsHide: true,
  });
  return {
    ok: result.status === 0,
    stdout: String(result.stdout ?? ""),
    stderr: String(result.stderr ?? ""),
    status: result.status,
    error: result.error ? String(result.error.message ?? result.error) : "",
  };
}

export function ensureOcr({ run = defaultRun } = {}) {
  let versionResult = run("ocr", ["version"]);
  let version = versionResult.ok ? parseOcrVersion(versionResult.stdout) : null;

  if (
    version &&
    compareOcrVersions(version, OCR_MINIMUM_VERSION) >= 0 &&
    probeDelegateCapability(run).ok
  ) {
    return { installed: false, version, output: versionResult.stdout };
  }
  // OCR is absent, below the verified minimum, or capability-broken: repair by
  // installing the pinned package; the post-install probe below remains the
  // authority.
  const installResult = run("npm", [
    "install",
    "-g",
    `${OCR_NPM_PACKAGE}@${OCR_PINNED_VERSION}`,
    "--no-audit",
    "--no-fund",
  ]);
  if (!installResult.ok) {
    const error = new Error(`OCR_INSTALL_FAILED: ${installResult.stderr || installResult.error || installResult.stdout || "npm install failed"}`);
    error.code = "OCR_INSTALL_FAILED";
    throw error;
  }

  versionResult = run("ocr", ["version"]);
  version = versionResult.ok ? parseOcrVersion(versionResult.stdout) : null;
  if (!version || compareOcrVersions(version, OCR_MINIMUM_VERSION) < 0) {
    const error = new Error(`OCR_VERSION_UNSUPPORTED: installed OCR did not report a version >= ${OCR_MINIMUM_VERSION}`);
    error.code = "OCR_VERSION_UNSUPPORTED";
    throw error;
  }
  const capability = probeDelegateCapability(run);
  if (!capability.ok) {
    const error = new Error(`OCR_CAPABILITY_MISSING: installed OCR does not expose \`ocr delegate ${capability.command}\` with --repo/--from`);
    error.code = "OCR_CAPABILITY_MISSING";
    throw error;
  }
  return { installed: true, version, output: versionResult.stdout };
}

/** Compare canonical filesystem paths so macOS /var aliases work. */
export function isMainModule(entry = process.argv[1], moduleUrl = import.meta.url) {
  return isEntrypoint(moduleUrl, entry);
}

if (isMainModule()) {
  try {
    const result = ensureOcr();
    console.log(`[paseo-team] OCR ${result.installed ? "installed" : "already ready"}: open-code-review v${result.version}`);
  } catch (error) {
    console.error(`[paseo-team] OCR setup failed: ${String(error?.message ?? error)}`);
    process.exitCode = 1;
  }
}

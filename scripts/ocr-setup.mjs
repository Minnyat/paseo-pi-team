#!/usr/bin/env node
// Install and verify the pinned OpenCodeReview CLI used by ocr-review.mjs.
// The installer owns this dependency; failures are fatal and never reported
// as a successful role-pack installation.

import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

export const OCR_NPM_PACKAGE = "@alibaba-group/open-code-review";
export const OCR_SUPPORTED_VERSION = "1.8.10";

export function parseOcrVersion(output) {
  const match = String(output).match(/open-code-review v(\d+\.\d+\.\d+)/i);
  return match?.[1] ?? null;
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
  const expected = OCR_SUPPORTED_VERSION;
  let versionResult = run("ocr", ["version"]);
  let version = versionResult.ok ? parseOcrVersion(versionResult.stdout) : null;

  if (version === expected) {
    return { installed: false, version, output: versionResult.stdout };
  }
  // A different installed version is repaired by installing the pinned
  // package; the post-install probe below remains the authority.
  const installResult = run("npm", [
    "install",
    "-g",
    `${OCR_NPM_PACKAGE}@${expected}`,
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
  if (version !== expected) {
    const error = new Error(`OCR_VERSION_UNSUPPORTED: installed OCR did not report ${expected}`);
    error.code = "OCR_VERSION_UNSUPPORTED";
    throw error;
  }
  return { installed: true, version, output: versionResult.stdout };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const result = ensureOcr();
    console.log(`[paseo-team] OCR ${result.installed ? "installed" : "already ready"}: open-code-review v${result.version}`);
  } catch (error) {
    console.error(`[paseo-team] OCR setup failed: ${String(error?.message ?? error)}`);
    process.exitCode = 1;
  }
}

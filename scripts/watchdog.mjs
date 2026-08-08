#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { retryWithBackoff } from "./reliability.mjs";

export const DEFAULT_STALE_AFTER_MS = 5 * 60_000;

export function classifyStaleAgents(agents, options = {}) {
  const now = options.now ?? Date.now();
  const staleAfterMs = Math.max(1000, options.staleAfterMs ?? DEFAULT_STALE_AFTER_MS);
  return agents
    .filter((agent) => agent?.status === "running")
    .map((agent) => {
      const updatedAtMs = Date.parse(agent.updatedAt ?? "");
      const ageMs = Number.isFinite(updatedAtMs) ? Math.max(0, now - updatedAtMs) : null;
      return {
        ...agent,
        ageMs,
        stale: ageMs !== null && ageMs >= staleAfterMs,
        confidence: ageMs === null ? "unknown" : "suspected",
      };
    });
}

function paseoExec() {
  const override = process.env.PASEO_TEAM_PASEO_EXEC?.trim();
  if (override) return override.split(/\s+/);
  if (process.platform !== "win32") return ["paseo"];
  const pathValue = process.env.PATH ?? "";
  const pathDirs = pathValue.includes(";") ? pathValue.split(";") : pathValue.split(":");
  const npmDir = process.env.APPDATA ? join(process.env.APPDATA, "npm") : null;
  if (npmDir) pathDirs.push(npmDir);
  for (const dir of pathDirs) {
    for (const name of ["paseo.exe", "paseo.cmd", "paseo.bat"]) {
      const candidate = join(dir, name);
      if (!existsSync(candidate)) continue;
      if (name === "paseo.exe") return [candidate];
      const shim = readFileSync(candidate, "utf8");
      const entry = join(dirname(candidate), "node_modules", "@getpaseo", "cli", "bin", "paseo");
      if (existsSync(entry)) return [process.execPath, entry];
    }
  }
  return ["paseo"];
}

function paseoJson(args, timeout = 30_000) {
  const [bin, ...prefix] = paseoExec();
  const stdout = execFileSync(bin, [...prefix, ...args, "--json"], {
    encoding: "utf8",
    timeout,
    stdio: ["ignore", "pipe", "pipe"],
    env: process.env,
    windowsHide: true,
  });
  try {
    return JSON.parse(stdout);
  } catch (error) {
    throw new Error(`paseo returned invalid JSON: ${String(error?.message ?? error)}`);
  }
}

export async function collectWatchdogSnapshot(options = {}) {
  const listed = await retryWithBackoff(
    () => paseoJson(["ls", "-g"], options.commandTimeoutMs ?? 30_000),
    { maxAttempts: options.maxAttempts ?? 3, baseMs: options.baseMs ?? 250 },
  );
  const agents = Array.isArray(listed) ? listed : [];
  const running = agents.filter((agent) => agent?.status === "running");
  const inspected = [];
  for (const agent of running.slice(0, options.maxAgents ?? 100)) {
    try {
      const detail = await retryWithBackoff(
        () => paseoJson(["inspect", agent.id], options.commandTimeoutMs ?? 30_000),
        { maxAttempts: options.maxAttempts ?? 3, baseMs: options.baseMs ?? 250 },
      );
      inspected.push({
        ...agent,
        status: String(detail.Status ?? detail.status ?? agent.status).toLowerCase(),
        updatedAt: detail.UpdatedAt ?? detail.updatedAt ?? agent.updatedAt,
        parentAgentId: detail.ParentAgentId ?? detail.parentAgentId ?? null,
        pendingPermissions: detail.PendingPermissions ?? detail.pendingPermissions ?? [],
      });
    } catch (error) {
      inspected.push({
        ...agent,
        inspectError: String(error?.message ?? error),
        confidence: "unknown",
      });
    }
  }
  const classified = classifyStaleAgents(inspected, options);
  return {
    generatedAt: new Date(options.now ?? Date.now()).toISOString(),
    staleAfterMs: Math.max(1000, options.staleAfterMs ?? DEFAULT_STALE_AFTER_MS),
    agents: classified,
    stale: classified.filter((agent) => agent.stale),
    action: "observation-only: do not cancel/archive/spawn until status, activity and workspace state are reconciled",
  };
}

async function main() {
  let options = {};
  try {
    options = process.argv[2] ? JSON.parse(process.argv[2]) : {};
  } catch (error) {
    throw new Error(`invalid watchdog options JSON: ${String(error?.message ?? error)}`);
  }
  const result = await collectWatchdogSnapshot(options);
  console.log(JSON.stringify(result, null, 2));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(JSON.stringify({ ok: false, code: "WATCHDOG_FAILED", message: String(error?.message ?? error) }));
    process.exit(2);
  });
}

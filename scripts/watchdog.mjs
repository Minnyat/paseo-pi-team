#!/usr/bin/env node
import { execFile } from "node:child_process";
import { isEntrypoint, resolvePaseoExec } from "./lib-common.mjs";
import { retryWithBackoff } from "./reliability.mjs";

export const DEFAULT_STALE_AFTER_MS = 5 * 60_000;
export const DEFAULT_GLOBAL_DEADLINE_MS = 30_000;
export const DEFAULT_INSPECT_CONCURRENCY = 6;

export function classifyStaleAgents(agents, options = {}) {
  const now = options.now ?? Date.now();
  const staleAfterMs = Math.max(1000, options.staleAfterMs ?? DEFAULT_STALE_AFTER_MS);
  return agents
    .filter((agent) => agent?.status === "running")
    .map((agent) => {
      const inspected = agent.inspectOk === true;
      const updatedAtMs = inspected ? Date.parse(agent.updatedAt ?? "") : NaN;
      const ageMs = Number.isFinite(updatedAtMs) ? Math.max(0, now - updatedAtMs) : null;
      return {
        ...agent,
        ageMs,
        stale: inspected && ageMs !== null && ageMs >= staleAfterMs,
        confidence: inspected && ageMs !== null ? "suspected" : "unknown",
      };
    });
}

function paseoExec() {
  return resolvePaseoExec((reason) => {
    throw Object.assign(new Error(`PASEO_TEAM_PASEO_EXEC ${reason}`), {
      code: "PASEO_EXEC_INVALID",
    });
  });
}

function deadlineBound(promise, deadline) {
  const remaining = Math.max(1, deadline - Date.now());
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(Object.assign(new Error("watchdog global deadline exceeded"), { code: "TIMEOUT" }));
    }, remaining);
    promise.then(
      (value) => { clearTimeout(timer); resolve(value); },
      (error) => { clearTimeout(timer); reject(error); },
    );
  });
}

function runPaseoJson(args, timeoutMs, signal) {
  const [bin, ...prefix] = paseoExec();
  return new Promise((resolve, reject) => {
    execFile(
      bin,
      [...prefix, ...args, "--json"],
      { encoding: "utf8", timeout: timeoutMs, signal, stdio: ["ignore", "pipe", "pipe"], env: process.env, windowsHide: true },
      (error, stdout, stderr) => {
        if (error) {
          const text = `${String(stderr ?? "").trim()} ${String(stdout ?? "").trim()} ${error.message}`.trim();
          reject(Object.assign(new Error(text), { code: error.code ?? "CLI_ERROR" }));
          return;
        }
        try {
          resolve(JSON.parse(stdout));
        } catch (parseError) {
          reject(new Error(`paseo returned invalid JSON: ${String(parseError?.message ?? parseError)}`));
        }
      },
    );
  });
}

async function inspectOne(agent, deadline, options) {
  const paseoJson = options.runPaseoJson ?? runPaseoJson;
  try {
    const detail = await deadlineBound(retryWithBackoff(
      () => paseoJson(["inspect", agent.id], Math.max(1, Math.min(options.commandTimeoutMs, deadline - Date.now())), options.signal),
      { maxAttempts: options.maxAttempts, baseMs: options.baseMs, jitter: 0, deadlineMs: deadline },
    ), deadline);
    return {
      ...agent,
      inspectOk: true,
      status: String(detail.Status ?? detail.status ?? agent.status).toLowerCase(),
      updatedAt: detail.UpdatedAt ?? detail.updatedAt ?? agent.updatedAt,
      parentAgentId: detail.ParentAgentId ?? detail.parentAgentId ?? null,
      pendingPermissions: detail.PendingPermissions ?? detail.pendingPermissions ?? [],
    };
  } catch (error) {
    return {
      ...agent,
      inspectOk: false,
      stale: false,
      confidence: "unknown",
      inspectError: String(error?.message ?? error),
    };
  }
}

export async function collectWatchdogSnapshot(options = {}) {
  const globalDeadlineMs = Math.max(1000, options.globalDeadlineMs ?? DEFAULT_GLOBAL_DEADLINE_MS);
  const deadline = Date.now() + globalDeadlineMs;
  const commandTimeoutMs = Math.max(250, options.commandTimeoutMs ?? 5000);
  const maxAttempts = Math.max(1, Math.floor(options.maxAttempts ?? 3));
  const concurrency = Math.max(1, Math.min(16, Math.floor(options.concurrency ?? DEFAULT_INSPECT_CONCURRENCY)));
  const controller = new AbortController();
  const paseoJson = options.runPaseoJson ?? runPaseoJson;
  const timer = setTimeout(() => controller.abort(), globalDeadlineMs);
  let listed;
  try {
    listed = await deadlineBound(retryWithBackoff(
      () => paseoJson(["ls", "-g"], Math.max(1, Math.min(commandTimeoutMs, deadline - Date.now())), controller.signal),
      { maxAttempts, baseMs: options.baseMs ?? 100, jitter: 0, deadlineMs: deadline },
    ), deadline);
  } catch (error) {
    clearTimeout(timer);
    return {
      generatedAt: new Date(options.now ?? Date.now()).toISOString(),
      staleAfterMs: Math.max(1000, options.staleAfterMs ?? DEFAULT_STALE_AFTER_MS),
      agents: [], stale: [], partial: true,
      error: String(error?.message ?? error),
      action: "observation-only: list failed; do not cancel/archive/spawn",
    };
  }

  const agents = Array.isArray(listed) ? listed : [];
  const allRunning = agents.filter((agent) => agent?.status === "running");
  const maxAgents = Math.max(1, Math.floor(options.maxAgents ?? 100));
  const running = allRunning.slice(0, maxAgents);
  const inspected = new Array(running.length);
  let cursor = 0;
  async function worker() {
    while (cursor < running.length && Date.now() < deadline) {
      const index = cursor++;
      inspected[index] = await inspectOne(running[index], deadline, {
        ...options, commandTimeoutMs, maxAttempts, signal: controller.signal,
      });
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, running.length) }, () => worker()));
  clearTimeout(timer);
  const complete = inspected.map((agent, index) => agent ?? {
    ...running[index],
    inspectOk: false,
    stale: false,
    confidence: "unknown",
    inspectError: "watchdog global deadline exceeded before inspect completed",
  });
  const classified = classifyStaleAgents(complete, options);
  const partial = allRunning.length > running.length || complete.some((agent) => agent.inspectOk !== true);
  return {
    generatedAt: new Date(options.now ?? Date.now()).toISOString(),
    staleAfterMs: Math.max(1000, options.staleAfterMs ?? DEFAULT_STALE_AFTER_MS),
    agents: classified,
    stale: classified.filter((agent) => agent.stale),
    partial,
    action: "observation-only: do not cancel/archive/spawn until status, activity and workspace state are reconciled",
  };
}

async function main() {
  let options = {};
  try { options = process.argv[2] ? JSON.parse(process.argv[2]) : {}; }
  catch (error) { throw new Error(`invalid watchdog options JSON: ${String(error?.message ?? error)}`); }
  console.log(JSON.stringify(await collectWatchdogSnapshot(options), null, 2));
}

export function isMainModule(entry = process.argv[1], moduleUrl = import.meta.url) {
  return isEntrypoint(moduleUrl, entry);
}

if (isMainModule()) {
  main().catch((error) => {
    console.error(JSON.stringify({ ok: false, code: "WATCHDOG_FAILED", message: String(error?.message ?? error) }));
    process.exit(2);
  });
}

#!/usr/bin/env node
// Reliable, parent-scoped Peer -> Lead communication.
import { execFileSync } from "node:child_process";
import { isEntrypoint, resolvePaseoExec } from "./lib-common.mjs";
import { retryWithBackoff } from "./reliability.mjs";

export const MESSAGE_KINDS = Object.freeze(["question", "blocked", "dependency", "progress"]);
const METADATA_TOKEN = /^[A-Za-z0-9._:-]{1,256}$/;

function metadataToken(name, value) {
  if (typeof value !== "string" || !METADATA_TOKEN.test(value)) {
    throw new Error(`${name} must be a single-line token matching [A-Za-z0-9._:-] (max 256 characters)`);
  }
  return value;
}

export function validatePeerMessage(input) {
  if (!input || typeof input !== "object") throw new Error("message must be an object");
  const { kind, message, taskId, correlationId } = input;
  if (!MESSAGE_KINDS.includes(kind)) throw new Error(`kind must be one of: ${MESSAGE_KINDS.join(", ")}`);
  if (typeof message !== "string" || message.trim().length === 0) throw new Error("message must be non-empty");
  if (message.length > 12_000) throw new Error("message exceeds 12000 characters");
  return {
    kind,
    message: message.trim(),
    taskId: taskId === undefined ? "unknown" : metadataToken("taskId", taskId),
    correlationId: correlationId === undefined
      ? `peer-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
      : metadataToken("correlationId", correlationId),
  };
}

export function runPaseo(args, timeoutMs = 20_000) {
  // A malformed PASEO_TEAM_PASEO_EXEC is a configuration fault, not a transport
  // fault: give it its own code so reliability.mjs never retries it and the
  // operator sees the real cause instead of a generic send failure.
  const [bin, ...prefix] = resolvePaseoExec((reason) => {
    throw Object.assign(new Error(`PASEO_TEAM_PASEO_EXEC ${reason}`), {
      code: "PASEO_EXEC_INVALID",
    });
  });
  try {
    return { ok: true, data: JSON.parse(execFileSync(bin, [...prefix, ...args, "--json"], {
      encoding: "utf8", timeout: timeoutMs, stdio: ["ignore", "pipe", "pipe"], env: process.env, windowsHide: true,
    })) };
  } catch (error) {
    const text = `${error?.stderr ?? ""}\n${error?.stdout ?? ""}\n${error?.message ?? error}`;
    const wrapped = Object.assign(new Error(text.split("\n")[0]), { code: "CLI_ERROR" });
    throw wrapped;
  }
}

export function parentAgentIdFromInspect(snapshot) {
  const parent = snapshot?.ParentAgentId ?? snapshot?.parentAgentId ?? snapshot?.labels?.["paseo.parent-agent-id"];
  return typeof parent === "string" && parent.trim() ? parent.trim() : null;
}

export async function sendPeerMessage(input, options = {}) {
  const message = validatePeerMessage(input);
  const rawSelf = process.env.PASEO_AGENT_ID?.trim();
  if (!rawSelf) throw Object.assign(new Error("PASEO_AGENT_ID is missing"), { code: "AGENT_ID_MISSING" });
  const self = metadataToken("fromAgentId", rawSelf);
  const paseo = options.runPaseo ?? runPaseo;
  const inspected = await retryWithBackoff(() => paseo(["inspect", self]), {
    maxAttempts: options.maxAttempts ?? 3, baseMs: options.baseMs ?? 250, jitter: 0,
  });
  const rawParent = parentAgentIdFromInspect(inspected.data);
  if (!rawParent) throw Object.assign(new Error("Paseo did not expose a parent Lead for this Peer"), { code: "PARENT_LEAD_UNAVAILABLE" });
  const parent = metadataToken("parentAgentId", rawParent);
  const body = [
    "PEER_MESSAGE_V1",
    `KIND: ${message.kind}`,
    `CORRELATION_ID: ${message.correlationId}`,
    `TASK_ID: ${message.taskId}`,
    `FROM_AGENT_ID: ${self}`,
    "",
    message.message,
  ].join("\n");
  // `send` is a mutation with delivery ambiguity: the daemon may accept it
  // before the response is lost. Never retry without a Paseo idempotency/ACK
  // contract; correlationId is for Lead-side deduplication, not transport.
  const sent = await paseo(["send", parent, "--prompt", body, "--no-wait"], options.sendTimeoutMs ?? 20_000);
  return { ok: true, recipient: parent, correlationId: message.correlationId, response: sent.data };
}

async function main() {
  const command = process.argv[2];
  if (command !== "ask-lead") throw new Error("usage: team-communication.mjs ask-lead '<json>'");
  let input;
  try {
    input = JSON.parse(process.argv[3] ?? "{}");
  } catch (error) {
    throw new Error(`invalid JSON message: ${String(error?.message ?? error)}`);
  }
  console.log(JSON.stringify(await sendPeerMessage(input), null, 2));
}

export function isMainModule(entry = process.argv[1], moduleUrl = import.meta.url) {
  return isEntrypoint(moduleUrl, entry);
}

if (isMainModule()) {
  main().catch((error) => {
    console.error(JSON.stringify({ ok: false, code: error.code ?? "PEER_MESSAGE_FAILED", message: error.message }));
    process.exit(2);
  });
}

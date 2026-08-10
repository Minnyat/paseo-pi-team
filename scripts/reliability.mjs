// Reliability primitives shared by remote execution and watchdog tests.

const RETRYABLE_CODES = new Set([
  "CLI_ERROR",
  "DAEMON_NOT_RUNNING",
  "ECONNRESET",
  "ECONNREFUSED",
  "ETIMEDOUT",
  "TIMEOUT",
]);

const RETRYABLE_TEXT = /(?:econnreset|econnrefused|etimedout|timed out|timeout|socket hang up|connection reset|daemon unreachable|temporarily unavailable|network is unreachable)/i;

export function classifyRemoteFailure(error) {
  const code = typeof error?.code === "string" ? error.code : "";
  const text = [error?.message, error?.error, error?.stderr].filter(Boolean).join(" ");
  if (RETRYABLE_CODES.has(code) && (code !== "CLI_ERROR" || RETRYABLE_TEXT.test(text))) {
    return "retryable";
  }
  return RETRYABLE_TEXT.test(text) ? "retryable" : "non-retryable";
}

export function computeRetryDelayMs(attempt, options = {}) {
  const baseMs = Math.max(0, options.baseMs ?? 250);
  const maxMs = Math.max(baseMs, options.maxMs ?? 5000);
  const jitter = Math.max(0, Math.min(1, options.jitter ?? 0.2));
  const exponential = Math.min(maxMs, baseMs * 2 ** Math.max(0, attempt));
  if (jitter === 0) return exponential;
  const spread = exponential * jitter;
  return Math.round(exponential - spread + Math.random() * spread * 2);
}

export async function retryWithBackoff(operation, options = {}) {
  const maxAttempts = Math.max(1, Math.floor(options.maxAttempts ?? 3));
  const deadlineMs = options.deadlineMs ?? Infinity;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    if (Date.now() >= deadlineMs) {
      throw Object.assign(new Error("retry deadline exceeded"), { code: "TIMEOUT" });
    }
    try {
      return await operation(attempt);
    } catch (error) {
      const finalAttempt = attempt + 1 >= maxAttempts;
      if (finalAttempt || classifyRemoteFailure(error) !== "retryable") throw error;
      const delay = Math.min(computeRetryDelayMs(attempt, options), Math.max(0, deadlineMs - Date.now()));
      if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
  throw new Error("retry exhausted without an operation result");
}

export function isStaleAgent(agent, options = {}) {
  if (agent?.status !== "running") return false;
  const updatedAt = Date.parse(agent?.updatedAt ?? "");
  if (!Number.isFinite(updatedAt)) return false;
  const now = options.now ?? Date.now();
  const staleAfterMs = Math.max(1000, options.staleAfterMs ?? 5 * 60_000);
  return now - updatedAt >= staleAfterMs;
}

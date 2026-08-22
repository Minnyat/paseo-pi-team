/**
 * paseo-bridge.mjs — the only place the `paseo-team` CLI talks to the Paseo CLI.
 *
 * Layering: WebUI -> paseo-team (this file) -> paseo. The WebUI never spawns
 * `paseo` itself, so every daemon call is funnelled through one argv builder
 * with one timeout policy and one error vocabulary.
 *
 * Measured on the reference machine (Windows, paseo 0.3.0): a *single* paseo
 * invocation costs ~3.0-3.5s wall, and `paseo --version` alone costs ~2.7s.
 * The cost is process/bundle startup, not the daemon query — spawning the
 * dist entry directly instead of the .cmd shim does not help. Two consequences
 * shape everything above this file:
 *   1. Never issue one call per widget. Batch a whole snapshot per command.
 *   2. Cache anything immutable (see graph-cache.mjs) instead of re-asking.
 */

import { execFile } from "node:child_process";
import { resolvePaseoExec } from "../../scripts/lib-common.mjs";

/** Generous because a cold paseo start alone eats ~3s of it. */
export const DEFAULT_COMMAND_TIMEOUT_MS = 20_000;

export class PaseoError extends Error {
	constructor(code, message, details = undefined) {
		super(message);
		this.name = "PaseoError";
		this.code = code;
		if (details !== undefined) this.details = details;
	}
}

/**
 * Resolve `[bin, ...prefixArgs]`, mapping a malformed
 * PASEO_TEAM_PASEO_EXEC onto PASEO_EXEC_INVALID rather than a generic spawn
 * failure — a bad override is a configuration fault and must never be retried.
 */
export function paseoExec() {
	return resolvePaseoExec((reason) => {
		throw new PaseoError("PASEO_EXEC_INVALID", `PASEO_TEAM_PASEO_EXEC ${reason}`);
	});
}

/**
 * Every argv element must already be a string. Coercing would turn an
 * undefined option into the literal argv element "undefined" and send a
 * nonsense command to the daemon, which is exactly the class of bug a WebUI
 * forwarding user input is most likely to introduce.
 */
export function assertArgv(args) {
	if (!Array.isArray(args) || args.length === 0) {
		throw new PaseoError("ARGV_INVALID", "paseo argv must be a non-empty array");
	}
	for (const [index, part] of args.entries()) {
		if (typeof part !== "string" || part.length === 0) {
			throw new PaseoError(
				"ARGV_INVALID",
				`paseo argv[${index}] must be a non-empty string (got ${typeof part})`,
				{ index },
			);
		}
	}
	return args;
}

/**
 * Run `paseo <args> --json` and parse stdout.
 *
 * `--json` is appended here, once, so no caller can forget it and get a table
 * back. Errors carry a code so reliability.mjs#classifyRemoteFailure can tell
 * a transport hiccup from a configuration fault.
 */
export function runPaseoJson(args, options = {}) {
	// Validation and exec resolution happen inside the executor on purpose: a
	// function that returns a promise must never *also* throw synchronously,
	// or half the call sites need a try/catch the other half do not.
	return new Promise((resolve, reject) => {
		assertArgv(args);
		const timeoutMs = Math.max(250, options.timeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS);
		const [bin, ...prefix] = paseoExec();
		const argv = [...prefix, ...args, "--json"];
		execFile(
			bin,
			argv,
			{
				encoding: "utf8",
				timeout: timeoutMs,
				signal: options.signal,
				stdio: ["ignore", "pipe", "pipe"],
				maxBuffer: 32 * 1024 * 1024,
				env: process.env,
				windowsHide: true,
			},
			(error, stdout, stderr) => {
				if (error) {
					const text = `${String(stderr ?? "").trim()} ${String(error.message ?? "")}`.trim();
					const code = error.killed || error.signal ? "TIMEOUT" : (error.code ?? "CLI_ERROR");
					reject(new PaseoError(typeof code === "number" ? "CLI_ERROR" : code, text || "paseo failed", { args }));
					return;
				}
				try {
					resolve(JSON.parse(stdout));
				} catch (parseError) {
					reject(
						new PaseoError(
							"INVALID_JSON",
							`paseo returned invalid JSON for '${args.join(" ")}': ${String(parseError?.message ?? parseError)}`,
							{ head: String(stdout).slice(0, 200) },
						),
					);
				}
			},
		);
	});
}

/**
 * Bounded-concurrency map that never rejects: a failing item resolves to
 * `{ ok: false, error }`. A snapshot must degrade per item, not collapse
 * because one cold agent timed out.
 */
export async function mapWithConcurrency(items, limit, fn) {
	const list = Array.from(items);
	const width = Math.max(1, Math.min(16, Math.floor(limit) || 1));
	const results = new Array(list.length);
	let cursor = 0;
	async function worker() {
		while (cursor < list.length) {
			const index = cursor++;
			try {
				results[index] = { ok: true, value: await fn(list[index], index) };
			} catch (error) {
				results[index] = { ok: false, error };
			}
		}
	}
	await Promise.all(Array.from({ length: Math.min(width, list.length) }, () => worker()));
	return results;
}

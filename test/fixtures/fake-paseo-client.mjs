// fake-paseo-client.mjs — stands in for Paseo's client SDK module.
//
// `models refresh` is the one command that speaks the daemon protocol instead
// of spawning the paseo CLI, so PASEO_TEAM_PASEO_EXEC cannot fake it.
// PASEO_TEAM_PASEO_CLIENT points here instead, and PST_FAKE_CLIENT_MODE picks
// which failure the test wants to see.
//
// Every call appends one line to PST_FAKE_CLIENT_LOG, so a test can assert
// WHICH providers were asked for and that the socket was closed afterwards.

import { appendFileSync } from "node:fs";

const mode = process.env.PST_FAKE_CLIENT_MODE ?? "ok";
const logPath = process.env.PST_FAKE_CLIENT_LOG;

function record(event) {
	if (logPath) appendFileSync(logPath, `${JSON.stringify(event)}\n`);
}

export async function connectToDaemon(options = {}) {
	record({ event: "connect", options });
	if (mode === "unreachable") {
		throw new Error("connect ECONNREFUSED 127.0.0.1:6767");
	}
	if (mode === "old-daemon") {
		// A Paseo old enough to predate the message: the client has no such
		// method at all.
		return { close: async () => record({ event: "close" }) };
	}
	return {
		async refreshProvidersSnapshot(payload = {}) {
			record({ event: "refresh", payload });
			if (mode === "refresh-fails") throw new Error("daemon refused: snapshot busy");
			return { acknowledged: true, requestId: "fake-request-id" };
		},
		async close() {
			record({ event: "close" });
		},
	};
}

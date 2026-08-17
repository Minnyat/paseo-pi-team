// Resolve the installed support-script directory without relying on a shell
// profile. PASEO_TEAM_SCRIPTS_DIR is an explicit override for source checkouts
// and custom installs; the default follows Pi's durable agent directory.
import { homedir } from "node:os";
import { join } from "node:path";
import { isEntrypoint } from "./lib-common.mjs";

export function defaultTeamScriptsDir(env = process.env) {
  const agentDir = env.PI_CODING_AGENT_DIR?.trim()
    || (env.PI_HOME?.trim() ? join(env.PI_HOME.trim(), "agent") : null)
    || join(homedir(), ".pi", "agent");
  return join(agentDir, "extensions", "paseo-team-scripts");
}

export function resolveTeamScriptsDir(env = process.env) {
  const override = env.PASEO_TEAM_SCRIPTS_DIR?.trim();
  return override || defaultTeamScriptsDir(env);
}

/** Entrypoint check; `moduleUrl` must default to THIS module's url, not the
 * shared helper's, so the default argument stays here. */
export function isMainModule(entry = process.argv[1], moduleUrl = import.meta.url) {
  return isEntrypoint(moduleUrl, entry);
}

if (isMainModule()) {
  console.log(resolveTeamScriptsDir());
}
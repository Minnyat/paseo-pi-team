// Resolve the installed support-script directory without relying on a shell
// profile. PASEO_TEAM_SCRIPTS_DIR is an explicit override for source checkouts
// and custom installs; the default follows Pi's durable agent directory.
import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

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

/** Compare canonical filesystem paths so symlink aliases work on macOS and Unix. */
export function isMainModule(entry = process.argv[1], moduleUrl = import.meta.url) {
  if (!entry) return false;
  try {
    return realpathSync(entry) === realpathSync(fileURLToPath(moduleUrl));
  } catch {
    return false;
  }
}

if (isMainModule()) {
  console.log(resolveTeamScriptsDir());
}
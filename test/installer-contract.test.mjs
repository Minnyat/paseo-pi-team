// Installer contract checks: installed support scripts must be usable from an
// unrelated project cwd and must include remote-paseo dependencies.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, mkdirSync, readFileSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { isMainModule as isRemoteMain } from "../scripts/remote-paseo.mjs";
import { isMainModule as isRoutingMain } from "../scripts/model-routing.mjs";
import { isMainModule as isOcrMain } from "../scripts/ocr-setup.mjs";
import { isMainModule as isOcrReviewMain } from "../scripts/ocr-review.mjs";
import { isMainModule as isCommunicationMain } from "../scripts/team-communication.mjs";
import { isMainModule as isChatMain } from "../scripts/team-chat.mjs";
import { isMainModule as isLeaseMain } from "../scripts/team-lease.mjs";
import { isMainModule as isWatchdogMain } from "../scripts/watchdog.mjs";
import { isMainModule as isPathMain } from "../scripts/team-scripts-path.mjs";
import { defaultTeamScriptsDir, resolveTeamScriptsDir } from "../scripts/team-scripts-path.mjs";
const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const source = join(root, "scripts");
const installed = mkdtempSync(join(tmpdir(), "paseo-installed-support-"));
const unrelatedCwd = mkdtempSync(join(tmpdir(), "paseo-unrelated-cwd-"));
for (const file of ["lib-common.mjs", "remote-paseo.mjs", "model-routing.mjs", "reliability.mjs", "team-communication.mjs", "team-chat.mjs", "team-lease.mjs", "watchdog.mjs", "ocr-review.mjs", "ocr-setup.mjs", "team-scripts-path.mjs"]) {
  cpSync(join(source, file), join(installed, file));
}

// Every file the installers ship must exist in scripts/, and every support
// script an installed file imports must itself be shipped — otherwise the
// install succeeds and then fails at import time on the user's machine.
for (const installer of ["install.sh", "install.ps1"]) {
  const text = readFileSync(join(root, "scripts", installer), "utf8");
  const shipped = new Set([...text.matchAll(/^\s*"?([a-z0-9-]+\.mjs)"?,?\s*$/gm)].map((m) => m[1]));
  // Sanity floor only — proves the regex still matches the installer's list
  // shape. The real check is the dependency loop below, not this count.
  assert.ok(shipped.size >= 4, `${installer}: support-file list not found (${shipped.size} matches)`);
  for (const file of shipped) {
    assert.ok(existsSync(join(source, file)), `${installer} ships missing scripts/${file}`);
    const body = readFileSync(join(source, file), "utf8");
    for (const [, dep] of body.matchAll(/from "\.\/([a-z0-9-]+\.mjs)"/g)) {
      assert.ok(shipped.has(dep), `${installer}: ${file} imports ./${dep}, which is not shipped`);
    }
  }
}

const env = { ...process.env, PASEO_TEAM_SCRIPTS_DIR: installed };
assert.equal(resolveTeamScriptsDir({ PASEO_TEAM_SCRIPTS_DIR: installed }), installed);
assert.equal(
  defaultTeamScriptsDir({ PI_CODING_AGENT_DIR: "/custom/pi/agent" }),
  join("/custom/pi/agent", "extensions", "paseo-team-scripts"),
);
assert.equal(
  defaultTeamScriptsDir({ PI_HOME: "/custom/pi" }),
  join("/custom/pi", "agent", "extensions", "paseo-team-scripts"),
);
const installedRemotePath = join(installed, "remote-paseo.mjs");
assert.equal(env.PASEO_TEAM_SCRIPTS_DIR, installed);
const output = execFileSync(process.execPath, [installedRemotePath, "--help"], {
  cwd: unrelatedCwd,
  env: { ...env, PASEO_TEAM_HOME: join(unrelatedCwd, "config") },
  encoding: "utf8",
});
assert.match(output, /remote-paseo\.mjs/);

// macOS temporary directories may be addressed through /var or /private/var.
// Entrypoint detection must compare canonical filesystem paths, not URL text.
const symlinkCases = [
  [join(installed, "remote-paseo.mjs"), isRemoteMain],
  [join(installed, "model-routing.mjs"), isRoutingMain],
  [join(installed, "ocr-setup.mjs"), isOcrMain],
  [join(installed, "ocr-review.mjs"), isOcrReviewMain],
  [join(installed, "team-communication.mjs"), isCommunicationMain],
  [join(installed, "team-chat.mjs"), isChatMain],
  [join(installed, "team-lease.mjs"), isLeaseMain],
  [join(installed, "watchdog.mjs"), isWatchdogMain],
  [join(installed, "team-scripts-path.mjs"), isPathMain],
];
for (const [target, isMain] of symlinkCases) {
  const link = join(installed, `link-${target.split(/[\\\\/]/).pop()}`);
  try {
    symlinkSync(target, link, "file");
  } catch (error) {
    if (process.platform !== "win32") throw error;
    continue;
  }
  assert.equal(
    isMain(link, pathToFileURL(target).href),
    true,
    `symlink entrypoint should resolve: ${target}`,
  );
  if (target.endsWith("remote-paseo.mjs")) {
    const symlinkOutput = execFileSync(process.execPath, [link, "--help"], {
      cwd: unrelatedCwd,
      env: { ...env, PASEO_TEAM_HOME: join(unrelatedCwd, "config") },
      encoding: "utf8",
    });
    assert.match(symlinkOutput, /remote-paseo\.mjs/);
  }
  if (target.endsWith("ocr-review.mjs")) {
    const symlinkOutput = execFileSync(process.execPath, [link, "--help"], {
      cwd: unrelatedCwd,
      env,
      encoding: "utf8",
    });
    assert.match(symlinkOutput, /ocr-review\.mjs/);
  }
  if (target.endsWith("team-scripts-path.mjs")) {
    const resolvedOutput = execFileSync(process.execPath, [link], {
      cwd: unrelatedCwd,
      env: { ...env, PI_CODING_AGENT_DIR: "/canonical/pi/agent" },
      encoding: "utf8",
    });
    assert.equal(resolvedOutput.trim(), installed);
  }
}

const installedRemote = readFileSync(join(installed, "remote-paseo.mjs"), "utf8");
assert.match(installedRemote, /from "\.\/model-routing\.mjs"/);
assert.match(installedRemote, /from "\.\/reliability\.mjs"/);

// --- Claude runtime: shipped files + installed-layout resolution ---------------
//
// The Claude hook resolves its policy modules RELATIVELY at runtime, and the
// installed layout differs from the checkout by one directory level. The
// import-scanning loop above cannot see a dynamic import, so the contract is
// proven by running the hook in a replica of the installed tree.
for (const installer of ["install.sh", "install.ps1"]) {
  const text = readFileSync(join(root, "scripts", installer), "utf8");
  for (const file of ["claude-hook.mjs", "claude-team-mcp.mjs", "paseo-team-core"]) {
    assert.ok(text.includes(file), `${installer} must ship ${file}`);
  }
}

{
  const extDir = mkdtempSync(join(tmpdir(), "paseo-installed-ext-"));
  const scriptsDir = join(extDir, "paseo-team-scripts");
  mkdirSync(scriptsDir, { recursive: true });
  mkdirSync(join(extDir, "prompts"), { recursive: true });
  mkdirSync(join(extDir, "paseo-team-core"), { recursive: true });
  for (const file of ["policy-core.ts", "claude-policy.ts"]) {
    cpSync(join(root, "extensions", "paseo-team-core", file), join(extDir, "paseo-team-core", file));
  }
  for (const file of ["claude-hook.mjs", "claude-team-mcp.mjs", "lib-common.mjs"]) {
    cpSync(join(source, file), join(scriptsDir, file));
  }
  for (const role of ["supervisor", "lead", "peer"]) {
    cpSync(join(root, "prompts", `${role}.md`), join(extDir, "prompts", `${role}.md`));
  }
  const hookPath = join(scriptsDir, "claude-hook.mjs");
  const hookEnv = {
    ...process.env,
    PASEO_PI_ROLE: "peer",
    PASEO_TEAM_HOME: join(unrelatedCwd, "claude-state"),
  };
  // No brief anywhere → read-only, so a write tool must be denied. This proves
  // the hook found the policy core through the installed layout: a resolution
  // failure would surface as the fail-closed "hook failed" reason instead.
  const denied = execFileSync(process.execPath, [hookPath, "pre-tool-use"], {
    cwd: unrelatedCwd,
    env: hookEnv,
    encoding: "utf8",
    input: JSON.stringify({
      session_id: "installer-contract",
      tool_name: "Write",
      tool_input: { file_path: "x.txt" },
    }),
  });
  const decision = JSON.parse(denied).hookSpecificOutput;
  assert.equal(decision.permissionDecision, "deny");
  assert.match(decision.permissionDecisionReason, /read-only/);
  assert.doesNotMatch(decision.permissionDecisionReason, /hook failed/);

  // The role prompt must resolve from the installed extensions dir too.
  const injected = execFileSync(process.execPath, [hookPath, "session-start"], {
    cwd: unrelatedCwd,
    env: hookEnv,
    encoding: "utf8",
    input: JSON.stringify({ session_id: "installer-contract" }),
  });
  assert.match(JSON.parse(injected).hookSpecificOutput.additionalContext, /Paseo Team Role/);

  // And the MCP server answers a handshake from the installed location.
  const handshake = execFileSync(
    process.execPath,
    [join(scriptsDir, "claude-team-mcp.mjs")],
    {
      cwd: unrelatedCwd,
      env: hookEnv,
      encoding: "utf8",
      input: `${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" })}\n`,
    },
  );
  const tools = JSON.parse(handshake).result.tools.map((tool) => tool.name);
  assert.deepEqual(tools.sort(), ["peer_ask_lead", "team_chat", "team_lease", "team_watchdog"]);
}

console.log("installer contract tests passed");

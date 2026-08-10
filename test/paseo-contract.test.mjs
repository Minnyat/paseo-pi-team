import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";

const required = process.env.PASEO_CONTRACT_AGENT_ID;
if (!required) {
  console.log("paseo contract test skipped: set PASEO_CONTRACT_AGENT_ID to run against a real agent");
  process.exit(0);
}

function paseoExecutable() {
  const override = process.env.PASEO_TEAM_PASEO_EXEC?.trim();
  if (override) return override.split(/\s+/);
  if (process.platform !== "win32") return ["paseo"];
  const dirs = (process.env.PATH ?? "").split(";");
  if (process.env.APPDATA) dirs.push(join(process.env.APPDATA, "npm"));
  for (const dir of dirs) {
    for (const name of ["paseo.exe", "paseo.cmd", "paseo.bat"]) {
      const candidate = join(dir, name);
      if (!existsSync(candidate)) continue;
      if (name === "paseo.exe") return [candidate];
      const entry = join(dirname(candidate), "node_modules", "@getpaseo", "cli", "bin", "paseo");
      if (existsSync(entry)) return [process.execPath, entry];
    }
  }
  return ["paseo"];
}

function paseoJson(args) {
  const [bin, ...prefix] = paseoExecutable();
  return JSON.parse(execFileSync(bin, [...prefix, ...args, "--json"], {
    encoding: "utf8",
    timeout: 30_000,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  }));
}

const listed = paseoJson(["ls", "-g"]);
assert.ok(Array.isArray(listed), "paseo ls -g --json must return an array");
const listedAgent = listed.find((agent) => agent.id === required);
assert.ok(listedAgent, `PASEO_CONTRACT_AGENT_ID ${required} must be present in paseo ls -g`);

const detail = paseoJson(["inspect", required]);
for (const field of ["Id", "Status", "UpdatedAt", "PendingPermissions", "ParentAgentId"]) {
  assert.ok(Object.hasOwn(detail, field), `paseo inspect contract must expose ${field}`);
}
assert.equal(detail.Id, required);
assert.equal(typeof detail.Status, "string");
assert.equal(typeof detail.UpdatedAt, "string");
assert.ok(Array.isArray(detail.PendingPermissions));
assert.ok(detail.ParentAgentId === null || typeof detail.ParentAgentId === "string");

console.log(`paseo contract test passed: ${required}`);

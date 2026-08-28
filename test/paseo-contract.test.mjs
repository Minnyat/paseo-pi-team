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

// --- chat room contract ------------------------------------------------------
// `paseo chat` carries the Lead/Supervisor coordination bus (scripts/team-chat.mjs)
// and is ABSENT from Paseo's published CLI docs, so nothing upstream promises
// this shape. Every unit test mocks the CLI; this is the one place the real
// argv is exercised, including the trailing `--json` that team-chat.mjs appends
// to every command — a post that silently rejected it would fail only in
// production. Runs a full create -> post -> read -> delete cycle in a
// throwaway room so it leaves no residue on the daemon.
{
  const room = `pteam-contract-${process.pid}-${Date.now().toString(36)}`;
  const marker = `PTEAM_CONTRACT_${process.pid}`;
  let created = false;
  try {
    const createdRoom = paseoJson(["chat", "create", room, "--purpose", "paseo-pi-team contract test"]);
    created = true;
    assert.equal(typeof createdRoom.id, "string", "chat create must return a room id");
    assert.equal(createdRoom.name, room);

    // The body goes through argv exactly as team-chat.mjs sends it.
    const posted = paseoJson(["chat", "post", room, `${marker} @${required.slice(0, 7)} body`]);
    for (const field of ["id", "author", "createdAt", "body", "mentionAgentIds"]) {
      assert.ok(Object.hasOwn(posted, field), `chat post contract must expose ${field}`);
    }
    assert.ok(posted.body.includes(marker), "the posted body must round-trip verbatim");
    // The graph's confirmed message edges depend on this: the author is stamped
    // by the daemon, never taken from the envelope.
    assert.equal(typeof posted.author, "string");
    assert.ok(Array.isArray(posted.mentionAgentIds), "mentions must parse out of the body");
    assert.ok(
      posted.mentionAgentIds.includes(required.slice(0, 7)),
      "an @short-id in the body must be recognized as a mention — delivery depends on it",
    );

    const read = paseoJson(["chat", "read", room]);
    assert.ok(Array.isArray(read), "chat read --json must return an array");
    const found = read.find((message) => message.id === posted.id);
    assert.ok(found, "a posted message must come back from chat read");
    assert.equal(found.author, posted.author, "author must be stable between post and read");
    assert.equal(found.body, posted.body);
  } finally {
    if (created) {
      try {
        paseoJson(["chat", "delete", room]);
      } catch (error) {
        console.error(`[warn] could not delete contract room ${room}: ${String(error?.message ?? error)}`);
      }
    }
  }
}

console.log(`paseo contract test passed: ${required}`);

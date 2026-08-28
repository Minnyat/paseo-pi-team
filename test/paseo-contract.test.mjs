import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, rmSync } from "node:fs";
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

// --- agent state file contract ----------------------------------------------
// `$PASEO_HOME/agents/<cwd-slug>/<agent-id>.json` is the source the graph, the
// ownership guard and the fork all read. It is not documented anywhere, so the
// only thing standing between this pack and a silent upstream reshape is this
// block. Read-only: it asserts a shape, it never writes one.
{
  const { readAgentStates, paseoAgentsRoot } = await import(
    "../extensions/paseo-team-core/agent-directory.ts"
  );
  const root = paseoAgentsRoot(process.env);
  const { states, degraded } = readAgentStates([required], { root });
  const state = states[required];
  assert.ok(
    state,
    `no state file for ${required} under ${root} (${degraded.map((d) => d.reason).join(", ")}) — the layout may have changed`,
  );
  assert.equal(state.agentId, required);
  assert.equal(typeof state.provider, "string", "provider decides the role, so it must be present");
  assert.ok(state.labels && typeof state.labels === "object", "labels carry parent + domain");
  // Not asserted as PRESENT — a brand new agent has no runtimeInfo yet — but
  // asserted as the right TYPE when they are there, because every consumer
  // branches on null vs string.
  for (const field of ["model", "thinking", "sessionId", "sessionFile", "domain", "parentAgentId", "forkOf"]) {
    assert.ok(
      state[field] === null || typeof state[field] === "string",
      `${field} must be a string or null (got ${typeof state[field]})`,
    );
  }
  assert.ok(
    ["runtime", "config", null].includes(state.modelSource),
    "the model must come from runtimeInfo or config — never from persistence.metadata (stale)",
  );
  if (state.sessionFile) {
    assert.ok(
      existsSync(state.sessionFile),
      "persistence.nativeHandle must point at a real transcript — team-fork.mjs copies it",
    );
  }
}

// --- `paseo import` contract (opt-in: it creates a real agent) --------------
// Set PASEO_CONTRACT_FORK=1 to run. It forks the contract agent's own session
// by file copy, imports it, asserts the shape team-fork.mjs depends on, and
// deletes the imported agent again. Off by default because it mutates the
// daemon, and `paseo import` is undocumented — this is the only place its
// behaviour is checked against the real CLI.
if (process.env.PASEO_CONTRACT_FORK === "1") {
  const { readAgentStates, paseoAgentsRoot } = await import(
    "../extensions/paseo-team-core/agent-directory.ts"
  );
  const { materializeFork } = await import("../scripts/team-fork.mjs");
  const { states } = readAgentStates([required], { root: paseoAgentsRoot(process.env) });
  const source = states[required];
  assert.ok(source?.sessionFile, "the contract agent must have a transcript to fork");
  const provider = process.env.PASEO_CONTRACT_FORK_PROVIDER;
  // A BARE role provider id ("pi-lead"). `paseo import` rejects the
  // `<provider>/<model>` form create_agent takes — measured 2026-08-28.
  assert.ok(provider, "set PASEO_CONTRACT_FORK_PROVIDER to a bare role provider id");

  const fork = materializeFork(source.sessionFile);
  let importedId = null;
  try {
    const imported = paseoJson([
      "import",
      fork.sessionId,
      "--provider",
      // A BARE provider id. `paseo import` rejects `<provider>/<model>`.
      provider,
      // NOT optional in practice: without --cwd the CLI notices the session
      // belongs to another project and PROMPTS ("Fork this session into current
      // directory? [y/N]"), which under --json aborts with a confusing
      // "Pi RPC process exited with code 0".
      ...(source.cwd ? ["--cwd", source.cwd] : []),
      "--label",
      `team.fork-of=${required}`,
    ]);
    // `agentId`, not `id` — the import response does not use the same field
    // name as `paseo ls`. Reading the wrong one reports a failure while leaving
    // a real agent behind.
    importedId = imported.agentId ?? imported.id ?? imported.Id ?? null;
    assert.ok(importedId, `paseo import must return the new agent id (got ${JSON.stringify(imported)})`);
    assert.equal(imported.provider, provider);

    const detail = paseoJson(["inspect", importedId]);
    // §1.1: an imported agent is already a root — no detach step is needed, and
    // a change here would silently break the fork's place in the team graph.
    assert.equal(detail.ParentAgentId ?? null, null, "an imported agent must be a root");

    const after = readAgentStates([importedId], { root: paseoAgentsRoot(process.env) });
    const forkState = after.states[importedId];
    assert.ok(forkState, "the imported agent must get a state file of its own");
    assert.equal(forkState.forkOf, required, "the --label round-trips into labels");
    assert.equal(forkState.sessionId, fork.sessionId, "the imported session id is the FORK's, not the source's");
  } finally {
    if (importedId) {
      try {
        paseoJson(["delete", importedId]);
      } catch (error) {
        console.error(`[warn] could not delete imported fork ${importedId}: ${String(error?.message ?? error)}`);
      }
    }
    try {
      rmSync(fork.file, { force: true });
    } catch {
      console.error(`[warn] left a fork transcript behind: ${fork.file}`);
    }
  }
}

console.log(`paseo contract test passed: ${required}`);

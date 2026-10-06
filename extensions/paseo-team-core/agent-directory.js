/**
 * agent-directory.ts — what Paseo already knows about an agent, read off disk.
 *
 * Paseo persists one JSON file per agent at
 * `$PASEO_HOME/agents/<cwd-slug>/<agent-id>.json`, and it carries everything
 * the team previously had to buy with `paseo inspect` (~3s per agent):
 *
 *   labels["paseo.parent-agent-id"]  -> the spawn edge / ownership
 *   labels["team.domain"]            -> which supervisor/lead owns this seat
 *   labels["team.watch"]             -> what a supervisor seat watches
 *   provider                         -> "<family>-<role>/..." → the role
 *   runtimeInfo.model / thinking     -> what the agent ACTUALLY runs
 *   runtimeInfo.sessionId            -> the provider session id
 *   persistence.nativeHandle         -> the session JSONL path (fork/handoff)
 *
 * It lives in the POLICY CORE rather than in the CLI because both are readers
 * of the same thing and only one of them may be the source of truth: the
 * `send_agent_prompt` ownership guard (PR-D) and `pteam graph` must agree about
 * who owns an agent, or the graph draws a team the policy does not enforce.
 * `cli/lib/agent-state.mjs` re-exports this module for that reason.
 *
 * Three deliberate rules, all measured on 2026-08-28:
 *
 *   - `runtimeInfo.model` wins over `config.model`, and
 *     `persistence.metadata.model` is NEVER a model source: it is a
 *     creation-time snapshot that Paseo does not rewrite when the model is
 *     changed through `update_agent`, so trusting it reports a model the agent
 *     is not running.
 *   - Agents are found by SCANNING the agents root, not by recomputing the
 *     cwd slug. The slug rule (drop `:`, separators to `-`) is undocumented and
 *     would silently mis-resolve the day it changes; an id-keyed scan cannot.
 *   - Every read degrades into data rather than throwing. The whole surface is
 *     undocumented (docs/multi-supervisor-topology.md §1.13), and a graph that
 *     admits a gap beats one that lies. Where a POLICY decision depends on the
 *     read, the caller — not this file — turns "unknown" into a refusal.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
export const AGENT_DOMAIN_LABEL = "team.domain";
/**
 * What a Supervisor seat watches (policy-core.ts, "Watch"). Kept raw here, like
 * the domain: parsing it is a policy question, reading it is not.
 */
export const AGENT_WATCH_LABEL = "team.watch";
export const AGENT_PARENT_LABEL = "paseo.parent-agent-id";
/** Set by team-fork.mjs so a fork's lineage survives in `paseo ls` and the graph. */
export const AGENT_FORK_LABEL = "team.fork-of";
/** Paseo agent ids are UUIDs. Anything else never becomes a path segment. */
const AGENT_ID = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
export function isAgentId(value) {
    return typeof value === "string" && AGENT_ID.test(value);
}
/** `$PASEO_HOME`, else the documented default. */
export function paseoHomeDir(env = process.env) {
    return env.PASEO_HOME?.trim() || join(homedir(), ".paseo");
}
export function paseoAgentsRoot(env = process.env) {
    return join(paseoHomeDir(env), "agents");
}
function str(value) {
    return typeof value === "string" && value.trim() !== "" ? value : null;
}
/**
 * Build `{ [agentId]: absoluteFilePath }` by scanning one level of cwd-slug
 * directories. One pass serves a whole snapshot, which is the access pattern
 * every caller has (`agents`, `graph`).
 */
export function buildStateIndex(root = paseoAgentsRoot()) {
    const index = {};
    const degraded = [];
    let slugs;
    try {
        slugs = readdirSync(root, { withFileTypes: true });
    }
    catch (error) {
        // A missing root is the normal state of a machine Paseo has not written
        // agent state on — a fresh host, a sandbox, another PASEO_HOME. The
        // enrichment is simply unavailable; the graph still renders from `ls`.
        // Anything else (permissions, a file where the directory should be) IS a
        // fault, because it means the data exists and we could not read it.
        if (error?.code === "ENOENT")
            return { index, degraded: [] };
        return {
            index,
            degraded: [
                {
                    reason: "AGENT_STATE_ROOT_UNREADABLE",
                    detail: `${root}: ${String(error?.message ?? error)}`,
                },
            ],
        };
    }
    for (const slug of slugs) {
        if (!slug.isDirectory())
            continue;
        const dir = join(root, slug.name);
        let files;
        try {
            files = readdirSync(dir);
        }
        catch (error) {
            degraded.push({
                reason: "AGENT_STATE_DIR_UNREADABLE",
                detail: `${dir}: ${String(error?.message ?? error)}`,
            });
            continue;
        }
        for (const file of files) {
            if (!file.endsWith(".json"))
                continue;
            const id = file.slice(0, -".json".length);
            if (!isAgentId(id))
                continue;
            index[id] = join(dir, file);
        }
    }
    return { index, degraded };
}
/**
 * Normalize one raw state object. Pure: same input, same output, no I/O.
 * Returns null for anything that is not an object, so a junk file is a fault
 * about one agent instead of an exception that ends the snapshot.
 */
export function normalizeAgentState(raw, agentId) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw))
        return null;
    const record = raw;
    const labels = record.labels &&
        typeof record.labels === "object" &&
        !Array.isArray(record.labels)
        ? { ...record.labels }
        : {};
    const runtime = record.runtimeInfo && typeof record.runtimeInfo === "object"
        ? record.runtimeInfo
        : {};
    const config = record.config && typeof record.config === "object" ? record.config : {};
    const persistence = record.persistence && typeof record.persistence === "object"
        ? record.persistence
        : {};
    const runtimeModel = str(runtime.model);
    const configModel = str(config.model);
    const model = runtimeModel ?? configModel;
    const runtimeMode = str(runtime.modeId);
    const configMode = str(config.modeId);
    const mode = runtimeMode ?? configMode;
    return {
        agentId: str(record.id) ?? agentId,
        provider: str(record.provider),
        cwd: str(record.cwd),
        workspaceId: str(record.workspaceId),
        title: str(record.title),
        labels,
        domain: str(labels[AGENT_DOMAIN_LABEL]),
        watch: str(labels[AGENT_WATCH_LABEL]),
        archived: str(record.archivedAt) !== null,
        parentAgentId: str(labels[AGENT_PARENT_LABEL]),
        forkOf: str(labels[AGENT_FORK_LABEL]),
        model,
        modelSource: runtimeModel ? "runtime" : configModel ? "config" : null,
        // Only a real disagreement counts: a missing runtimeInfo (agent not
        // started yet) is not drift, it is "not known yet".
        modelDrift: Boolean(runtimeModel && configModel && runtimeModel !== configModel),
        mode,
        modeSource: runtimeMode ? "runtime" : configMode ? "config" : null,
        // A mode set after creation (`paseo agent mode`, or the desktop's own
        // switcher) lands in runtimeInfo while config keeps what the agent was
        // created with — a real disagreement about what the seat is doing now.
        modeDrift: Boolean(runtimeMode && configMode && runtimeMode !== configMode),
        thinking: str(runtime.thinkingOptionId),
        sessionId: str(runtime.sessionId) ?? str(persistence.sessionId),
        sessionFile: str(persistence.nativeHandle),
    };
}
/** Read normalized state for the given agent ids. */
export function readAgentStates(ids, options = {}) {
    const root = options.root ?? paseoAgentsRoot();
    const built = options.index
        ? { index: options.index, degraded: [] }
        : buildStateIndex(root);
    const states = {};
    const degraded = [...built.degraded];
    for (const id of Array.isArray(ids) ? ids : []) {
        if (!isAgentId(id)) {
            degraded.push({
                agentId: typeof id === "string" ? id : String(id),
                reason: "AGENT_STATE_ID_INVALID",
            });
            continue;
        }
        const path = built.index[id];
        if (!path) {
            degraded.push({ agentId: id, reason: "AGENT_STATE_MISSING" });
            continue;
        }
        let normalized = null;
        try {
            normalized = normalizeAgentState(JSON.parse(readFileSync(path, "utf8")), id);
        }
        catch (error) {
            degraded.push({
                agentId: id,
                reason: "AGENT_STATE_UNREADABLE",
                detail: String(error?.message ?? error),
            });
            continue;
        }
        if (!normalized) {
            degraded.push({
                agentId: id,
                reason: "AGENT_STATE_UNREADABLE",
                detail: "state file is not a JSON object",
            });
            continue;
        }
        states[id] = normalized;
    }
    return { states, degraded, index: built.index };
}
/** Every agent Paseo has written state for. Used by the jurisdiction rules,
 *  which have to know about supervisors nobody named in the message. */
export function readAllAgentStates(env = process.env, root = paseoAgentsRoot(env)) {
    const built = buildStateIndex(root);
    const read = readAgentStates(Object.keys(built.index), {
        root,
        index: built.index,
    });
    // readAgentStates is handed a ready-made index, so it has no faults of the
    // scan to report — the ones buildStateIndex just collected (an unreadable
    // root, an unreadable cwd-slug directory) would be dropped here, and "the
    // data exists and I could not read it" would read as "there is none".
    return { ...read, degraded: [...built.degraded, ...read.degraded] };
}
/** Present only so callers can report the root they actually read. */
export function agentStateRoot(env = process.env) {
    try {
        const root = paseoAgentsRoot(env);
        statSync(root);
        return root;
    }
    catch {
        return null;
    }
}

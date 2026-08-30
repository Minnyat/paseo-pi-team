#!/usr/bin/env bash
# install.sh — install the paseo-pi-team role pack into the current user's pi config.
#
# Copies:
#   extensions/paseo-team-policy.ts -> ~/.pi/agent/extensions/   (pi adapter)
#   extensions/paseo-team-core/     -> ~/.pi/agent/extensions/   (shared rules +
#                                                                claude dialect)
#   prompts/*.md                   -> ~/.pi/agent/extensions/prompts/
#   skills/paseo-team-lead/         -> ~/.pi/agent/skills/paseo-team-lead/
#
# When the claude CLI is present it also merges the Claude Code side (hooks in
# ~/.claude/settings.json + the paseo-team MCP server in ~/.claude.json) so the
# same three roles run on both runtimes.
#
# Does NOT touch ~/.paseo/config.json — merge config/paseo.providers.example.json by hand.

set -euo pipefail

# Optional: attach agent-browser to an already-running browser over CDP instead
# of letting it launch an isolated one. Opt-in with an explicit port — see
# scripts/browser-setup.mjs for why this is not a default.
ATTACH_CDP_PORT=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --attach-cdp-port)
      if [[ $# -lt 2 ]]; then
        echo "[paseo-team] --attach-cdp-port requires a port" >&2
        exit 1
      fi
      ATTACH_CDP_PORT="$2"
      shift 2
      ;;
    *)
      echo "[paseo-team] unknown argument: $1" >&2
      exit 1
      ;;
  esac
done

ROLE_PACK_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PI_HOME="${PI_HOME:-$HOME/.pi}"
AGENT_DIR="${PI_CODING_AGENT_DIR:-$PI_HOME/agent}"

EXT_DIR="$AGENT_DIR/extensions"
PROMPT_DIR="$EXT_DIR/prompts"
SKILLS_DIR="$AGENT_DIR/skills"
SKILL_DIR="$SKILLS_DIR/paseo-team-lead"
OCR_SKILL_DIR="$SKILLS_DIR/paseo-ocr-reviewer"
TEAM_SCRIPTS_DIR="$EXT_DIR/paseo-team-scripts"
TEAM_SUPPORT_FILES=(
  # lib-common.mjs must ship: every other support script imports it as
  # "./lib-common.mjs" and would fail at import time without it.
  lib-common.mjs
  reliability.mjs
  watchdog.mjs
  team-communication.mjs
  team-chat.mjs
  team-lease.mjs
  team-fork.mjs
  ocr-review.mjs
  remote-paseo.mjs
  model-routing.mjs
  team-scripts-path.mjs
  # Claude Code side: the policy hook and the team-tools MCP server. Both are
  # spawned by Claude with an absolute path, so they must live in the durable
  # support dir, not in a checkout that may be moved.
  claude-hook.mjs
  claude-team-mcp.mjs
)

# Policy modules shared by BOTH runtime adapters. They ship as a SUBDIRECTORY:
# pi discovers extensions/*.ts as extensions and only enters a subdirectory that
# carries an index or a pi package.json, so a plain directory keeps them out of
# that scan while leaving them reviewable .ts files.
POLICY_CORE_DIR="paseo-team-core"

mkdir -p "$EXT_DIR" "$PROMPT_DIR" "$SKILLS_DIR"
# Routing configs live here (model-routing.local.json, cluster-routing.local.json);
# create it so the documented copy commands work out of the box.
mkdir -p "$HOME/.paseo-pi-team"

cp -f "$ROLE_PACK_ROOT/extensions/paseo-team-policy.ts" "$EXT_DIR/paseo-team-policy.ts"
rm -rf "$EXT_DIR/$POLICY_CORE_DIR"
cp -R "$ROLE_PACK_ROOT/extensions/$POLICY_CORE_DIR" "$EXT_DIR/$POLICY_CORE_DIR"
# The built .js NEVER travels here. It exists only to satisfy an installed npm
# package, where Node refuses to strip types under node_modules; this directory
# is not under node_modules, so .ts loads fine. Copying both would install two
# sources of truth for one rule set, and every loader prefers .js — so a source
# tree built once and edited since would have pi read the CURRENT .ts while the
# Claude hook and pteam read the STALE .js. Two runtimes, different rules, no
# signal. Deleting it leaves exactly one answer to "what does the policy say".
rm -f "$EXT_DIR/$POLICY_CORE_DIR"/*.js
cp -f "$ROLE_PACK_ROOT"/prompts/*.md "$PROMPT_DIR/"
rm -rf "$SKILL_DIR"
cp -R "$ROLE_PACK_ROOT/skills/paseo-team-lead" "$SKILL_DIR"
rm -rf "$OCR_SKILL_DIR"
cp -R "$ROLE_PACK_ROOT/skills/paseo-ocr-reviewer" "$OCR_SKILL_DIR"
rm -rf "$TEAM_SCRIPTS_DIR"
mkdir -p "$TEAM_SCRIPTS_DIR"
for support_file in "${TEAM_SUPPORT_FILES[@]}"; do
  cp -f "$ROLE_PACK_ROOT/scripts/$support_file" "$TEAM_SCRIPTS_DIR/"
done

# Install and verify the pinned OCR dependency before browser setup.
if ! node "$ROLE_PACK_ROOT/scripts/ocr-setup.mjs"; then
  echo "[paseo-team] OCR setup failed" >&2
  exit 1
fi
# agent-browser is a CLI + bundled skill + stdio MCP server. The helper is
# idempotent and merges only the missing agent-browser entry in Pi's MCP config;
# the Claude half of that registration is done by claude-setup.mjs below, which
# owns ~/.claude.json.
BROWSER_SETUP_ARGS=(--install)
if [[ -z "${PI_CODING_AGENT_DIR:-}" ]]; then
  BROWSER_SETUP_ARGS+=(--pi-home "$PI_HOME")
fi
if [[ -n "$ATTACH_CDP_PORT" ]]; then
  BROWSER_SETUP_ARGS+=(--attach-cdp-port "$ATTACH_CDP_PORT")
fi
if ! node "$ROLE_PACK_ROOT/scripts/browser-setup.mjs" "${BROWSER_SETUP_ARGS[@]}"; then
  echo "[paseo-team] agent-browser setup failed" >&2
  exit 1
fi

# Claude Code side. Skipped (not failed) when claude is not installed: a
# pi-only host is a supported configuration.
CLAUDE_SETUP_STATUS="skipped (claude CLI not found)"
if command -v claude >/dev/null 2>&1; then
  # Same --attach-cdp-port the pi entry got: the two runtimes must reach the
  # same browser, or a task moved between seats silently changes what it drives.
  CLAUDE_SETUP_ARGS=(--install)
  if [[ -n "$ATTACH_CDP_PORT" ]]; then
    CLAUDE_SETUP_ARGS+=(--attach-cdp-port "$ATTACH_CDP_PORT")
  fi
  # Point the hook/MCP registrations at the INSTALLED copies, so moving or
  # deleting this checkout cannot break a configured Claude agent.
  if env \
    PASEO_TEAM_HOOK_SCRIPT="$TEAM_SCRIPTS_DIR/claude-hook.mjs" \
    PASEO_TEAM_MCP_SCRIPT="$TEAM_SCRIPTS_DIR/claude-team-mcp.mjs" \
    PASEO_TEAM_POLICY_DIR="$EXT_DIR/$POLICY_CORE_DIR" \
    node "$ROLE_PACK_ROOT/scripts/claude-setup.mjs" "${CLAUDE_SETUP_ARGS[@]}"; then
    CLAUDE_SETUP_STATUS="installed (hooks + paseo-team and agent-browser MCP servers)"
  else
    echo "[paseo-team] claude setup failed" >&2
    exit 1
  fi
fi

echo ""
echo "[paseo-team] Installed:"
echo "  extension -> $EXT_DIR/paseo-team-policy.ts"
echo "  prompts   -> $PROMPT_DIR"
echo "  lead skill -> $SKILL_DIR"
echo "  OCR skill  -> $OCR_SKILL_DIR"
echo "  support   -> $TEAM_SCRIPTS_DIR"
echo "  policy    -> $EXT_DIR/$POLICY_CORE_DIR/ (shared core, both runtimes)"
echo "  claude    -> $CLAUDE_SETUP_STATUS"
export PASEO_TEAM_SCRIPTS_DIR="$TEAM_SCRIPTS_DIR"
echo "  support env -> PASEO_TEAM_SCRIPTS_DIR=$TEAM_SCRIPTS_DIR (current process)"
echo "  support default -> \${PI_CODING_AGENT_DIR:-\$HOME/.pi/agent}/extensions/paseo-team-scripts"
echo "  env override is optional; no shell profile mutation is required"
echo ""
echo "Next steps:"
echo "  1. The installer checked/installed OCR (capability-probed; >= v1.8.10 kept as-is, pinned v1.9.2 when repairing), agent-browser CLI, Chrome runtime, skill and the MCP entry for every installed runtime (Pi mcp.json, and ~/.claude.json when claude is present)."
echo "  2. Verify OCR if needed: command -v ocr; ocr version"
echo "  3. Install the MCP adapter (PINNED version — Paseo tools depend on it):"
echo "     pi install npm:pi-mcp-adapter@2.19.0"
echo "  4. Merge config/paseo.providers.example.json into ~/.paseo/config.json"
echo "     (agents.providers.pi-* + claude-* + daemon.mcp.injectIntoAgents: true)."
echo "     Regenerate the claude-* block any time with:"
echo "       node \"$ROLE_PACK_ROOT/scripts/claude-setup.mjs\" --print-providers"
echo "  5. Copy config/model-routing.example.json to ~/.paseo-pi-team/model-routing.local.json"
echo "     and fill in REAL model IDs from: paseo provider models pi-peer --json"
echo "     Cross-host controller: also copy config/cluster-routing.example.json to"
echo "     ~/.paseo-pi-team/cluster-routing.local.json (endpoint values live in env)"
echo "  6. Restart the Paseo daemon (kills running agents — do it when ready)."
echo "  7. In pi, run /reload to load the new extension, then /team-role."
echo "  8. Verify host readiness (repo-root independent):"
echo "     node \"$ROLE_PACK_ROOT/scripts/preflight.mjs\""

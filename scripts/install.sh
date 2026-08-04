#!/usr/bin/env bash
# install.sh — install the paseo-pi-team role pack into the current user's pi config.
#
# Copies:
#   extensions/paseo-team-policy.ts -> ~/.pi/agent/extensions/
#   prompts/*.md                   -> ~/.pi/agent/extensions/prompts/
#   skills/paseo-team-lead/         -> ~/.pi/agent/skills/paseo-team-lead/
#
# Does NOT touch ~/.paseo/config.json — merge config/paseo.providers.example.json by hand.

set -euo pipefail

ROLE_PACK_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PI_HOME="${PI_HOME:-$HOME/.pi}"

EXT_DIR="$PI_HOME/agent/extensions"
PROMPT_DIR="$EXT_DIR/prompts"
SKILLS_DIR="$PI_HOME/agent/skills"
SKILL_DIR="$SKILLS_DIR/paseo-team-lead"

mkdir -p "$EXT_DIR" "$PROMPT_DIR" "$SKILLS_DIR"
# Routing configs live here (model-routing.local.json, cluster-routing.local.json);
# create it so the documented copy commands work out of the box.
mkdir -p "$HOME/.paseo-pi-team"

cp -f "$ROLE_PACK_ROOT/extensions/paseo-team-policy.ts" "$EXT_DIR/paseo-team-policy.ts"
cp -f "$ROLE_PACK_ROOT"/prompts/*.md "$PROMPT_DIR/"
rm -rf "$SKILL_DIR"
cp -R "$ROLE_PACK_ROOT/skills/paseo-team-lead" "$SKILL_DIR"

echo ""
echo "[paseo-team] Installed:"
echo "  extension -> $EXT_DIR/paseo-team-policy.ts"
echo "  prompts   -> $PROMPT_DIR"
echo "  skill     -> $SKILL_DIR"
echo ""
echo "Next steps:"
echo "  1. Install the MCP adapter (PINNED version — Paseo tools depend on it):"
echo "     pi install npm:pi-mcp-adapter@2.19.0"
echo "  2. Merge config/paseo.providers.example.json into ~/.paseo/config.json"
echo "     (agents.providers.pi-* + daemon.mcp.injectIntoAgents: true)."
echo "  3. Copy config/model-routing.example.json to ~/.paseo-pi-team/model-routing.local.json"
echo "     and fill in REAL model IDs from: paseo provider models pi-peer --json"
echo "     Cross-host controller: also copy config/cluster-routing.example.json to"
echo "     ~/.paseo-pi-team/cluster-routing.local.json (endpoint values live in env)"
echo "  4. Restart the Paseo daemon (kills running agents — do it when ready)."
echo "  5. In pi, run /reload to load the new extension, then /team-role."
echo "  6. Verify host readiness (repo-root independent):"
echo "     node \"$ROLE_PACK_ROOT/scripts/preflight.mjs\""

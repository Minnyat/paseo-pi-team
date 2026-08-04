#!/usr/bin/env bash
# install.sh — install the paseo-pi-team role pack into the current user's pi config.
#
# Copies:
#   extensions/paseo-team-policy.ts -> ~/.pi/agent/extensions/
#   prompts/*.md                   -> ~/.pi/agent/extensions/prompts/
#   skills/paseo-team-lead/         -> ~/.pi/agent/skills/paseo-team-lead/
#
# Does NOT touch ~/.paseo/config.json — merge config/paseo.providers.json by hand.

set -euo pipefail

ROLE_PACK_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PI_HOME="${PI_HOME:-$HOME/.pi}"

EXT_DIR="$PI_HOME/agent/extensions"
PROMPT_DIR="$EXT_DIR/prompts"
SKILLS_DIR="$PI_HOME/agent/skills"
SKILL_DIR="$SKILLS_DIR/paseo-team-lead"

mkdir -p "$EXT_DIR" "$PROMPT_DIR" "$SKILLS_DIR"

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
echo "  1. Merge config/paseo.providers.json into ~/.paseo/config.json"
echo "     (agents.providers.pi-* + daemon.mcp.injectIntoAgents: true)."
echo "  2. Restart the Paseo daemon (kills running agents — do it when ready)."
echo "  3. In pi, run /reload to load the new extension, then /team-role."

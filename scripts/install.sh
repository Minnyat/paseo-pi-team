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
OCR_SKILL_DIR="$SKILLS_DIR/paseo-ocr-reviewer"
TEAM_SCRIPTS_DIR="$EXT_DIR/paseo-team-scripts"
TEAM_SUPPORT_FILES=(
  reliability.mjs
  watchdog.mjs
  team-communication.mjs
  ocr-review.mjs
  remote-paseo.mjs
  model-routing.mjs
)

mkdir -p "$EXT_DIR" "$PROMPT_DIR" "$SKILLS_DIR"
# Routing configs live here (model-routing.local.json, cluster-routing.local.json);
# create it so the documented copy commands work out of the box.
mkdir -p "$HOME/.paseo-pi-team"

cp -f "$ROLE_PACK_ROOT/extensions/paseo-team-policy.ts" "$EXT_DIR/paseo-team-policy.ts"
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

# agent-browser is a CLI + bundled skill + stdio MCP server. The helper is
# idempotent and merges only the missing agent-browser entry in Pi's MCP config.
if ! node "$ROLE_PACK_ROOT/scripts/browser-setup.mjs" --install --pi-home "$PI_HOME"; then
  echo "[paseo-team] agent-browser setup failed" >&2
  exit 1
fi

echo ""
echo "[paseo-team] Installed:"
echo "  extension -> $EXT_DIR/paseo-team-policy.ts"
echo "  prompts   -> $PROMPT_DIR"
echo "  lead skill -> $SKILL_DIR"
echo "  OCR skill  -> $OCR_SKILL_DIR"
echo "  support   -> $TEAM_SCRIPTS_DIR"
export PASEO_TEAM_SCRIPTS_DIR="$TEAM_SCRIPTS_DIR"
PROFILE_FILE="${PASEO_TEAM_PROFILE_FILE:-$HOME/.profile}"
touch "$PROFILE_FILE"
PROFILE_VALUE="$(printf '%q' "$TEAM_SCRIPTS_DIR")"
PROFILE_TMP="${PROFILE_FILE}.$$"
awk -v value="$PROFILE_VALUE" '
  BEGIN { replaced = 0 }
  /^export PASEO_TEAM_SCRIPTS_DIR=/ {
    if (!replaced) { print "export PASEO_TEAM_SCRIPTS_DIR=" value; replaced = 1 }
    next
  }
  { print }
  END { if (!replaced) print "\nexport PASEO_TEAM_SCRIPTS_DIR=" value }
' "$PROFILE_FILE" > "$PROFILE_TMP"
mv "$PROFILE_TMP" "$PROFILE_FILE"
echo "  support env -> PASEO_TEAM_SCRIPTS_DIR=$TEAM_SCRIPTS_DIR (new shells; source $PROFILE_FILE)"
echo ""
echo "Next steps:"
echo "  1. The installer checked/installed agent-browser CLI, Chrome runtime, skill and Pi MCP config."
echo "  2. Check OCR first: command -v ocr; ocr version"
echo "     If missing, install the tested delegation CLI: npm install -g @alibaba-group/open-code-review@1.8.10"
echo "  3. Install the MCP adapter (PINNED version — Paseo tools depend on it):"
echo "     pi install npm:pi-mcp-adapter@2.19.0"
echo "  4. Merge config/paseo.providers.example.json into ~/.paseo/config.json"
echo "     (agents.providers.pi-* + daemon.mcp.injectIntoAgents: true)."
echo "  5. Copy config/model-routing.example.json to ~/.paseo-pi-team/model-routing.local.json"
echo "     and fill in REAL model IDs from: paseo provider models pi-peer --json"
echo "     Cross-host controller: also copy config/cluster-routing.example.json to"
echo "     ~/.paseo-pi-team/cluster-routing.local.json (endpoint values live in env)"
echo "  6. Restart the Paseo daemon (kills running agents — do it when ready)."
echo "  7. In pi, run /reload to load the new extension, then /team-role."
echo "  8. Verify host readiness (repo-root independent):"
echo "     node \"$ROLE_PACK_ROOT/scripts/preflight.mjs\""

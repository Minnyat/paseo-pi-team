# install.ps1 - install the paseo-pi-team role pack into the current user's pi config.
#
# Copies:
#   extensions/paseo-team-policy.ts -> ~/.pi/agent/extensions/
#   prompts/*.md                   -> ~/.pi/agent/extensions/prompts/
#   skills/paseo-team-lead/         -> ~/.pi/agent/skills/paseo-team-lead/
#
# Does NOT touch ~/.paseo/config.json - merge config/paseo.providers.example.json by hand.

param(
  [string]$PiHome = "$env:USERPROFILE\.pi",
  [string]$RolePackRoot = (Split-Path -Parent $PSScriptRoot)
)

$ErrorActionPreference = "Stop"

$extDir    = Join-Path $PiHome "agent\extensions"
$promptDir = Join-Path $extDir "prompts"
$skillsDir = Join-Path $PiHome "agent\skills"
$skillDir  = Join-Path $skillsDir "paseo-team-lead"

New-Item -ItemType Directory -Force -Path $extDir, $promptDir, $skillsDir | Out-Null
# Routing configs live in ~/.paseo-pi-team (model-routing.local.json, cluster-routing.local.json).
New-Item -ItemType Directory -Force -Path "$env:USERPROFILE\.paseo-pi-team" | Out-Null

Copy-Item (Join-Path $RolePackRoot "extensions\paseo-team-policy.ts") (Join-Path $extDir "paseo-team-policy.ts") -Force
Copy-Item (Join-Path $RolePackRoot "prompts\*.md") $promptDir -Force
Copy-Item -Recurse -Force (Join-Path $RolePackRoot "skills\paseo-team-lead") $skillDir

Write-Host ""
Write-Host "[paseo-team] Installed:"
Write-Host "  extension -> $extDir\paseo-team-policy.ts"
Write-Host "  prompts   -> $promptDir"
Write-Host "  skill     -> $skillDir"
Write-Host ""
Write-Host "Next steps:"
Write-Host "  1. Install the MCP adapter (PINNED version - Paseo tools depend on it):"
Write-Host "     pi install npm:pi-mcp-adapter@2.19.0"
Write-Host "  2. Merge config/paseo.providers.example.json into ~/.paseo/config.json"
Write-Host "     (agents.providers.pi-* + daemon.mcp.injectIntoAgents: true)."
Write-Host "  3. Copy config/model-routing.example.json to ~/.paseo-pi-team/model-routing.local.json"
Write-Host "     and fill in REAL model IDs from: paseo provider models pi-peer --json"
Write-Host "     Cross-host controller: also copy config/cluster-routing.example.json to"
Write-Host "     ~/.paseo-pi-team/cluster-routing.local.json (endpoint values live in env)"
Write-Host "  4. Restart the Paseo daemon (kills running agents - do it when ready)."
Write-Host "  5. In pi, run /reload to load the new extension, then /team-role."
Write-Host "  6. Verify host readiness (repo-root independent):"
Write-Host "     node `"$(Join-Path $RolePackRoot 'scripts\preflight.mjs')`""

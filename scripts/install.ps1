# install.ps1 — install the paseo-pi-team role pack into the current user's pi config.
#
# Copies:
#   extensions/paseo-team-policy.ts -> ~/.pi/agent/extensions/
#   prompts/*.md                   -> ~/.pi/agent/extensions/prompts/
#   skills/paseo-team-lead/         -> ~/.pi/agent/skills/paseo-team-lead/
#
# Does NOT touch ~/.paseo/config.json — merge config/paseo.providers.json by hand.

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
Write-Host "  1. Merge config/paseo.providers.json into ~/.paseo/config.json"
Write-Host "     (agents.providers.pi-* + daemon.mcp.injectIntoAgents: true)."
Write-Host "  2. Restart the Paseo daemon (kills running agents — do it when ready)."
Write-Host "  3. In pi, run /reload to load the new extension, then /team-role."

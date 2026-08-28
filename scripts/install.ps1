# install.ps1 - install the paseo-pi-team role pack into the current user's pi config.
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
# Does NOT touch ~/.paseo/config.json - merge config/paseo.providers.example.json by hand.

param(
  [string]$PiHome = "$env:USERPROFILE\.pi",
  [string]$RolePackRoot = (Split-Path -Parent $PSScriptRoot),
  # Optional: attach agent-browser to an already-running browser over CDP
  # instead of letting it launch an isolated one. Opt-in with an explicit port
  # - see scripts/browser-setup.mjs for why this is not a default.
  [string]$AttachCdpPort = ""
)

$ErrorActionPreference = "Stop"

$agentDir = if ($env:PI_CODING_AGENT_DIR) { $env:PI_CODING_AGENT_DIR } else { Join-Path $PiHome "agent" }
$extDir    = Join-Path $agentDir "extensions"
$promptDir = Join-Path $extDir "prompts"
$skillsDir = Join-Path $agentDir "skills"
$skillDir  = Join-Path $skillsDir "paseo-team-lead"
$ocrSkillDir = Join-Path $skillsDir "paseo-ocr-reviewer"
$teamScriptsDir = Join-Path $extDir "paseo-team-scripts"
$teamSupportFiles = @(
  # lib-common.mjs must ship: every other support script imports it as
  # "./lib-common.mjs" and would fail at import time without it.
  "lib-common.mjs",
  "reliability.mjs",
  "watchdog.mjs",
  "team-communication.mjs",
  "team-chat.mjs",
  "ocr-review.mjs",
  "remote-paseo.mjs",
  "model-routing.mjs",
  "team-scripts-path.mjs",
  # Claude Code side: the policy hook and the team-tools MCP server. Both are
  # spawned by Claude with an absolute path, so they must live in the durable
  # support dir, not in a checkout that may be moved.
  "claude-hook.mjs",
  "claude-team-mcp.mjs"
)

# Policy modules shared by BOTH runtime adapters. They ship as a SUBDIRECTORY:
# pi discovers extensions/*.ts as extensions and only enters a subdirectory that
# carries an index or a pi package.json, so a plain directory keeps them out of
# that scan while leaving them reviewable .ts files.
$policyCoreDir = "paseo-team-core"

New-Item -ItemType Directory -Force -Path $extDir, $promptDir, $skillsDir | Out-Null
# Routing configs live in ~/.paseo-pi-team (model-routing.local.json, cluster-routing.local.json).
New-Item -ItemType Directory -Force -Path "$env:USERPROFILE\.paseo-pi-team" | Out-Null

Copy-Item (Join-Path $RolePackRoot "extensions\paseo-team-policy.ts") (Join-Path $extDir "paseo-team-policy.ts") -Force
$policyCoreTarget = Join-Path $extDir $policyCoreDir
if (Test-Path $policyCoreTarget) { Remove-Item -Recurse -Force $policyCoreTarget }
Copy-Item -Recurse -Force (Join-Path $RolePackRoot "extensions\$policyCoreDir") $policyCoreTarget
Copy-Item (Join-Path $RolePackRoot "prompts\*.md") $promptDir -Force
# Replace skill directories deterministically; Copy-Item -Recurse otherwise
# merges stale files and can create nested directories on repeated installs.
if (Test-Path $skillDir) { Remove-Item -Recurse -Force $skillDir }
if (Test-Path $ocrSkillDir) { Remove-Item -Recurse -Force $ocrSkillDir }
Copy-Item -Recurse -Force (Join-Path $RolePackRoot "skills\paseo-team-lead") $skillDir
Copy-Item -Recurse -Force (Join-Path $RolePackRoot "skills\paseo-ocr-reviewer") $ocrSkillDir
if (Test-Path $teamScriptsDir) { Remove-Item -Recurse -Force $teamScriptsDir }
New-Item -ItemType Directory -Force -Path $teamScriptsDir | Out-Null
foreach ($supportFile in $teamSupportFiles) {
  Copy-Item (Join-Path $RolePackRoot "scripts\$supportFile") $teamScriptsDir -Force
}

# agent-browser is a CLI + bundled skill + stdio MCP server. The helper is
# idempotent and merges only the missing agent-browser entry in Pi's MCP config.
& node (Join-Path $RolePackRoot "scripts\ocr-setup.mjs")
if ($LASTEXITCODE -ne 0) {
  throw "OCR setup failed with exit code $LASTEXITCODE"
}
$browserSetupArgs = @("--install")
if (-not $env:PI_CODING_AGENT_DIR) { $browserSetupArgs += @("--pi-home", $PiHome) }
if ($AttachCdpPort) { $browserSetupArgs += @("--attach-cdp-port", $AttachCdpPort) }
& node (Join-Path $RolePackRoot "scripts\browser-setup.mjs") @browserSetupArgs
if ($LASTEXITCODE -ne 0) {
  throw "agent-browser setup failed with exit code $LASTEXITCODE"
}

# Claude Code side. Skipped (not failed) when claude is not installed: a
# pi-only host is a supported configuration.
$claudeSetupStatus = "skipped (claude CLI not found)"
if (Get-Command claude -ErrorAction SilentlyContinue) {
  # Point the hook/MCP registrations at the INSTALLED copies, so moving or
  # deleting this checkout cannot break a configured Claude agent.
  $env:PASEO_TEAM_HOOK_SCRIPT = (Join-Path $teamScriptsDir "claude-hook.mjs")
  $env:PASEO_TEAM_MCP_SCRIPT  = (Join-Path $teamScriptsDir "claude-team-mcp.mjs")
  $env:PASEO_TEAM_POLICY_DIR  = $policyCoreTarget
  & node (Join-Path $RolePackRoot "scripts\claude-setup.mjs") --install
  if ($LASTEXITCODE -ne 0) {
    throw "claude setup failed with exit code $LASTEXITCODE"
  }
  $claudeSetupStatus = "installed (hooks + paseo-team MCP server)"
}

Write-Host ""
Write-Host "[paseo-team] Installed:"
Write-Host "  extension -> $extDir\paseo-team-policy.ts"
Write-Host "  prompts   -> $promptDir"
Write-Host "  lead skill -> $skillDir"
Write-Host "  OCR skill  -> $ocrSkillDir"
Write-Host "  support   -> $teamScriptsDir"
Write-Host "  policy    -> $policyCoreTarget (shared core, both runtimes)"
Write-Host "  claude    -> $claudeSetupStatus"
$env:PASEO_TEAM_SCRIPTS_DIR = $teamScriptsDir
Write-Host "  support env -> PASEO_TEAM_SCRIPTS_DIR=$teamScriptsDir (current process only)"
Write-Host "  support default -> `$env:PI_CODING_AGENT_DIR\extensions\paseo-team-scripts or `$env:USERPROFILE\.pi\agent\extensions\paseo-team-scripts"
Write-Host "  env override is optional; no user-profile mutation is required"
Write-Host ""
Write-Host "Next steps:"
Write-Host "  1. The installer checked/installed OCR (capability-probed; >= v1.8.10 kept as-is, pinned v1.9.2 when repairing), agent-browser CLI, Chrome runtime, skill and Pi MCP config."
Write-Host "  2. Verify OCR if needed: Get-Command ocr; ocr version"
Write-Host "  3. Install the MCP adapter (PINNED version - Paseo tools depend on it):"
Write-Host "     pi install npm:pi-mcp-adapter@2.19.0"
Write-Host "  4. Merge config/paseo.providers.example.json into ~/.paseo/config.json"
Write-Host "     (agents.providers.pi-* + claude-* + daemon.mcp.injectIntoAgents: true)."
Write-Host "     Regenerate the claude-* block any time with:"
Write-Host "       node `"$(Join-Path $RolePackRoot 'scripts\claude-setup.mjs')`" --print-providers"
Write-Host "  5. Copy config/model-routing.example.json to ~/.paseo-pi-team/model-routing.local.json"
Write-Host "     and fill in REAL model IDs from: paseo provider models pi-peer --json"
Write-Host "     Cross-host controller: also copy config/cluster-routing.example.json to"
Write-Host "     ~/.paseo-pi-team/cluster-routing.local.json (endpoint values live in env)"
Write-Host "  6. Restart the Paseo daemon (kills running agents - do it when ready)."
Write-Host "  7. In pi, run /reload to load the new extension, then /team-role."
Write-Host "  8. Verify host readiness (repo-root independent):"
Write-Host "     node `"$(Join-Path $RolePackRoot 'scripts\preflight.mjs')`""

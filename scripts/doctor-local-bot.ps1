param(
  [switch]$RequireRunning
)

$ErrorActionPreference = "Stop"
$repoRoot = Split-Path -Parent $PSScriptRoot
$envPath = Join-Path $repoRoot ".env.local"
$stateRoot = Join-Path $env:LOCALAPPDATA "CodexFeishuLocal"
$secretPath = Join-Path $stateRoot "feishu-secret.dpapi"
$failures = 0
$warnings = 0

function Report([string]$State, [string]$Message) {
  $color = if ($State -eq "OK") { "Green" } elseif ($State -eq "WARN") { "Yellow" } else { "Red" }
  Write-Host "[$State] $Message" -ForegroundColor $color
  if ($State -eq "FAIL") { $script:failures += 1 }
  if ($State -eq "WARN") { $script:warnings += 1 }
}

function Read-EnvFile([string]$Path) {
  $values = @{}
  if (-not (Test-Path -LiteralPath $Path)) { return $values }
  Get-Content -Encoding UTF8 -LiteralPath $Path | ForEach-Object {
    $line = $_.Trim()
    if ($line -and -not $line.StartsWith("#") -and $line.Contains("=")) {
      $parts = $line.Split("=", 2)
      $values[$parts[0]] = $parts[1]
    }
  }
  return $values
}

Write-Host "Codex Feishu Bot - Windows doctor"

$node = Get-Command node.exe -ErrorAction SilentlyContinue
if ($node) { Report "OK" "Node.js is available." } else { Report "FAIL" "Node.js is missing." }

$pnpm = Get-Command pnpm.cmd -ErrorAction SilentlyContinue
$corepack = Get-Command corepack.cmd -ErrorAction SilentlyContinue
if ($pnpm -or $corepack) { Report "OK" "pnpm or corepack is available." } else { Report "FAIL" "pnpm/corepack is missing." }

$dist = Join-Path $repoRoot "dist\index.js"
if (Test-Path -LiteralPath $dist) { Report "OK" "Bot build exists." } else { Report "FAIL" "dist/index.js is missing; run pnpm build." }

$values = Read-EnvFile $envPath
if ($values.Count -eq 0) {
  Report "FAIL" ".env.local is missing; run configure-local-bot.ps1."
}
else {
  Report "OK" ".env.local exists."
  foreach ($name in @("FEISHU_APP_ID", "DEFAULT_WORKSPACE", "CODEX_HOME_SOURCE", "FEISHU_ALLOWED_OPEN_IDS")) {
    if ($values[$name] -and $values[$name] -notmatch "bootstrap-pending|xxx") {
      Report "OK" "$name is configured."
    }
    else {
      Report "FAIL" "$name is not configured."
    }
  }
  if ($values["DEFAULT_WORKSPACE"] -and (Test-Path -LiteralPath $values["DEFAULT_WORKSPACE"])) {
    Report "OK" "Workspace directory exists."
  }
  else {
    Report "FAIL" "Workspace directory does not exist."
  }
  if ($values["CODEX_HOME_SOURCE"] -and (Test-Path -LiteralPath (Join-Path $values["CODEX_HOME_SOURCE"] "auth.json"))) {
    Report "OK" "Codex login state exists."
  }
  else {
    Report "FAIL" "Codex auth.json was not found."
  }
}

if (Test-Path -LiteralPath $secretPath) {
  Report "OK" "Encrypted Feishu App Secret exists."
}
else {
  Report "FAIL" "Encrypted Feishu App Secret is missing."
}

$healthOk = $false
try {
  $health = Invoke-RestMethod -Uri "http://127.0.0.1:3100/health" -TimeoutSec 3
  $healthOk = $null -ne $health
}
catch {
  $healthOk = $false
}
if ($healthOk) {
  Report "OK" "Local bot health endpoint responds."
}
elseif ($RequireRunning) {
  Report "FAIL" "Local bot is not responding on port 3100."
}
else {
  Report "WARN" "Local bot is not running; configuration checks still completed."
}

Write-Host ""
Write-Host "Result: $failures failure(s), $warnings warning(s)."
if ($failures -gt 0) { exit 1 }
exit 0

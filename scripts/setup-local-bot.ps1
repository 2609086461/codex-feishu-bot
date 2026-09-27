param(
  [Parameter(Mandatory = $true)]
  [string]$AppId,
  [Parameter(Mandatory = $true)]
  [string]$AllowedOpenId,
  [string]$Workspace = "",
  [string]$CodexHomeSource = "",
  [switch]$InstallAutoStart
)

$ErrorActionPreference = "Stop"
$repoRoot = Split-Path -Parent $PSScriptRoot
Set-Location -LiteralPath $repoRoot

if (-not (Get-Command node.exe -ErrorAction SilentlyContinue)) {
  throw "Node.js is missing. Install the current Node.js LTS release first."
}
$pnpm = Get-Command pnpm.cmd -ErrorAction SilentlyContinue
$corepack = Get-Command corepack.cmd -ErrorAction SilentlyContinue
if (-not $pnpm -and -not $corepack) {
  throw "pnpm/corepack is missing. Install the current Node.js LTS release first."
}

function Invoke-Pnpm([string[]]$Arguments) {
  if ($pnpm) { & $pnpm.Source @Arguments }
  else { & $corepack.Source pnpm @Arguments }
  if ($LASTEXITCODE -ne 0) { throw "pnpm $($Arguments -join ' ') failed." }
}

Write-Host "[1/5] Installing dependencies..."
Invoke-Pnpm -Arguments @("install", "--frozen-lockfile")

Write-Host "[2/5] Running tests and building..."
Invoke-Pnpm -Arguments @("typecheck")
Invoke-Pnpm -Arguments @("test")
Invoke-Pnpm -Arguments @("build")

Write-Host "[3/5] Creating local configuration..."
$configureArgs = @{ AppId = $AppId; AllowedOpenId = $AllowedOpenId }
if ($Workspace) { $configureArgs["Workspace"] = $Workspace }
if ($CodexHomeSource) { $configureArgs["CodexHomeSource"] = $CodexHomeSource }
& (Join-Path $PSScriptRoot "configure-local-bot.ps1") @configureArgs

Write-Host "[4/5] Installing or starting the bot..."
if ($InstallAutoStart) {
  & (Join-Path $PSScriptRoot "install-local-bot-task.ps1")
}
else {
  $powerShell = "$env:SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe"
  $background = Join-Path $PSScriptRoot "start-local-bot-background.ps1"
  $arguments = "-NoProfile -ExecutionPolicy Bypass -File `"$background`""
  Start-Process -FilePath $powerShell -ArgumentList $arguments -WindowStyle Hidden | Out-Null
}

Write-Host "[5/5] Waiting for health check..."
$ready = $false
for ($attempt = 0; $attempt -lt 20; $attempt += 1) {
  Start-Sleep -Seconds 1
  try {
    Invoke-RestMethod -Uri "http://127.0.0.1:3100/health" -TimeoutSec 2 | Out-Null
    $ready = $true
    break
  }
  catch { }
}

& (Join-Path $PSScriptRoot "doctor-local-bot.ps1") -RequireRunning
if (-not $ready) { throw "The bot did not become healthy within 20 seconds." }

Write-Host ""
Write-Host "Setup completed. Send a private message to the bot in Feishu for final verification."

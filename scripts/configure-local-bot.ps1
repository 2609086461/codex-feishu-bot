param(
  [Parameter(Mandatory = $true)]
  [string]$AppId,
  [string]$AllowedOpenId = "bootstrap-pending",
  [string]$Workspace = "",
  [string]$CodexHomeSource = ""
)

$ErrorActionPreference = "Stop"
$repoRoot = Split-Path -Parent $PSScriptRoot
$dataRoot = Join-Path $env:LOCALAPPDATA "CodexFeishuLocal"
$secretPath = Join-Path $dataRoot "feishu-secret.dpapi"
$envPath = Join-Path $repoRoot ".env.local"
$workspace = if ($Workspace) {
  [System.IO.Path]::GetFullPath($Workspace)
}
else {
  Join-Path $env:USERPROFILE "CodexWorkspace"
}
$codexHomeSource = if ($CodexHomeSource) {
  [System.IO.Path]::GetFullPath($CodexHomeSource)
}
else {
  Join-Path $env:USERPROFILE ".codex"
}
$codexHome = Join-Path $dataRoot "codex-home"
$desktopCodexBins = Get-ChildItem `
  -LiteralPath (Join-Path $env:LOCALAPPDATA "OpenAI\Codex\bin") `
  -Filter codex.exe `
  -File `
  -Recurse `
  -ErrorAction SilentlyContinue |
  Sort-Object LastWriteTime -Descending
$codexCommand = if ($desktopCodexBins) {
  $desktopCodexBins[0].FullName
}
else {
  (Get-Command codex.exe -ErrorAction Stop).Source
}

New-Item -ItemType Directory -Force -Path $dataRoot | Out-Null
New-Item -ItemType Directory -Force -Path (Join-Path $dataRoot "artifacts") | Out-Null
New-Item -ItemType Directory -Force -Path $workspace | Out-Null

if (-not (Test-Path -LiteralPath (Join-Path $codexHomeSource "auth.json"))) {
  throw "Codex login was not found at $codexHomeSource. Sign in to Codex first or pass -CodexHomeSource."
}

$secret = Read-Host "Feishu App Secret" -AsSecureString
$secret | ConvertFrom-SecureString | Set-Content -Encoding ASCII -LiteralPath $secretPath

$lines = @(
  "HOST=127.0.0.1"
  "PORT=3100"
  "LOG_LEVEL=warn"
  "DEFAULT_WORKSPACE=$workspace"
  "CODEX_ARTIFACTS_DIR=$dataRoot\artifacts"
  "RUNTIME_STATE_FILE=$dataRoot\runtime-state.json"
  "RUNTIME_STATE_DEBOUNCE_MS=3000"
  "LIVE_UPDATE_DEBOUNCE_MS=1800"
  "CODEX_HOME=$codexHome"
  "CODEX_HOME_SOURCE=$codexHomeSource"
  "CODEX_MODE=app-server"
  "CODEX_APP_SERVER_COMMAND=$codexCommand"
  "CODEX_APP_SERVER_ARGS=app-server"
  "CODEX_APP_SERVER_MANAGED=true"
  "CODEX_APP_SERVER_LISTEN_URL=ws://127.0.0.1:4600"
  "CODEX_APP_SERVER_MODEL=auto"
  "CODEX_APP_SERVER_APPROVAL_POLICY=never"
  "CODEX_APP_SERVER_SANDBOX=danger-full-access"
  "FEISHU_PROVIDER=sdk"
  "FEISHU_TRANSPORT=websocket"
  "FEISHU_DOMAIN=feishu"
  "FEISHU_APP_ID=$AppId"
  "FEISHU_ALLOWED_OPEN_IDS=$AllowedOpenId"
  "FEISHU_ALLOW_GROUP_MESSAGES=false"
)
$lines | Set-Content -Encoding UTF8 -LiteralPath $envPath

Write-Host "Local bot configuration created."
Write-Host "Environment: $envPath"
Write-Host "Encrypted secret: $secretPath"
Write-Host "Workspace: $workspace"
Write-Host "Codex home source: $codexHomeSource"

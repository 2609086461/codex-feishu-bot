param(
  [Parameter(Mandatory = $true)]
  [string]$AppId,
  [string]$AllowedOpenId = "bootstrap-pending"
)

$ErrorActionPreference = "Stop"
$repoRoot = Split-Path -Parent $PSScriptRoot
$dataRoot = Join-Path $env:LOCALAPPDATA "CodexFeishuLocal"
$secretPath = Join-Path $dataRoot "feishu-secret.dpapi"
$envPath = Join-Path $repoRoot ".env.local"
$workspace = "C:\Users\cai\Desktop\linux"
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
  "CODEX_HOME_SOURCE=$env:USERPROFILE\.codex"
  "CODEX_MODE=app-server"
  "CODEX_APP_SERVER_COMMAND=$codexCommand"
  "CODEX_APP_SERVER_ARGS=app-server"
  "CODEX_APP_SERVER_MANAGED=true"
  "CODEX_APP_SERVER_LISTEN_URL=ws://127.0.0.1:4600"
  "CODEX_APP_SERVER_MODEL=gpt-5.6-luna"
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

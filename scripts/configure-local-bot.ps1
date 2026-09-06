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
$codexCommand = (Get-Command codex.exe -ErrorAction Stop).Source
$workspace = "C:\Users\cai\Desktop\linux"

New-Item -ItemType Directory -Force -Path $dataRoot | Out-Null
New-Item -ItemType Directory -Force -Path (Join-Path $dataRoot "artifacts") | Out-Null

$secret = Read-Host "Feishu App Secret" -AsSecureString
$secret | ConvertFrom-SecureString | Set-Content -Encoding ASCII -LiteralPath $secretPath

$lines = @(
  "HOST=127.0.0.1"
  "PORT=3100"
  "DEFAULT_WORKSPACE=$workspace"
  "CODEX_ARTIFACTS_DIR=$dataRoot\artifacts"
  "RUNTIME_STATE_FILE=$dataRoot\runtime-state.json"
  "LIVE_UPDATE_DEBOUNCE_MS=1200"
  "CODEX_MODE=app-server"
  "CODEX_APP_SERVER_COMMAND=$codexCommand"
  "CODEX_APP_SERVER_ARGS=app-server"
  "CODEX_APP_SERVER_MANAGED=true"
  "CODEX_APP_SERVER_LISTEN_URL=ws://127.0.0.1:4600"
  "CODEX_APP_SERVER_MODEL=gpt-5.4-mini"
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

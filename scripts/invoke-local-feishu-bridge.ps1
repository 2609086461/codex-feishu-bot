param(
  [Parameter(ValueFromRemainingArguments = $true)]
  [string[]]$BridgeArgs
)

$ErrorActionPreference = "Stop"
$repoRoot = Split-Path -Parent $PSScriptRoot
$envPath = Join-Path $repoRoot ".env.local"
$secretPath = Join-Path $env:LOCALAPPDATA "CodexFeishuLocal\feishu-secret.dpapi"
$bridgePath = Join-Path $PSScriptRoot "feishu-bridge.mjs"

if (-not (Test-Path -LiteralPath $envPath)) {
  throw "Missing local bot configuration: $envPath"
}
if (-not (Test-Path -LiteralPath $secretPath)) {
  throw "Missing encrypted Feishu secret: $secretPath"
}

Get-Content -Encoding UTF8 -LiteralPath $envPath | ForEach-Object {
  $line = $_.Trim()
  if (-not $line -or $line.StartsWith("#")) {
    return
  }
  $parts = $line.Split("=", 2)
  if ($parts.Count -eq 2 -and $parts[0] -in @("FEISHU_APP_ID", "FEISHU_DOMAIN")) {
    [Environment]::SetEnvironmentVariable($parts[0], $parts[1], "Process")
  }
}

$encryptedSecret = (Get-Content -Raw -Encoding ASCII -LiteralPath $secretPath).Trim()
$secureSecret = $encryptedSecret | ConvertTo-SecureString
$secretPtr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secureSecret)
try {
  $plainSecret = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($secretPtr)
  [Environment]::SetEnvironmentVariable("FEISHU_APP_SECRET", $plainSecret, "Process")
  & node $bridgePath @BridgeArgs
  exit $LASTEXITCODE
}
finally {
  [Environment]::SetEnvironmentVariable("FEISHU_APP_SECRET", $null, "Process")
  if ($secretPtr -ne [IntPtr]::Zero) {
    [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($secretPtr)
  }
}

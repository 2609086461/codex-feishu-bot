$ErrorActionPreference = "Stop"
$repoRoot = Split-Path -Parent $PSScriptRoot
$envPath = Join-Path $repoRoot ".env.local"
$secretPath = Join-Path $env:LOCALAPPDATA "CodexFeishuLocal\feishu-secret.dpapi"

if (-not (Test-Path -LiteralPath $envPath)) {
  throw "Missing .env.local. Run scripts/configure-local-bot.ps1 first."
}
if (-not (Test-Path -LiteralPath $secretPath)) {
  throw "Missing encrypted Feishu secret. Run scripts/configure-local-bot.ps1 first."
}

Get-Content -Encoding UTF8 -LiteralPath $envPath | ForEach-Object {
  $line = $_.Trim()
  if (-not $line -or $line.StartsWith("#")) {
    return
  }
  $parts = $line.Split("=", 2)
  if ($parts.Count -eq 2) {
    [Environment]::SetEnvironmentVariable($parts[0], $parts[1], "Process")
  }
}

$desktopCodexBins = Get-ChildItem `
  -LiteralPath (Join-Path $env:LOCALAPPDATA "OpenAI\Codex\bin") `
  -Filter codex.exe `
  -File `
  -Recurse `
  -ErrorAction SilentlyContinue |
  Sort-Object LastWriteTime -Descending
if ($desktopCodexBins) {
  [Environment]::SetEnvironmentVariable(
    "CODEX_APP_SERVER_COMMAND",
    $desktopCodexBins[0].FullName,
    "Process"
  )
}

$codexHome = [Environment]::GetEnvironmentVariable("CODEX_HOME", "Process")
$codexHomeSource = [Environment]::GetEnvironmentVariable("CODEX_HOME_SOURCE", "Process")
if ($codexHome -and $codexHomeSource) {
  $python = Get-Command python.exe -ErrorAction SilentlyContinue
  if (-not $python) {
    $python = Get-Command py.exe -ErrorAction Stop
  }
  $initializer = Join-Path $PSScriptRoot "initialize-local-codex-home.py"
  $pythonArgs = @($initializer, "--source", $codexHomeSource, "--target", $codexHome)
  if ($python.Name -ieq "py.exe") {
    $pythonArgs = @("-3") + $pythonArgs
  }
  & $python.Source @pythonArgs
  if ($LASTEXITCODE -ne 0) {
    throw "Failed to initialize isolated Codex home."
  }
}

$encryptedSecret = (Get-Content -Raw -Encoding ASCII -LiteralPath $secretPath).Trim()
$secureSecret = $encryptedSecret | ConvertTo-SecureString
$secretPtr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secureSecret)
try {
  $plainSecret = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($secretPtr)
  [Environment]::SetEnvironmentVariable("FEISHU_APP_SECRET", $plainSecret, "Process")
  Set-Location -LiteralPath $repoRoot
  & node .\dist\index.js
  exit $LASTEXITCODE
}
finally {
  [Environment]::SetEnvironmentVariable("FEISHU_APP_SECRET", $null, "Process")
  if ($secretPtr -ne [IntPtr]::Zero) {
    [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($secretPtr)
  }
}

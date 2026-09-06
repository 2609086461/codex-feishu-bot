$ErrorActionPreference = "Stop"

$stateDir = Join-Path $env:LOCALAPPDATA "CodexFeishuLocal"
$stdoutPath = Join-Path $stateDir "local-bot.stdout.log"
$stderrPath = Join-Path $stateDir "local-bot.stderr.log"
$startScript = Join-Path $PSScriptRoot "start-local-bot.ps1"
$powerShell = "$env:SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe"
$arguments = @(
  "-NoProfile"
  "-NonInteractive"
  "-ExecutionPolicy"
  "Bypass"
  "-File"
  $startScript
)

New-Item -ItemType Directory -Force -Path $stateDir | Out-Null
$process = Start-Process `
  -FilePath $powerShell `
  -ArgumentList $arguments `
  -WindowStyle Hidden `
  -RedirectStandardOutput $stdoutPath `
  -RedirectStandardError $stderrPath `
  -PassThru `
  -Wait

exit $process.ExitCode

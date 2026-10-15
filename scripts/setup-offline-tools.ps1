param([switch]$Offline)
$ErrorActionPreference = 'Stop'
$arguments = @('--use-env-proxy', (Join-Path $PSScriptRoot 'third-party/install.mjs'))
if ($Offline) { $arguments += '--offline' }
& node @arguments
if ($LASTEXITCODE -ne 0) { throw 'Published third-party dependency setup failed' }
$project = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')).Path
Copy-Item -Path (Join-Path $project 'resources/licenses/*') -Destination (Join-Path $project 'bin/licenses') -Force
Write-Host 'Published third-party dependencies verified and ready; no source compilation.'

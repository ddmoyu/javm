$ErrorActionPreference = 'Stop'
if ($env:GITHUB_ACTIONS -ne 'true') { throw 'Installer smoke tests require an isolated GitHub runner account.' }
$project = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')).Path
$version = (Get-Content -LiteralPath (Join-Path $project 'package.json') -Raw | ConvertFrom-Json).version
$bundle = Get-Content -LiteralPath (Join-Path $project 'dist/offline/latest.json') -Raw | ConvertFrom-Json
$manifest = Get-Content -LiteralPath $bundle.manifest -Raw | ConvertFrom-Json
$installer = Join-Path $project "dist/release/JAVM-$version-windows-x64-setup.exe"
$target = Join-Path $project '.tmp/installer-safe/安装 空格'
$data = Join-Path $env:APPDATA 'JAVM/alpha-installer-safe.txt'
New-Item -ItemType Directory -Force -Path (Split-Path -Parent $target), (Split-Path -Parent $data) | Out-Null
if (Test-Path -LiteralPath $target) { throw 'Installer fixture must start empty.' }
[IO.File]::WriteAllText($data, 'SAFE_INSTALLER_DATA')
function Run-Installer([string]$File, [string[]]$Arguments) {
    $process = Start-Process -FilePath $File -ArgumentList $Arguments -Wait -PassThru -WindowStyle Hidden
    if ($process.ExitCode -ne 0) { throw "Installer failed: $($process.ExitCode)" }
}
$arguments = @('/VERYSILENT', '/SUPPRESSMSGBOXES', '/NORESTART', '/TASKS=protocol', ('/DIR="' + $target + '"'))
Run-Installer $installer $arguments
foreach ($entry in $manifest.files) {
    $file = Join-Path $target $entry.path
    if ((Get-FileHash -LiteralPath $file -Algorithm SHA256).Hash.ToLowerInvariant() -ne $entry.sha256) { throw "Installed file differs from portable bundle: $($entry.path)" }
}
$sentinel = Join-Path $target 'safe-user-file.txt'
[IO.File]::WriteAllText($sentinel, 'SAFE_USER_FILE')
Run-Installer $installer $arguments
if ([IO.File]::ReadAllText($sentinel) -ne 'SAFE_USER_FILE') { throw 'Upgrade changed user files.' }
$commandKey = 'HKCU:\Software\Classes\javm\shell\open\command'
$expectedCommand = '"' + (Join-Path $target 'JAVM.exe') + '" "%1"'
if ((Get-Item -LiteralPath $commandKey).GetValue('') -ne $expectedCommand) { throw 'Protocol registration mismatch.' }
Run-Installer (Join-Path $target 'unins000.exe') @('/VERYSILENT', '/SUPPRESSMSGBOXES', '/NORESTART')
if ((Test-Path -LiteralPath (Join-Path $target 'JAVM.exe')) -or (Test-Path -LiteralPath $commandKey)) { throw 'Uninstall left application files or its protocol registration.' }
if ([IO.File]::ReadAllText($sentinel) -ne 'SAFE_USER_FILE' -or [IO.File]::ReadAllText($data) -ne 'SAFE_INSTALLER_DATA') { throw 'Uninstall changed user data.' }
Write-Output 'Installer: install, payload hashes, upgrade, protocol and uninstall data retention passed. No production application was launched.'

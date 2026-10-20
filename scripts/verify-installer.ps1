param(
    [string]$ReceiptPath,
    [string]$BundlePath,
    [string]$ReportPath
)
$ErrorActionPreference = 'Stop'
$projectRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')).Path
if (!$ReceiptPath) { $ReceiptPath = Join-Path $projectRoot 'build/installer/latest.json' }
if (!$BundlePath) { $BundlePath = Join-Path $projectRoot 'dist/offline/latest.json' }
if (!$ReportPath) { $ReportPath = Join-Path $projectRoot '.tmp/installer-validation.json' }
$receipt = Get-Content -LiteralPath $ReceiptPath -Raw -Encoding UTF8 | ConvertFrom-Json
$bundle = Get-Content -LiteralPath $BundlePath -Raw -Encoding UTF8 | ConvertFrom-Json
if ($receipt.appId -notmatch '^net\.ddmoyu\.javm\.neutralino(?:\.validation\.[a-f0-9-]+)?$') {
    throw 'Unexpected installer AppId'
}
if ((Get-FileHash -LiteralPath $receipt.installer -Algorithm SHA256).Hash -ne $receipt.sha256 -or
    (Get-FileHash -LiteralPath $bundle.manifest -Algorithm SHA256).Hash -ne $receipt.manifestSha256 -or
    $receipt.manifestSha256 -ne $bundle.manifestSha256 -or
    $receipt.portableArchiveSha256 -ne $bundle.sha256) { throw 'Installer inputs changed' }
$manifest = Get-Content -LiteralPath $bundle.manifest -Raw -Encoding UTF8 | ConvertFrom-Json
if ($manifest.version -ne $receipt.version -or !$manifest.files.Count) { throw 'Installer version or payload mismatch' }
$registryPath = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\' + $receipt.appId + '_is1'
# Never replace an existing user installation during validation.
if (Test-Path -LiteralPath $registryPath) { throw 'An installation with this AppId already exists; use an isolated CI runner' }
$identifier = [Guid]::NewGuid().ToString()
$base = Join-Path $projectRoot ('.tmp/installer-' + $identifier)
$installDirectory = Join-Path $base 'installed app'
$group = if ($receipt.group) { $receipt.group } else { 'JAVM' }
if ($group -notmatch '^JAVM(?: validation [a-f0-9-]+)?$') { throw 'Unexpected Start menu group' }
$shortcut = Join-Path ([Environment]::GetFolderPath('Programs')) ($group + '\JAVM.lnk')
if (Test-Path -LiteralPath $shortcut) { throw 'Start menu shortcut already exists; use an isolated CI runner' }
$marker = Join-Path $installDirectory 'user-file-to-preserve.txt'
$uninstaller = Join-Path $installDirectory 'unins000.exe'
New-Item -ItemType Directory -Path $base -Force | Out-Null
New-Item -ItemType Directory -Path (Split-Path -Parent $ReportPath) -Force | Out-Null
Remove-Item -LiteralPath $ReportPath -Force -ErrorAction SilentlyContinue
$results = @()
$uninstalled = $false
function Invoke-Installer([string]$File, [string[]]$Arguments) {
    $process = Start-Process -FilePath $File -ArgumentList $Arguments -PassThru -WindowStyle Hidden
    if (!$process.WaitForExit(120000)) {
        & "$env:SystemRoot\System32\taskkill.exe" /PID $process.Id /T /F | Out-Null
        throw 'Installer validation timed out'
    }
    $process.Refresh()
    if ($process.ExitCode -ne 0) { throw "Installer returned exit code $($process.ExitCode)" }
}
function Assert-Payload {
    foreach ($file in $manifest.files) {
        if ($file.path -match '(^/|\\|:|(^|/)\.\.?(/|$))') { throw 'Invalid payload path' }
        $target = [IO.Path]::GetFullPath((Join-Path $installDirectory $file.path))
        if (!$target.StartsWith($installDirectory + '\', [StringComparison]::OrdinalIgnoreCase)) { throw 'Payload path escaped installation' }
        if ((Get-Item -LiteralPath $target).Length -ne $file.bytes -or
            (Get-FileHash -LiteralPath $target -Algorithm SHA256).Hash -ne $file.sha256) {
            throw "Installed payload differs from portable package: $($file.path)"
        }
    }
    if (!(Test-Path -LiteralPath (Join-Path $installDirectory 'THIRD-PARTY-NOTICES.txt')) -or
        !(Test-Path -LiteralPath $shortcut) -or !(Test-Path -LiteralPath $registryPath)) {
        throw 'Installer did not create notices, Start menu shortcut or uninstall registration'
    }
    $shell = New-Object -ComObject WScript.Shell
    $link = $shell.CreateShortcut($shortcut)
    if ($link.TargetPath -ne (Join-Path $installDirectory 'JAVM.exe') -or $link.WorkingDirectory -ne $installDirectory) {
        throw 'Start menu shortcut target or working directory is incorrect'
    }
}
try {
    $arguments = @('/VERYSILENT', '/SUPPRESSMSGBOXES', '/NORESTART', '/SP-',
        ('/DIR="' + $installDirectory + '"'),
        '/MERGETASKS="!desktopicon"', ('/LOG="' + (Join-Path $base 'install.log') + '"'))
    Invoke-Installer $receipt.installer $arguments
    Assert-Payload
    $results += @{ name = 'Installed files match portable manifest; shortcut and uninstaller registered'; ok = $true }
    [IO.File]::WriteAllText($marker, $identifier)
    [IO.File]::WriteAllText((Join-Path $installDirectory 'JAVM.exe'), 'Safe stale runtime fixture; never execute')
    # 模拟同一路径覆盖安装；任何安装后的启动项都被 skipifsilent 禁用。
    Invoke-Installer $receipt.installer $arguments
    Assert-Payload
    if ([IO.File]::ReadAllText($marker) -ne $identifier) { throw 'Reinstall changed user data' }
    $results += @{ name = 'Reinstall preserves user files and replaces the complete runtime'; ok = $true }
    Invoke-Installer $uninstaller @('/VERYSILENT', '/SUPPRESSMSGBOXES', '/NORESTART', ('/LOG="' + (Join-Path $base 'uninstall.log') + '"'))
    $uninstalled = $true
    foreach ($file in $manifest.files) {
        if (Test-Path -LiteralPath (Join-Path $installDirectory $file.path)) { throw 'Uninstall left a runtime file' }
    }
    if ((Test-Path -LiteralPath $registryPath) -or (Test-Path -LiteralPath $shortcut) -or
        [IO.File]::ReadAllText($marker) -ne $identifier) { throw 'Uninstall cleanup or user-file preservation failed' }
    $results += @{ name = 'Uninstall removes runtime and shortcuts while preserving user files'; ok = $true }
    $report = @{
        version = $receipt.version
        installerSha256 = $receipt.sha256
        manifestSha256 = $receipt.manifestSha256
        results = $results
    } | ConvertTo-Json -Depth 8
    [IO.File]::WriteAllText($ReportPath, $report + "`n", [Text.UTF8Encoding]::new($false))
    Write-Output "Installer validation passed: $ReportPath"
}
finally {
    if (!$uninstalled -and (Test-Path -LiteralPath $uninstaller)) {
        Invoke-Installer $uninstaller @('/VERYSILENT', '/SUPPRESSMSGBOXES', '/NORESTART')
    }
}

param([switch]$ReplaceExisting, [string]$FfmpegDirectory = '')
$ErrorActionPreference = 'Stop'
function Get-DownloadSha256([string]$FilePath) {
    $stream = [IO.File]::OpenRead($FilePath)
    $digest = [Security.Cryptography.SHA256]::Create()
    try { return ([BitConverter]::ToString($digest.ComputeHash($stream))).Replace('-', '').ToLowerInvariant() }
    finally { $digest.Dispose(); $stream.Dispose() }
}
$javmRoot = Split-Path -Parent $PSScriptRoot
$toolsDirectory = Join-Path $javmRoot 'bin/tools'
$temporaryDirectory = Join-Path $javmRoot '.tmp/download-tool-setup'
New-Item -ItemType Directory -Path $toolsDirectory, $temporaryDirectory -Force | Out-Null
$downloader = Join-Path $toolsDirectory 'N_m3u8DL-RE.exe'
if ($ReplaceExisting -or !(Test-Path -LiteralPath $downloader)) {
    $archive = Join-Path $temporaryDirectory 'N_m3u8DL-RE_v0.6.0-beta_win-x64_20260629.zip'
    $expected = '3825fd42ee502f98a9378f6fdddb2f7822709f521806214f466db6935c950f1a'
    if (!(Test-Path -LiteralPath $archive) -or (Get-DownloadSha256 $archive) -ne $expected) {
        Invoke-WebRequest -Uri 'https://github.com/nilaoda/N_m3u8DL-RE/releases/download/v0.6.0-beta/N_m3u8DL-RE_v0.6.0-beta_win-x64_20260629.zip' -OutFile $archive
    }
    if ((Get-DownloadSha256 $archive) -ne $expected) { throw 'Downloader checksum mismatch. Installation aborted.' }
    $expanded = Join-Path $temporaryDirectory ('expanded-' + [Guid]::NewGuid().ToString('N'))
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    [IO.Compression.ZipFile]::ExtractToDirectory($archive, $expanded)
    $binary = Get-ChildItem -LiteralPath $expanded -Filter 'N_m3u8DL-RE.exe' -File -Recurse | Select-Object -First 1
    if (!$binary) { throw 'Downloader executable missing from archive.' }
    Copy-Item -LiteralPath $binary.FullName -Destination $downloader -Force
    Get-ChildItem -LiteralPath $expanded -File -Recurse | Where-Object { $_.Name -match '^(LICENSE|COPYING|README)' } | ForEach-Object {
        Copy-Item -LiteralPath $_.FullName -Destination (Join-Path $toolsDirectory ('N_m3u8DL-RE-' + $_.Name)) -Force
    }
}
& $downloader --version
if ($LASTEXITCODE -ne 0) { throw 'Downloader failed to start.' }
Copy-Item -LiteralPath (Join-Path $javmRoot 'resources/licenses/N_m3u8DL-RE.txt') -Destination (Join-Path $toolsDirectory 'N_m3u8DL-RE-LICENSE.txt') -Force
if ($FfmpegDirectory) {
    foreach ($toolName in @('ffmpeg.exe')) {
        $source = Join-Path $FfmpegDirectory $toolName
        if (!(Test-Path -LiteralPath $source -PathType Leaf)) { throw "Tool not found: $source" }
        $destination = Join-Path $toolsDirectory $toolName
        if ([IO.Path]::GetFullPath($source) -ne [IO.Path]::GetFullPath($destination)) {
            Copy-Item -LiteralPath $source -Destination $destination -Force
        }
    }
}
Write-Host 'Downloader ready. Include FFmpeg in bin/tools before packaging; media inspection uses the bundled MediaInfo extension.'

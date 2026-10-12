param([switch]$Offline)
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$project = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')).Path
$cache = Join-Path $project '.tmp/offline-dependencies'
$toolsDir = Join-Path $project 'bin/tools'
$licenses = Join-Path $project 'bin/licenses'
$dependencies = Get-Content -LiteralPath (Join-Path $PSScriptRoot 'offline-dependencies.json') -Raw | ConvertFrom-Json
New-Item -ItemType Directory -Force -Path $cache, $toolsDir, $licenses | Out-Null
Add-Type -AssemblyName System.IO.Compression.FileSystem
function Sha256([string]$FilePath) {
    $stream = [IO.File]::OpenRead($FilePath)
    $algorithm = [Security.Cryptography.SHA256]::Create()
    try { return ([BitConverter]::ToString($algorithm.ComputeHash($stream))).Replace('-', '').ToLowerInvariant() }
    finally { $stream.Dispose(); $algorithm.Dispose() }
}
function Prepare([string]$Name) {
    $dep = $dependencies.$Name
    $archive = Join-Path $cache $dep.file
    if (!(Test-Path -LiteralPath $archive) -or (Sha256 $archive) -ne $dep.sha256) {
        if ($Offline) { throw "Verified dependency is not cached: $Name" }
        $partial = $archive + '.' + [Guid]::NewGuid().ToString('N') + '.partial'
        $downloaded = $false
        foreach ($url in @($dep.url) + @($dep.mirrors)) {
            if (!$url) { continue }
            & "$env:SystemRoot\System32\curl.exe" --fail --location --silent --show-error --connect-timeout 15 --max-time 900 --output $partial $url
            if ($LASTEXITCODE -eq 0) { $downloaded = $true; break }
        }
        if (!$downloaded) { throw "Dependency download failed: $Name" }
        if ((Sha256 $partial) -ne $dep.sha256) { throw "Dependency checksum mismatch: $Name" }
        Move-Item -LiteralPath $partial -Destination $archive -Force
    }
    $expanded = Join-Path $cache ($Name + '-' + $dep.sha256.Substring(0, 12))
    $ready = Join-Path $expanded '.complete'
    if (!(Test-Path -LiteralPath $ready)) {
        # A failed extraction is retained for diagnosis; never reuse partial output.
        $stage = $expanded + '-' + [Guid]::NewGuid().ToString('N')
        New-Item -ItemType Directory -Path $stage | Out-Null
        if ($dep.file.EndsWith('.tar.xz') -or $dep.file.EndsWith('.tar.zst')) {
            & "$env:SystemRoot\System32\tar.exe" -xf $archive -C $stage
            if ($LASTEXITCODE -ne 0) { throw "Source extraction failed: $Name" }
        } else { [IO.Compression.ZipFile]::ExtractToDirectory($archive, $stage) }
        [IO.File]::WriteAllText((Join-Path $stage '.complete'), $dep.sha256)
        # Both paths are constructed beneath this explicit cache, with no external input.
        if ([IO.Path]::GetDirectoryName([IO.Path]::GetFullPath($stage)) -ne $cache -or
            [IO.Path]::GetDirectoryName([IO.Path]::GetFullPath($expanded)) -ne $cache) { throw 'Unsafe cache path' }
        Move-Item -LiteralPath $stage -Destination $expanded
    }
    return Join-Path $expanded $dep.directory
}
$ffmpeg = Prepare 'ffmpeg'
$reference = Prepare 'ffmpegReference'
$make = Prepare 'msysMake'
& (Join-Path $PSScriptRoot 'build-ffmpeg-lite.ps1') -SourceDirectory $ffmpeg -ReferenceDirectory $reference -MakeDirectory $make
if ($LASTEXITCODE -ne 0) { throw 'FFmpeg lite build failed' }
$curl = Prepare 'curl'
& (Join-Path $PSScriptRoot 'build-curl.ps1') -SourceDirectory $curl
if ($LASTEXITCODE -ne 0) { throw 'Unicode curl build failed' }
Copy-Item -LiteralPath (Join-Path $curl 'COPYING') -Destination (Join-Path $licenses 'curl.txt') -Force
$metaArguments = @('--use-env-proxy', (Join-Path $PSScriptRoot 'build-metatube-lite.mjs'), '--install')
if ($Offline) { $metaArguments += '--offline' }
& node @metaArguments
if ($LASTEXITCODE -ne 0) { throw 'MetaTube lite build failed' }
Copy-Item -Path (Join-Path $project 'resources/licenses/*') -Destination $licenses -Force
foreach ($entry in @(@('ffmpeg.exe','-version'), @('curl.exe','--version'))) {
    $output = & (Join-Path $toolsDir $entry[0]) $entry[1]
    if ($LASTEXITCODE -ne 0) { throw "Bundled tool failed: $($entry[0])" }
    $output | Select-Object -First 1
}
Write-Host 'Offline dependencies verified and ready.'

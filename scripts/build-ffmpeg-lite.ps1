param(
    [Parameter(Mandatory=$true)][string]$SourceDirectory,
    [Parameter(Mandatory=$true)][string]$ReferenceDirectory,
    [Parameter(Mandatory=$true)][string]$MakeDirectory
)
$ErrorActionPreference = 'Stop'
$project = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')).Path
$dependencies = Get-Content -LiteralPath (Join-Path $PSScriptRoot 'offline-dependencies.json') -Raw | ConvertFrom-Json
$profile = $dependencies.ffmpeg.profile
function Get-LiteHash([string]$FilePath) {
    $stream = [IO.File]::OpenRead($FilePath)
    $digest = [Security.Cryptography.SHA256]::Create()
    try { return ([BitConverter]::ToString($digest.ComputeHash($stream))).Replace('-', '').ToLowerInvariant() }
    finally { $stream.Dispose(); $digest.Dispose() }
}
$vswhere = Join-Path ${env:ProgramFiles(x86)} 'Microsoft Visual Studio/Installer/vswhere.exe'
$installation = & $vswhere -latest -prerelease -products '*' -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath
if (!$installation) { throw 'Visual Studio C++ tools not found' }
$vcvars = Join-Path $installation.Trim() 'VC/Auxiliary/Build/vcvars64.bat'
$compiler = Get-ChildItem -Path (Join-Path $installation.Trim() 'VC/Tools/MSVC/*/bin/Hostx64/x64/cl.exe') |
    Sort-Object { [version]$_.Directory.Parent.Parent.Parent.Name } -Descending | Select-Object -First 1
$bash = if ($env:JAVM_GIT_BASH) { $env:JAVM_GIT_BASH } else { (Get-Command bash.exe -ErrorAction Stop).Source }
if (!(Test-Path -LiteralPath (Join-Path (Split-Path -Parent $bash) 'cygpath.exe'))) {
    throw 'Git Bash is required. Set JAVM_GIT_BASH to Git/usr/bin/bash.exe (not WSL bash).'
}
$nasm = (Get-Command nasm.exe -ErrorAction Stop).Source
$make = Join-Path $MakeDirectory 'make.exe'
$script = Join-Path $PSScriptRoot 'build-ffmpeg-lite.sh'
# Immutable source/profile builds: changing any input creates a new build directory.
$inputs = [ordered]@{
    profile=$profile
    source=$dependencies.ffmpeg.sha256
    reference=$dependencies.ffmpegReference.sha256
    make=$dependencies.msysMake.sha256
    script=(Get-LiteHash $script)
    driver=(Get-LiteHash $PSCommandPath)
    compiler=(Get-LiteHash $compiler.FullName)
    nasm=(Get-LiteHash $nasm)
} | ConvertTo-Json -Compress
$digest = [Security.Cryptography.SHA256]::Create()
try { $key = ([BitConverter]::ToString($digest.ComputeHash([Text.Encoding]::UTF8.GetBytes($inputs)))).Replace('-', '').ToLowerInvariant().Substring(0, 16) }
finally { $digest.Dispose() }
$build = Join-Path $project "build/ffmpeg-lite/$key"
$ready = Join-Path $build 'verified-inputs.json'
if (!(Test-Path -LiteralPath $ready)) {
    New-Item -ItemType Directory -Force -Path $build | Out-Null
    & $env:ComSpec /d /s /c "call `"$vcvars`" >nul && `"$bash`" `"$script`" `"$SourceDirectory`" `"$ReferenceDirectory`" `"$build`" `"$make`" `"$nasm`""
    if ($LASTEXITCODE -ne 0) { throw 'FFmpeg lite build failed' }
    [IO.File]::WriteAllText($ready, $inputs)
}
$toolsDir = Join-Path $project 'bin/tools'
$licenses = Join-Path $project 'bin/licenses/ffmpeg-lite'
New-Item -ItemType Directory -Force -Path $toolsDir, $licenses | Out-Null
$binaries = @()
foreach ($name in @('ffmpeg.exe')) {
    $binary = Join-Path $build $name
    $version = (& $binary -version) -join "`n"
    if ($LASTEXITCODE -ne 0 -or $version -notmatch '--disable-everything' -or $version -notmatch '--disable-network' -or
        (Get-Item -LiteralPath $binary).Length -gt 25MB) { throw "Invalid FFmpeg lite binary: $name" }
    Copy-Item -LiteralPath $binary -Destination (Join-Path $toolsDir $name) -Force
    $binaries += @{name=$name; bytes=(Get-Item -LiteralPath $binary).Length; sha256=(Get-LiteHash $binary)}
    [IO.File]::WriteAllText((Join-Path $licenses ($name + '-version.txt')), $version)
}
# Retire only these generated outputs from the former profile; keep old release archives.
foreach ($obsolete in @((Join-Path $toolsDir 'ffprobe.exe'), (Join-Path $licenses 'ffprobe.exe-version.txt'))) {
    if (Test-Path -LiteralPath $obsolete) { Remove-Item -LiteralPath $obsolete -Force }
}
foreach ($name in @('LICENSE.md', 'COPYING.LGPLv2.1', 'COPYING.LGPLv3')) {
    Copy-Item -LiteralPath (Join-Path $SourceDirectory $name) -Destination $licenses -Force
}
Copy-Item -LiteralPath $script, $PSCommandPath -Destination $licenses -Force
Copy-Item -LiteralPath (Join-Path $ReferenceDirectory 'build-info/video-decoders.txt') -Destination (Join-Path $licenses 'reference-video-decoders.txt') -Force
Copy-Item -LiteralPath (Join-Path $build 'ffbuild/config.mak') -Destination (Join-Path $licenses 'config.mak') -Force
$receipt = @{
    profile=$profile
    source=$dependencies.ffmpeg
    reference=$dependencies.ffmpegReference
    buildInputs=($inputs | ConvertFrom-Json)
    binaries=$binaries
}
[IO.File]::WriteAllText((Join-Path $toolsDir 'ffmpeg-lite.json'), ($receipt | ConvertTo-Json -Depth 8))
Write-Host "FFmpeg lite ready: $build"

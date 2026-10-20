param([Parameter(Mandatory=$true)][ValidateSet('ffmpeg','metatube','mediainfo','curl')][string]$Component)
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$project = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '../..')).Path
$cache = Join-Path $project '.tmp/offline-dependencies'
$dependencies = Get-Content -LiteralPath (Join-Path $project 'scripts/offline-dependencies.json') -Raw | ConvertFrom-Json
New-Item -ItemType Directory -Force -Path $cache, (Join-Path $project 'bin/tools'), (Join-Path $project 'bin/licenses') | Out-Null
function Prepare([string]$Name) {
    $dep = $dependencies.$Name
    $archive = Join-Path $cache $dep.file
    if (!(Test-Path -LiteralPath $archive) -or (Get-FileHash -LiteralPath $archive -Algorithm SHA256).Hash.ToLowerInvariant() -ne $dep.sha256) {
        $partial = $archive + '.' + [Guid]::NewGuid().ToString('N') + '.partial'
        $downloaded = $false
        foreach ($url in @($dep.url) + @($dep.mirrors)) {
            if (!$url) { continue }
            & "$env:SystemRoot/System32/curl.exe" --fail --location --silent --show-error --retry 3 --connect-timeout 20 --max-time 900 --output $partial $url
            if ($LASTEXITCODE -eq 0) { $downloaded = $true; break }
        }
        if (!$downloaded -or (Get-FileHash -LiteralPath $partial -Algorithm SHA256).Hash.ToLowerInvariant() -ne $dep.sha256) { throw "Dependency download/hash failed: $Name" }
        Move-Item -LiteralPath $partial -Destination $archive -Force
    }
    $expanded = Join-Path $cache ($Name + '-' + $dep.sha256.Substring(0, 12))
    if (!(Test-Path -LiteralPath (Join-Path $expanded '.complete'))) {
        $stage = $expanded + '-' + [Guid]::NewGuid().ToString('N')
        New-Item -ItemType Directory -Path $stage | Out-Null
        & "$env:SystemRoot/System32/tar.exe" -xf $archive -C $stage
        if ($LASTEXITCODE -ne 0) { throw "Dependency extraction failed: $Name" }
        [IO.File]::WriteAllText((Join-Path $stage '.complete'), $dep.sha256)
        if ([IO.Path]::GetDirectoryName([IO.Path]::GetFullPath($stage)) -ne $cache -or [IO.Path]::GetDirectoryName([IO.Path]::GetFullPath($expanded)) -ne $cache) { throw 'Unsafe cache path' }
        Move-Item -LiteralPath $stage -Destination $expanded
    }
    if ($dep.directory) { return Join-Path $expanded $dep.directory }
    return $expanded
}
switch ($Component) {
    'metatube' {
        & node --use-env-proxy (Join-Path $project 'scripts/build-metatube-lite.mjs')
        if ($LASTEXITCODE -ne 0) { throw 'MetaTube build failed' }
        & node --disable-warning=ExperimentalWarning (Join-Path $project 'scripts/verify-metatube-lite.mjs')
        if ($LASTEXITCODE -ne 0) { throw 'MetaTube verification failed' }
    }
    'ffmpeg' {
        $source = Prepare 'ffmpeg'
        $reference = Prepare 'ffmpegReference'
        $make = Prepare 'msysMake'
        & (Join-Path $project 'scripts/build-ffmpeg-lite.ps1') -SourceDirectory $source -ReferenceDirectory $reference -MakeDirectory $make
        if ($LASTEXITCODE -ne 0) { throw 'FFmpeg build failed' }
    }
    'curl' {
        $source = Prepare 'curl'
        & (Join-Path $project 'scripts/build-curl.ps1') -SourceDirectory $source
        if ($LASTEXITCODE -ne 0) { throw 'curl build failed' }
        Copy-Item -LiteralPath (Join-Path $source 'COPYING') -Destination (Join-Path $project 'bin/licenses/curl.txt') -Force
    }
    'mediainfo' {
        $vswhere = Join-Path ${env:ProgramFiles(x86)} 'Microsoft Visual Studio/Installer/vswhere.exe'
        $installation = & $vswhere -latest -prerelease -products '*' -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath
        if (!$installation) { throw 'Visual Studio C++ tools not found' }
        $vcvars = Join-Path $installation.Trim() 'VC/Auxiliary/Build/vcvars64.bat'
        $cmakeRoot = Join-Path $installation.Trim() 'Common7/IDE/CommonExtensions/Microsoft/CMake'
        $cmake = Join-Path $cmakeRoot 'CMake/bin/cmake.exe'
        $ninja = Join-Path $cmakeRoot 'Ninja/ninja.exe'
        $source = Join-Path $PSScriptRoot 'mediainfo'
        $build = Join-Path $project 'build/third-party-build/mediainfo'
        $install = Join-Path $build 'install'
        & $env:ComSpec /d /s /c "call ""$vcvars"" >nul && ""$cmake"" -S ""$source"" -B ""$build"" -G Ninja -DCMAKE_BUILD_TYPE=Release -DCMAKE_MSVC_RUNTIME_LIBRARY=MultiThreaded -DCMAKE_MAKE_PROGRAM=""$ninja"" -DCMAKE_INSTALL_PREFIX=""$install"" && ""$cmake"" --build ""$build"" --parallel 4 && ""$cmake"" --install ""$build"""
        if ($LASTEXITCODE -ne 0) { throw 'MediaInfo build failed' }
    }
}
& node (Join-Path $PSScriptRoot 'release.mjs') pack $Component
if ($LASTEXITCODE -ne 0) { throw 'Dependency packaging failed' }

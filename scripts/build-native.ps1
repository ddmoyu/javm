param([switch]$Fresh, [switch]$Release, [switch]$PortabilityChecks, [switch]$CoreOnly, [switch]$CurlTransport, [switch]$UpdateTests)

$ErrorActionPreference = 'Stop'
$projectRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')).Path
if (($Release -and ($PortabilityChecks -or $CoreOnly -or $CurlTransport)) -or
    ($PortabilityChecks -and ($CoreOnly -or $CurlTransport)) -or ($CurlTransport -and -not $CoreOnly)) {
    throw 'Use CoreOnly with optional CurlTransport, PortabilityChecks, or Release separately.'
}
if ($Release) {
    & node (Join-Path $PSScriptRoot 'third-party/install.mjs') --offline
    if ($LASTEXITCODE -ne 0) { throw 'Published dependencies are missing or invalid. Run pnpm offline:setup first.' }
}
$vswherePath = Join-Path ${env:ProgramFiles(x86)} 'Microsoft Visual Studio\Installer\vswhere.exe'

if (-not (Test-Path -LiteralPath $vswherePath)) {
    throw 'vswhere.exe was not found. Install Visual Studio C++ build tools.'
}

$installationPath = & $vswherePath -latest -prerelease -products '*' `
    -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath
if ($LASTEXITCODE -ne 0 -or -not $installationPath) {
    throw 'No Visual Studio C++ installation was found (including preview versions).'
}

$vcvarsPath = Join-Path $installationPath.Trim() 'VC\Auxiliary\Build\vcvars64.bat'
if (-not (Test-Path -LiteralPath $vcvarsPath)) {
    throw 'vcvars64.bat was not found in the selected installation.'
}

# Prefer the native Windows tools bundled with the selected Visual Studio.
# An unrelated MinGW CMake on PATH may use a different TLS trust store.
$cmakeToolsRoot = Join-Path $installationPath.Trim() 'Common7\IDE\CommonExtensions\Microsoft\CMake'
$cmakePath = Join-Path $cmakeToolsRoot 'CMake\bin\cmake.exe'
$ninjaPath = Join-Path $cmakeToolsRoot 'Ninja\ninja.exe'
if (-not (Test-Path -LiteralPath $cmakePath)) {
    $cmakePath = (Get-Command cmake.exe -ErrorAction Stop).Source
}
if (-not (Test-Path -LiteralPath $ninjaPath)) {
    $ninjaPath = (Get-Command ninja.exe -ErrorAction Stop).Source
}

Push-Location -LiteralPath $projectRoot
try {
    $freshOption = if ($Fresh) { ' --fresh' } else { '' }
    if ($PortabilityChecks) {
        # 仅编译无外部依赖的安全夹具，不构建或覆盖正在开发的应用扩展。
        & $env:ComSpec /d /s /c "set `"VSLANG=1033`" && call `"$vcvarsPath`" >nul && `"$cmakePath`"$freshOption -S tests/native -B build/native/portability-checks -G Ninja -DCMAKE_MAKE_PROGRAM=`"$ninjaPath`" -DCMAKE_BUILD_TYPE=Debug && `"$cmakePath`" --build build/native/portability-checks"
        if ($LASTEXITCODE -ne 0) { throw "Portability check build failed with exit code $LASTEXITCODE" }
        return
    }
    $preset = if ($Release) { 'windows-release' } elseif ($CoreOnly -and $CurlTransport) { 'windows-core-curl' } elseif ($CoreOnly) { 'windows-core' } else { 'windows-msvc' }
    $updateTestsOption = if ($UpdateTests) { 'ON' } else { 'OFF' }
    & $env:ComSpec /d /s /c "chcp 65001 >nul && call `"$vcvarsPath`" >nul && `"$cmakePath`"$freshOption --preset $preset -DCMAKE_MAKE_PROGRAM=`"$ninjaPath`" -DJAVM_UPDATE_TESTS=$updateTestsOption && `"$cmakePath`" --build --preset $preset"
    if ($LASTEXITCODE -ne 0) { throw "Native build failed with exit code $LASTEXITCODE" }
    if ($CoreOnly) { return }
    # Incremental builds may skip POST_BUILD after switching Debug/Release.
    # Deploy the database executable; packaging uses the official Neutralino host.
    Copy-Item -LiteralPath (Join-Path $projectRoot "build/native/$preset/bin/javm_database.exe") `
        -Destination (Join-Path $projectRoot 'bin/javm_database.exe') -Force
    Copy-Item -LiteralPath (Join-Path $projectRoot "build/native/$preset/bin/javm_updater.exe") `
        -Destination (Join-Path $projectRoot 'bin/javm_updater.exe') -Force
}
finally {
    Pop-Location
}

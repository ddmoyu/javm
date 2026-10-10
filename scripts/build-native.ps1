param([switch]$Fresh, [switch]$Release)

$ErrorActionPreference = 'Stop'
$projectRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')).Path
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
    $preset = if ($Release) { 'windows-release' } else { 'windows-msvc' }
    & $env:ComSpec /d /s /c "chcp 65001 >nul && call `"$vcvarsPath`" >nul && `"$cmakePath`"$freshOption --preset $preset -DCMAKE_MAKE_PROGRAM=`"$ninjaPath`" && `"$cmakePath`" --build --preset $preset"
    if ($LASTEXITCODE -ne 0) { throw "Native build failed with exit code $LASTEXITCODE" }
}
finally {
    Pop-Location
}

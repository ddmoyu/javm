$ErrorActionPreference = 'Stop'
$project = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')).Path
if ($env:JAVM_PREBUILT_DEPENDENCIES) { throw 'Dependency builds must compile from source.' }
& (Join-Path $PSScriptRoot 'setup-offline-tools.ps1')
if ($LASTEXITCODE -ne 0) { throw 'Tool dependency build failed.' }
$vswhere = Join-Path ${env:ProgramFiles(x86)} 'Microsoft Visual Studio/Installer/vswhere.exe'
$installation = & $vswhere -latest -prerelease -products '*' -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath
if (!$installation) { throw 'Visual Studio C++ tools were not found.' }
$vcvars = Join-Path $installation.Trim() 'VC/Auxiliary/Build/vcvars64.bat'
$cmakeRoot = Join-Path $installation.Trim() 'Common7/IDE/CommonExtensions/Microsoft/CMake'
$cmake = Join-Path $cmakeRoot 'CMake/bin/cmake.exe'
$ninja = Join-Path $cmakeRoot 'Ninja/ninja.exe'
$source = Join-Path $PSScriptRoot 'dependency-project'
$build = Join-Path $project 'build/dependencies'
& $env:ComSpec /d /s /c "call `"$vcvars`" >nul && `"$cmake`" -S `"$source`" -B `"$build`" -G Ninja -DCMAKE_BUILD_TYPE=Release -DCMAKE_MAKE_PROGRAM=`"$ninja`" && `"$cmake`" --build `"$build`" --parallel 4"
if ($LASTEXITCODE -ne 0) { throw 'MediaInfo dependency build failed.' }
& node (Join-Path $PSScriptRoot 'package-dependencies.mjs')
if ($LASTEXITCODE -ne 0) { throw 'Dependency packaging failed.' }

param([Parameter(Mandatory=$true)][string]$SourceDirectory)
$ErrorActionPreference = 'Stop'
$project = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')).Path
$vswhere = Join-Path ${env:ProgramFiles(x86)} 'Microsoft Visual Studio/Installer/vswhere.exe'
$installation = & $vswhere -latest -prerelease -products '*' -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath
if (!$installation) { throw 'Visual Studio C++ tools not found' }
$vcvars = Join-Path $installation.Trim() 'VC/Auxiliary/Build/vcvars64.bat'
$cmakeRoot = Join-Path $installation.Trim() 'Common7/IDE/CommonExtensions/Microsoft/CMake'
$cmake = Join-Path $cmakeRoot 'CMake/bin/cmake.exe'
$ninja = Join-Path $cmakeRoot 'Ninja/ninja.exe'
$build = Join-Path $project 'build/curl-unicode'
$install = Join-Path $build 'install'
# The vendor MinGW executable lacks Unicode filename support. Build unmodified
# official sources with Windows Schannel and /MT; no third-party DLL is needed.
$options = '-DCMAKE_BUILD_TYPE=Release -DBUILD_SHARED_LIBS=OFF -DBUILD_STATIC_CURL=ON -DCURL_STATIC_CRT=ON -DENABLE_UNICODE=ON -DCURL_USE_SCHANNEL=ON -DCURL_USE_OPENSSL=OFF -DCURL_USE_LIBPSL=OFF -DCURL_USE_LIBSSH2=OFF -DCURL_ZLIB=OFF -DCURL_BROTLI=OFF -DCURL_ZSTD=OFF -DUSE_NGHTTP2=OFF -DHTTP_ONLY=ON -DENABLE_CURL_MANUAL=OFF -DBUILD_LIBCURL_DOCS=OFF -DBUILD_MISC_DOCS=OFF -DBUILD_TESTING=OFF -DCURL_USE_PKGCONFIG=OFF'
& $env:ComSpec /d /s /c "call `"$vcvars`" >nul && `"$cmake`" -S `"$SourceDirectory`" -B `"$build`" -G Ninja -DCMAKE_MAKE_PROGRAM=`"$ninja`" -DCMAKE_INSTALL_PREFIX=`"$install`" $options && `"$cmake`" --build `"$build`" --target curl --parallel 4 && `"$cmake`" --install `"$build`""
if ($LASTEXITCODE -ne 0) { throw 'curl build failed' }
$binary = Join-Path $build 'src/curl.exe'
$version = & $binary --version
if ($LASTEXITCODE -ne 0 -or ($version -join ' ') -notmatch 'Unicode' -or ($version -join ' ') -notmatch 'Schannel') { throw 'curl Unicode/Schannel verification failed' }
Copy-Item -LiteralPath $binary -Destination (Join-Path $project 'bin/tools/curl.exe') -Force

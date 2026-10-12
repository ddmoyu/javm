$ErrorActionPreference = 'Stop'
# pnpm may preserve PowerShell 7 module paths when starting Windows PowerShell.
# Load the matching built-in module to avoid duplicate type definitions.
Import-Module (Join-Path $PSHOME 'Modules/Microsoft.PowerShell.Security/Microsoft.PowerShell.Security.psd1') -ErrorAction Stop
$project = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')).Path
$package = Get-Content -LiteralPath (Join-Path $project 'package.json') -Raw | ConvertFrom-Json
$latest = Get-Content -LiteralPath (Join-Path $project 'dist/offline/latest.json') -Raw | ConvertFrom-Json
$version = $package.version
if ($version -notmatch '^(\d+\.\d+\.\d+)(?:-(?:alpha|beta|rc)\.[1-9]\d*)?$') { throw 'Invalid release version' }
$numeric = $Matches[1] + '.0'
$iscc = if ($env:JAVM_ISCC) { $env:JAVM_ISCC } else { Join-Path ${env:ProgramFiles(x86)} 'Inno Setup 6/ISCC.exe' }
if (!(Test-Path -LiteralPath $iscc)) { throw 'Inno Setup 6 is required; set JAVM_ISCC to ISCC.exe.' }
$stage = Join-Path $project 'build/installer'
$output = Join-Path $project 'dist/release'
New-Item -ItemType Directory -Force -Path $stage, $output | Out-Null
$bootstrapper = Join-Path $stage 'MicrosoftEdgeWebview2Setup.exe'
& "$env:SystemRoot/System32/curl.exe" --fail --location --retry 3 --silent --show-error --output $bootstrapper 'https://go.microsoft.com/fwlink/p/?LinkId=2124703'
if ($LASTEXITCODE -ne 0) { throw 'WebView2 bootstrapper download failed.' }
$signature = Get-AuthenticodeSignature -LiteralPath $bootstrapper
if ($signature.Status -ne 'Valid' -or $signature.SignerCertificate.Subject -notmatch 'O=Microsoft Corporation') { throw 'WebView2 bootstrapper signature is not valid Microsoft code.' }
& $iscc "/DAppVersion=$version" "/DNumericVersion=$numeric" "/DRuntimeDirectory=$($latest.directory)" "/DOutputDirectory=$output" "/DBootstrapper=$bootstrapper" (Join-Path $project 'resources/installer/JAVM.iss')
if ($LASTEXITCODE -ne 0) { throw 'Inno Setup compilation failed.' }
$installer = Join-Path $output "JAVM-$version-windows-x64-setup.exe"
if (!(Test-Path -LiteralPath $installer)) { throw 'Installer output missing.' }
[IO.File]::WriteAllText((Join-Path $stage 'receipt.json'), (@{
    version=$version; installer=$installer; compiler=(Get-Item -LiteralPath $iscc).VersionInfo.FileVersion
    bootstrapperSha256=(Get-FileHash -LiteralPath $bootstrapper -Algorithm SHA256).Hash.ToLowerInvariant()
    signed=$false
} | ConvertTo-Json))

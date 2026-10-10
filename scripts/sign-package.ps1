param([Parameter(Mandatory=$true)][string]$PackageDirectory,[string]$Thumbprint=$env:JAVM_SIGN_CERT_THUMBPRINT,[string]$TimestampServer='https://timestamp.digicert.com')
$ErrorActionPreference='Stop'
if (!$Thumbprint -or $Thumbprint -notmatch '^[a-fA-F0-9]{40}$') { throw 'Set JAVM_SIGN_CERT_THUMBPRINT to a code-signing certificate in CurrentUser\My' }
$certificate=Get-Item -LiteralPath ('Cert:\CurrentUser\My\'+$Thumbprint)
if (!$certificate.HasPrivateKey -or $certificate.NotAfter -le [DateTime]::Now -or !($certificate.EnhancedKeyUsageList | Where-Object {$_.ObjectId.Value -eq '1.3.6.1.5.5.7.3.3'})) { throw 'A valid code-signing certificate with a private key is required' }
$root=[IO.Path]::GetFullPath($PackageDirectory).TrimEnd('\')
foreach ($relative in @('JAVM.exe','bin\javm_database.exe','Install-JAVM.ps1','Uninstall-JAVM.ps1','installer\Package-Tools.ps1')) {
    $path=[IO.Path]::GetFullPath((Join-Path $root $relative))
    if (!$path.StartsWith($root+'\',[StringComparison]::OrdinalIgnoreCase)) { throw 'Invalid signing path' }
    $signature=Set-AuthenticodeSignature -LiteralPath $path -Certificate $certificate -HashAlgorithm SHA256 -TimestampServer $TimestampServer
    if ($signature.Status -ne 'Valid' -or (Get-AuthenticodeSignature -LiteralPath $path).Status -ne 'Valid') { throw "Signature verification failed: $relative" }
}

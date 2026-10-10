Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Get-JavmHash([string]$Path) {
    $stream = [IO.File]::OpenRead($Path)
    $hash = [Security.Cryptography.SHA256]::Create()
    try { return [BitConverter]::ToString($hash.ComputeHash($stream)).Replace('-','').ToLowerInvariant() }
    finally { $hash.Dispose(); $stream.Dispose() }
}
function Get-JavmRoot([string]$Root) {
    $resolved = [IO.Path]::GetFullPath($Root).TrimEnd('\','/')
    if ($resolved.Length -lt 8 -or $resolved -eq [IO.Path]::GetPathRoot($resolved).TrimEnd('\')) { throw 'Invalid application directory' }
    for ($node = $resolved; $node; $node = Split-Path -Parent $node) {
        if ((Test-Path -LiteralPath $node) -and ((Get-Item -LiteralPath $node -Force).Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw 'Application path cannot contain links' }
    }
    return $resolved
}
function Get-JavmChild([string]$Root,[string]$Relative) {
    if (!$Relative -or $Relative -match '(^[\\/]|:|[\x00-\x1f]|(^|[\\/])\.\.?([\\/]|$)|[. ]([\\/]|$))') { throw 'Invalid package path' }
    if ($Relative -match '(^|[\\/])(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(\.|[\\/]|$)') { throw 'Reserved package path' }
    $full = [IO.Path]::GetFullPath((Join-Path $Root $Relative))
    if (!$full.StartsWith($Root + '\',[StringComparison]::OrdinalIgnoreCase)) { throw 'Package path escapes destination' }
    return $full
}
function Read-JavmManifest([string]$Root) {
    $path = Join-Path $Root 'package-manifest.json'
    if ((Get-Item -LiteralPath $path).Length -gt 4MB) { throw 'Package manifest too large' }
    $manifest = Get-Content -LiteralPath $path -Raw -Encoding UTF8 | ConvertFrom-Json
    if ($manifest.app -ne 'JAVM' -or $manifest.platform -ne 'windows-x64' -or $manifest.version -notmatch '^\d+\.\d+\.\d+$' -or !$manifest.files -or $manifest.files.Count -gt 10000) { throw 'Unsupported package manifest' }
    $seen = [Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
    foreach ($entry in $manifest.files) {
        $file = Get-JavmChild $Root $entry.path
        if (!$seen.Add($file) -or $entry.sha256 -notmatch '^[a-fA-F0-9]{64}$' -or $entry.bytes -lt 0 -or $entry.bytes -gt 1GB) { throw 'Invalid package manifest entry' }
    }
    foreach ($required in @('JAVM.exe','javm-win_x64.exe','bin/javm_database.exe')) { if (!$seen.Contains((Get-JavmChild $Root $required))) { throw "Missing package entry: $required" } }
    return $manifest
}
function Test-JavmPackage([string]$Root) {
    $Root = Get-JavmRoot $Root
    $manifest = Read-JavmManifest $Root
    foreach ($entry in $manifest.files) {
        $file = Get-JavmChild $Root $entry.path
        [void](Get-JavmRoot $file)
        if ((Get-Item -LiteralPath $file).Length -ne $entry.bytes -or (Get-JavmHash $file) -ne $entry.sha256) { throw "Package checksum mismatch: $($entry.path)" }
    }
    return $manifest
}

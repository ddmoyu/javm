$ErrorActionPreference = 'Stop'
$root = [IO.Path]::GetFullPath($PSScriptRoot)
$manifest = Get-Content -LiteralPath (Join-Path $root 'package-manifest.json') -Encoding UTF8 -Raw | ConvertFrom-Json
$checked = 0
foreach ($entry in $manifest.files) {
    $file = [IO.Path]::GetFullPath((Join-Path $root $entry.path))
    if (!$file.StartsWith($root + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) { throw 'Invalid manifest path' }
    $stream = [IO.File]::OpenRead($file)
    $algorithm = [Security.Cryptography.SHA256]::Create()
    try {
        if ($stream.Length -ne $entry.bytes) { throw "Size mismatch: $($entry.path)" }
        $hash = ([BitConverter]::ToString($algorithm.ComputeHash($stream))).Replace('-', '').ToLowerInvariant()
        if ($hash -ne $entry.sha256) { throw "Checksum mismatch: $($entry.path)" }
    } finally { $stream.Dispose(); $algorithm.Dispose() }
    $checked++
}
Write-Host "Verified $checked files. JAVM offline package is complete."

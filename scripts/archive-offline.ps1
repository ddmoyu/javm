param([Parameter(Mandatory=$true)][string]$Source, [Parameter(Mandatory=$true)][string]$Destination, [switch]$Extract)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.IO.Compression.FileSystem
if ($Extract) {
    [IO.Compression.ZipFile]::ExtractToDirectory($Source, $Destination)
} else {
    # CreateNew semantics: never overwrite a delivered archive.
    [IO.Compression.ZipFile]::CreateFromDirectory($Source, $Destination, [IO.Compression.CompressionLevel]::Optimal, $true)
}

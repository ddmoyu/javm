param([string]$FfmpegDirectory = '')
$ErrorActionPreference = 'Stop'
# HLS 与直链都由随包 curl 下载，此脚本只把已有的 FFmpeg 复制到开发目录。
$javmRoot = Split-Path -Parent $PSScriptRoot
$toolsDirectory = Join-Path $javmRoot 'bin/tools'
New-Item -ItemType Directory -Path $toolsDirectory -Force | Out-Null
if ($FfmpegDirectory) {
    foreach ($toolName in @('ffmpeg.exe')) {
        $source = Join-Path $FfmpegDirectory $toolName
        if (!(Test-Path -LiteralPath $source -PathType Leaf)) { throw "Tool not found: $source" }
        $destination = Join-Path $toolsDirectory $toolName
        if ([IO.Path]::GetFullPath($source) -ne [IO.Path]::GetFullPath($destination)) {
            Copy-Item -LiteralPath $source -Destination $destination -Force
        }
    }
}
Write-Host 'Include FFmpeg and curl in bin/tools before packaging; offline:setup builds both.'

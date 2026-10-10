$ErrorActionPreference = 'Stop'
$previousPublicDownloadFlag = $env:JAVM_PUBLIC_DOWNLOAD_INTEGRATION
try {
    $env:JAVM_PUBLIC_DOWNLOAD_INTEGRATION = '1'
    pnpm exec vp test run '../tests/download-public.integration.test.ts'
    if ($LASTEXITCODE -ne 0) { throw 'Public download verification failed; inspect the per-stream results in .tmp/public-hls-review.' }
} finally {
    $env:JAVM_PUBLIC_DOWNLOAD_INTEGRATION = $previousPublicDownloadFlag
}

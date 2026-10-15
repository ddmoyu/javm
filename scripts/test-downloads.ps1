$ErrorActionPreference = 'Stop'
$previousDownloadTestFlag = $env:JAVM_DOWNLOAD_INTEGRATION
try {
    $env:JAVM_DOWNLOAD_INTEGRATION = '1'
    pnpm exec vp test run '../tests/downloads.test.ts' '../tests/download-network.test.ts' '../tests/media-probe.test.ts' '../tests/download-engine.integration.test.ts' '../tests/download-database.integration.test.ts' '../tests/download-host.integration.test.ts'
    if ($LASTEXITCODE -ne 0) { throw 'Download integration tests failed.' }
} finally {
    $env:JAVM_DOWNLOAD_INTEGRATION = $previousDownloadTestFlag
}

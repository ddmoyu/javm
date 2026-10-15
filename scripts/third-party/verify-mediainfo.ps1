param([Parameter(Mandatory=$true)][string]$Binary, [Parameter(Mandatory=$true)][string]$Fixture)
$ErrorActionPreference = 'Stop'
$escaped = $Binary.Replace('"', '""')
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public static class SafeMediaInfo {
    [DllImport(@"$escaped")] public static extern IntPtr MediaInfo_New();
    [DllImport(@"$escaped")] public static extern void MediaInfo_Delete(IntPtr handle);
    [DllImport(@"$escaped", CharSet=CharSet.Unicode)] public static extern UIntPtr MediaInfo_Open(IntPtr handle, string file);
    [DllImport(@"$escaped")] public static extern UIntPtr MediaInfo_Count_Get(IntPtr handle, int kind, UIntPtr stream);
    [DllImport(@"$escaped", CharSet=CharSet.Unicode)] public static extern IntPtr MediaInfo_Get(IntPtr handle, int kind, UIntPtr stream, string field, int info, int search);
}
"@
$handle = [SafeMediaInfo]::MediaInfo_New()
if ($handle -eq [IntPtr]::Zero) { throw 'MediaInfo_New failed' }
try {
    if ([SafeMediaInfo]::MediaInfo_Open($handle, $Fixture).ToUInt64() -eq 0) { throw 'Safe WAV could not be opened' }
    $count = [SafeMediaInfo]::MediaInfo_Count_Get($handle, 2, [UIntPtr]::new([UInt64]::MaxValue)).ToUInt64()
    $duration = [Runtime.InteropServices.Marshal]::PtrToStringUni([SafeMediaInfo]::MediaInfo_Get($handle, 0, [UIntPtr]::Zero, 'Duration', 1, 0))
    if ($count -ne 1 -or [double]::Parse($duration, [Globalization.CultureInfo]::InvariantCulture) -ne 1000) { throw 'Safe WAV fields mismatch' }
    Write-Host 'MediaInfo C ABI: synthetic one-second WAV verified.'
} finally { [SafeMediaInfo]::MediaInfo_Delete($handle) }

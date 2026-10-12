param([Parameter(Mandatory=$true)][string]$HostFile, [Parameter(Mandatory=$true)][string]$VersionSource)
$ErrorActionPreference = 'Stop'
# Stamp before neu embeds resources: Windows resource updates may discard an EXE overlay.
Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
public static class JavmVersionResource {
    [DllImport("kernel32", CharSet=CharSet.Unicode, SetLastError=true)] static extern IntPtr LoadLibraryExW(string path, IntPtr reserved, uint flags);
    [DllImport("kernel32", SetLastError=true)] static extern IntPtr FindResourceW(IntPtr module, IntPtr name, IntPtr type);
    [DllImport("kernel32", SetLastError=true)] static extern IntPtr LoadResource(IntPtr module, IntPtr resource);
    [DllImport("kernel32")] static extern IntPtr LockResource(IntPtr resource);
    [DllImport("kernel32", SetLastError=true)] static extern uint SizeofResource(IntPtr module, IntPtr resource);
    [DllImport("kernel32")] static extern bool FreeLibrary(IntPtr module);
    [DllImport("kernel32", CharSet=CharSet.Unicode, SetLastError=true)] static extern IntPtr BeginUpdateResourceW(string path, bool deleteExisting);
    [DllImport("kernel32", SetLastError=true)] static extern bool UpdateResourceW(IntPtr update, IntPtr type, IntPtr name, ushort language, byte[] data, uint size);
    [DllImport("kernel32", SetLastError=true)] static extern bool EndUpdateResourceW(IntPtr update, bool discard);
    public static void Copy(string source, string target) {
        var module = LoadLibraryExW(source, IntPtr.Zero, 2);
        if (module == IntPtr.Zero) throw new Win32Exception();
        byte[] data;
        try {
            var resource = FindResourceW(module, (IntPtr)1, (IntPtr)16);
            if (resource == IntPtr.Zero) throw new Win32Exception();
            uint size = SizeofResource(module, resource);
            var pointer = LockResource(LoadResource(module, resource));
            if (pointer == IntPtr.Zero || size == 0) throw new Win32Exception();
            data = new byte[size]; Marshal.Copy(pointer, data, 0, data.Length);
        } finally { FreeLibrary(module); }
        var update = BeginUpdateResourceW(target, false);
        if (update == IntPtr.Zero) throw new Win32Exception();
        if (!UpdateResourceW(update, (IntPtr)16, (IntPtr)1, 1033, data, (uint)data.Length)) {
            int error = Marshal.GetLastWin32Error(); EndUpdateResourceW(update, true); throw new Win32Exception(error);
        }
        if (!EndUpdateResourceW(update, false)) throw new Win32Exception();
    }
}
'@
[JavmVersionResource]::Copy([IO.Path]::GetFullPath($VersionSource), [IO.Path]::GetFullPath($HostFile))
$expected = (Get-Item -LiteralPath $VersionSource).VersionInfo.ProductVersion
if ((Get-Item -LiteralPath $HostFile).VersionInfo.ProductVersion -ne $expected) { throw 'Host version resource verification failed.' }

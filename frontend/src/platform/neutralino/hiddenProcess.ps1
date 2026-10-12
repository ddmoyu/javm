param([Parameter(Mandatory=$true)][string]$Config)
$ErrorActionPreference = 'Stop'
# No business messages over stdin/stdout. A job handle owns the entire browser tree.
Add-Type -TypeDefinition @'
using System;
using System.Text;
using System.Runtime.InteropServices;
public sealed class JavmHiddenJob : IDisposable {
  [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)] struct Startup { public int cb; public string reserved,desktop,title; public int x,y,w,h,xc,yc,fill,flags; public short show,cbReserved; public IntPtr reserved2,input,output,error; }
  [StructLayout(LayoutKind.Sequential)] struct Info { public IntPtr process,thread; public uint pid,tid; }
  [StructLayout(LayoutKind.Sequential)] struct Limits { public long processTime,jobTime; public uint flags; public UIntPtr min,max; public uint active; public UIntPtr affinity; public uint priority,scheduling; }
  [StructLayout(LayoutKind.Sequential)] struct Counters { public ulong a,b,c,d,e,f; }
  [StructLayout(LayoutKind.Sequential)] struct Extended { public Limits basic; public Counters io; public UIntPtr processMemory,jobMemory,peakProcessMemory,peakJobMemory; }
  [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern bool CreateProcess(string exe,StringBuilder command,IntPtr pa,IntPtr ta,bool inherit,uint flags,IntPtr environment,string directory,ref Startup startup,out Info info);
  [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern IntPtr CreateJobObject(IntPtr attributes,string name);
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool SetInformationJobObject(IntPtr job,int kind,ref Extended value,uint length);
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool AssignProcessToJobObject(IntPtr job,IntPtr process);
  [DllImport("kernel32.dll",SetLastError=true)] static extern uint ResumeThread(IntPtr thread);
  [DllImport("kernel32.dll")] static extern bool TerminateProcess(IntPtr process,uint code);
  [DllImport("kernel32.dll")] static extern uint WaitForSingleObject(IntPtr handle,uint timeout);
  [DllImport("kernel32.dll")] static extern bool GetExitCodeProcess(IntPtr process,out uint code);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
  [DllImport("kernel32.dll",SetLastError=true)] static extern IntPtr OpenProcess(uint access,bool inherit,uint pid);
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool IsProcessInJob(IntPtr process,IntPtr job,out bool owned);
  [DllImport("iphlpapi.dll")] static extern uint GetExtendedTcpTable(IntPtr table,ref uint size,bool order,int family,int kind,uint reserved);
  IntPtr job,process;
  public JavmHiddenJob(string exe,string arguments) {
    Info info=new Info();
    try {
      job=CreateJobObject(IntPtr.Zero,null);
      Extended limits=new Extended(); limits.basic.flags=0x2000;
      if(job==IntPtr.Zero || !SetInformationJobObject(job,9,ref limits,(uint)Marshal.SizeOf(limits))) throw new System.ComponentModel.Win32Exception();
      Startup startup=new Startup(); startup.cb=Marshal.SizeOf(startup); startup.flags=1; startup.show=0;
      // STARTF_USESHOWWINDOW/SW_HIDE before the first ShowWindow; suspended until owned.
      if(!CreateProcess(exe,new StringBuilder("\""+exe+"\" "+arguments),IntPtr.Zero,IntPtr.Zero,false,0x08000004,IntPtr.Zero,null,ref startup,out info)) throw new System.ComponentModel.Win32Exception();
      process=info.process;
      if(!AssignProcessToJobObject(job,process) || ResumeThread(info.thread)==UInt32.MaxValue) throw new System.ComponentModel.Win32Exception();
    } catch {
      if(process!=IntPtr.Zero) TerminateProcess(process,1);
      Dispose(); throw;
    } finally { if(info.thread!=IntPtr.Zero) CloseHandle(info.thread); }
  }
  public bool Wait(uint milliseconds) { return WaitForSingleObject(process,milliseconds)==0; }
  // An explicit debug port must belong to this job before its discovery endpoint is read.
  public bool OwnsLoopbackListener(int port) {
    uint size=0;
    uint result=GetExtendedTcpTable(IntPtr.Zero,ref size,false,2,3,0);
    if(result!=122 || size<4 || size>4*1024*1024) return false;
    IntPtr table=Marshal.AllocHGlobal((int)size);
    try {
      if(GetExtendedTcpTable(table,ref size,false,2,3,0)!=0) return false;
      int count=Marshal.ReadInt32(table);
      if(count<0 || count>(size-4)/24) return false;
      for(int i=0;i<count;i++) {
        int row=4+i*24;
        if(Marshal.ReadInt32(table,row)!=2 || Marshal.ReadByte(table,row+4)!=127 ||
           Marshal.ReadByte(table,row+5)!=0 || Marshal.ReadByte(table,row+6)!=0 ||
           Marshal.ReadByte(table,row+7)!=1 ||
           ((Marshal.ReadByte(table,row+8)<<8)|Marshal.ReadByte(table,row+9))!=port) continue;
        IntPtr owner=OpenProcess(0x1000,false,(uint)Marshal.ReadInt32(table,row+20));
        if(owner==IntPtr.Zero) return false;
        try { bool owned; return IsProcessInJob(owner,job,out owned) && owned; }
        finally { CloseHandle(owner); }
      }
      return false;
    } finally { Marshal.FreeHGlobal(table); }
  }
  public int ExitCode { get { uint code; if(!GetExitCodeProcess(process,out code)) return 1; return (int)code; } }
  public void Dispose() {
    if(job!=IntPtr.Zero) { CloseHandle(job); job=IntPtr.Zero; }
    if(process!=IntPtr.Zero) { WaitForSingleObject(process,5000); CloseHandle(process); process=IntPtr.Zero; }
  }
}
'@
$javmInput = Get-Content -LiteralPath $Config -Raw -Encoding UTF8 | ConvertFrom-Json
$env:WEBVIEW2_USER_DATA_FOLDER = $javmInput.profile
# Port 0 makes Chromium advertise WebDriver automation. Allocate a nonzero loopback port
# before launch; ownership checks below make a bind race fail closed, never attach elsewhere.
$javmConfigPath = Join-Path (Split-Path -Parent $javmInput.profile) 'neutralino.config.json'
$javmConfig = Get-Content -LiteralPath $javmConfigPath -Raw -Encoding UTF8 | ConvertFrom-Json
if ([regex]::Matches($javmConfig.modes.window.webviewArgs, '(?<!\S)--remote-debugging-port=0(?=\s|$)').Count -ne 1) {
  throw 'Invalid hidden browser debug port template'
}
$javmReservation = [Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback, 0)
try {
  $javmReservation.Start()
  $javmPort = ([Net.IPEndPoint]$javmReservation.LocalEndpoint).Port
} finally { $javmReservation.Stop() }
$javmConfig.modes.window.webviewArgs = $javmConfig.modes.window.webviewArgs -replace '(?<!\S)--remote-debugging-port=0(?=\s|$)', "--remote-debugging-port=$javmPort"
[IO.File]::WriteAllText($javmConfigPath, ($javmConfig | ConvertTo-Json -Depth 12), [Text.UTF8Encoding]::new($false))
function Read-JavmCdpEndpoint {
  if (!$javmBrowser.OwnsLoopbackListener($javmPort)) { return }
  $javmResponse = $null
  $javmReader = $null
  try {
    $javmRequest = [Net.HttpWebRequest]::Create("http://127.0.0.1:$javmPort/json/version")
    $javmRequest.Proxy = $null
    $javmRequest.AllowAutoRedirect = $false
    $javmRequest.Timeout = 300
    $javmRequest.ReadWriteTimeout = 300
    $javmResponse = $javmRequest.GetResponse()
    if ([int]$javmResponse.StatusCode -ne 200) { return }
    $javmReader = [IO.StreamReader]::new($javmResponse.GetResponseStream())
    $javmBuffer = New-Object char[] 4097
    $javmLength = 0
    while ($javmLength -lt $javmBuffer.Length) {
      $javmCount = $javmReader.Read($javmBuffer, $javmLength, $javmBuffer.Length - $javmLength)
      if ($javmCount -eq 0) { break }
      $javmLength += $javmCount
    }
    if ($javmLength -gt 4096) { return }
    $javmVersion = [string]::new($javmBuffer, 0, $javmLength) | ConvertFrom-Json
    $javmMatch = [regex]::Match([string]$javmVersion.webSocketDebuggerUrl, "^ws://127\.0\.0\.1:${javmPort}(/devtools/browser/[a-zA-Z0-9-]+)$")
    if (!$javmMatch.Success -or !$javmBrowser.OwnsLoopbackListener($javmPort)) { return }
    return "$javmPort`n$($javmMatch.Groups[1].Value)"
  } catch {
    # The listener may be ready before its HTTP discovery endpoint; retry within the deadline.
  } finally {
    if ($null -ne $javmReader) { $javmReader.Dispose() }
    if ($null -ne $javmResponse) { $javmResponse.Dispose() }
  }
}
$javmOwner = [Diagnostics.Process]::GetProcessById([int]$javmInput.ownerPid)
$javmBrowser = $null
try {
  if ($javmOwner.HasExited) { exit 125 }
  $javmBrowser = [JavmHiddenJob]::new($javmInput.file, $javmInput.arguments)
  $javmDeadline = [DateTime]::UtcNow.AddMilliseconds([int]$javmInput.timeoutMs)
  $javmEndpointWritten = $false
  while (!$javmBrowser.Wait(100)) {
    if ($javmOwner.HasExited) { exit 125 }
    if ([DateTime]::UtcNow -ge $javmDeadline) { exit 124 }
    if (!$javmEndpointWritten) {
      $javmEndpoint = Read-JavmCdpEndpoint
      if ($javmEndpoint) {
        [void][IO.Directory]::CreateDirectory($javmInput.profile)
        # Nonzero-port Chromium does not write DevToolsActivePort. Publish only our verified endpoint.
        $javmEndpointPath = Join-Path $javmInput.profile 'DevToolsActivePort'
        [IO.File]::WriteAllText("$javmEndpointPath.tmp", $javmEndpoint, [Text.UTF8Encoding]::new($false))
        [IO.File]::Move("$javmEndpointPath.tmp", $javmEndpointPath)
        $javmEndpointWritten = $true
      }
    }
  }
  exit $javmBrowser.ExitCode
} finally {
  if ($null -ne $javmBrowser) { $javmBrowser.Dispose() }
  $javmOwner.Dispose()
}

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
  public int ExitCode { get { uint code; if(!GetExitCodeProcess(process,out code)) return 1; return (int)code; } }
  public void Dispose() {
    if(job!=IntPtr.Zero) { CloseHandle(job); job=IntPtr.Zero; }
    if(process!=IntPtr.Zero) { WaitForSingleObject(process,5000); CloseHandle(process); process=IntPtr.Zero; }
  }
}
'@
$javmInput = Get-Content -LiteralPath $Config -Raw -Encoding UTF8 | ConvertFrom-Json
$env:WEBVIEW2_USER_DATA_FOLDER = $javmInput.profile
$javmOwner = [Diagnostics.Process]::GetProcessById([int]$javmInput.ownerPid)
$javmBrowser = $null
try {
  if ($javmOwner.HasExited) { exit 125 }
  $javmBrowser = [JavmHiddenJob]::new($javmInput.file, $javmInput.arguments)
  $javmDeadline = [DateTime]::UtcNow.AddMilliseconds([int]$javmInput.timeoutMs)
  while (!$javmBrowser.Wait(100)) {
    if ($javmOwner.HasExited) { exit 125 }
    if ([DateTime]::UtcNow -ge $javmDeadline) { exit 124 }
  }
  exit $javmBrowser.ExitCode
} finally {
  if ($null -ne $javmBrowser) { $javmBrowser.Dispose() }
  $javmOwner.Dispose()
}

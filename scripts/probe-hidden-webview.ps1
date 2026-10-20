# 仅运行脚本内置的安全文字页，不接受外部 URL，也不加载应用数据库。
# 这是窗口生命周期诊断，不是取流测试；报告保存在本次独占的 .tmp 目录。
param(
  [ValidateSet('process','win32')][string]$Launch = 'win32',
  [ValidateSet('success','no-result','hang')][string]$Scenario = 'success',
  [ValidateRange(5,20)][int]$TimeoutSeconds = 20
)
$ErrorActionPreference = 'Stop'
$javmProjectRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$javmProbeRoot = Join-Path (Join-Path $javmProjectRoot '.tmp') ('hidden-webview-' + [Guid]::NewGuid().ToString('N'))
[void](New-Item -ItemType Directory -Path $javmProbeRoot)
Copy-Item -LiteralPath (Join-Path $javmProjectRoot 'node_modules/@neutralinojs/lib/dist/neutralino.js') -Destination (Join-Path $javmProbeRoot 'neutralino.js')
$javmPageAction = switch ($Scenario) {
  'success' { 'await Neutralino.storage.setData("result",JSON.stringify({done:true}));setTimeout(()=>Neutralino.app.exit(),500);' }
  'no-result' { 'await Neutralino.storage.setData("result",JSON.stringify({done:false,reason:"no_candidates"}));setTimeout(()=>Neutralino.app.exit(),500);' }
  'hang' { 'await Neutralino.storage.setData("ready",JSON.stringify({ready:true}));' }
}
[IO.File]::WriteAllText((Join-Path $javmProbeRoot 'index.html'), ('<!doctype html><meta charset="utf-8"><title>Safe DEMO-001</title><p>Safe local mock only</p><script>Neutralino.init(); Neutralino.events.on("ready", async()=>{' + $javmPageAction + '})</script>'))
$javmConfig = @{
  applicationId='net.ddmoyu.javm.hiddenprobe'; defaultMode='window'; port=0; documentRoot='/'; url='/index.html';
  enableServer=$true; enableNativeAPI=$true; enableExtensions=$false; exportAuthInfo=$false; tokenSecurity='none';
  dataLocation='app'; storageLocation='app'; nativeAllowList=@('storage.setData','app.exit');
  logging=@{enabled=$false};
  modes=@{window=@{title='JAVM safe hidden probe'; hidden=$true; skipTaskbar=$true; width=400; height=300; useSavedState=$false; enableInspector=$false; injectGlobals=$true; injectClientLibrary=$true; exitProcessOnClose=$true; newWindowPolicy='custom'; webviewArgs='--mute-audio --proxy-server=http://127.0.0.1:9 --proxy-bypass-list=localhost;127.0.0.1'}};
  cli=@{clientLibrary='/neutralino.js'}
}
[IO.File]::WriteAllText((Join-Path $javmProbeRoot 'neutralino.config.json'), ($javmConfig|ConvertTo-Json -Depth 6))
Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;
public static class HiddenWindowProbe {
  [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)] public struct StartupInfo { public int cb; public string reserved,desktop,title; public int x,y,w,h,xc,yc,fill,flags; public short show,cbReserved; public IntPtr reserved2,input,output,error; }
  [StructLayout(LayoutKind.Sequential)] public struct ProcessInfo { public IntPtr process,thread; public uint pid,tid; }
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] public static extern bool CreateProcess(string exe, StringBuilder command, IntPtr pa, IntPtr ta, bool inherit, uint flags, IntPtr environment, string directory, ref StartupInfo startup, out ProcessInfo info);
  [DllImport("kernel32.dll")] public static extern bool CloseHandle(IntPtr handle);
  [DllImport("kernel32.dll", SetLastError=true)] public static extern uint ResumeThread(IntPtr thread);
  [DllImport("kernel32.dll")] public static extern bool TerminateProcess(IntPtr process, uint exitCode);
  // 先挂起，安装本任务 PID 的观察状态后再恢复，避免漏掉创建初期的事件。
  public static ProcessInfo StartHidden(string exe,string arguments) { StartupInfo si=new StartupInfo(); si.cb=Marshal.SizeOf(si); si.flags=1; si.show=0; ProcessInfo pi; if(!CreateProcess(exe,new StringBuilder("\""+exe+"\" "+arguments),IntPtr.Zero,IntPtr.Zero,false,0x08000004,IntPtr.Zero,null,ref si,out pi)) throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error()); return pi; }
  public delegate void WinEventDelegate(IntPtr hook, uint evt, IntPtr hwnd, int obj, int child, uint thread, uint time);
  public delegate bool EnumDelegate(IntPtr hwnd, IntPtr data);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint pid);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hwnd);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern IntPtr SetWinEventHook(uint min, uint max, IntPtr lib, WinEventDelegate cb, uint pid, uint thread, uint flags);
  [DllImport("user32.dll")] public static extern bool UnhookWinEvent(IntPtr hook);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumDelegate cb, IntPtr data);
  [DllImport("user32.dll")] public static extern bool PeekMessage(out MSG msg, IntPtr hwnd, uint min, uint max, uint remove);
  [DllImport("user32.dll")] public static extern bool TranslateMessage(ref MSG msg);
  [DllImport("user32.dll")] public static extern IntPtr DispatchMessage(ref MSG msg);
  [StructLayout(LayoutKind.Sequential)] public struct MSG { public IntPtr hwnd; public uint message; public UIntPtr wParam; public IntPtr lParam; public uint time; public int x,y; public uint extra; }
  public static uint Target;
  public static int ShowEvents, ForegroundEvents;
  public static List<string> Events = new List<string>();
  public static WinEventDelegate Callback = (hook,evt,hwnd,obj,child,thread,time)=> {
    uint pid; GetWindowThreadProcessId(hwnd,out pid);
    if(pid==Target && obj==0 && child==0) {
      if(evt==0x8002) ShowEvents++;
      if(evt==3) ForegroundEvents++;
      if(Events.Count<128) Events.Add(evt.ToString()+":"+IsWindowVisible(hwnd).ToString());
    }
  };
  public static void Pump() { MSG msg; while(PeekMessage(out msg,IntPtr.Zero,0,0,1)) { TranslateMessage(ref msg); DispatchMessage(ref msg); } }
  public static bool AnyVisible(uint pid) { bool visible=false; EnumWindows((h,d)=> { uint p; GetWindowThreadProcessId(h,out p); if(p==pid && IsWindowVisible(h)) visible=true; return true; },IntPtr.Zero); return visible; }
}
'@
$javmBefore = [HiddenWindowProbe]::GetForegroundWindow()
$javmShowHook = [HiddenWindowProbe]::SetWinEventHook(0x8002,0x8002,[IntPtr]::Zero,[HiddenWindowProbe]::Callback,0,0,0)
$javmFocusHook = [HiddenWindowProbe]::SetWinEventHook(3,3,[IntPtr]::Zero,[HiddenWindowProbe]::Callback,0,0,0)
$javmStart = [Diagnostics.ProcessStartInfo]::new()
$javmStart.FileName = (Join-Path $javmProjectRoot 'bin/neutralino-win_x64.exe')
$javmStart.Arguments = '--res-mode=directory --path="' + $javmProbeRoot + '"'
$javmStart.UseShellExecute = $false
$javmStart.CreateNoWindow = $true
$javmStart.WindowStyle = [Diagnostics.ProcessWindowStyle]::Hidden
$javmStart.EnvironmentVariables['WEBVIEW2_USER_DATA_FOLDER'] = Join-Path $javmProbeRoot 'profile'
if($Launch -eq 'win32') {
  $env:WEBVIEW2_USER_DATA_FOLDER = Join-Path $javmProbeRoot 'profile'
  $javmCreated = [HiddenWindowProbe]::StartHidden($javmStart.FileName, $javmStart.Arguments)
  try {
    $javmChild = [Diagnostics.Process]::GetProcessById($javmCreated.pid)
    [HiddenWindowProbe]::Target = $javmCreated.pid
    if([HiddenWindowProbe]::ResumeThread($javmCreated.thread) -eq [uint32]::MaxValue) {
      throw '无法恢复本任务的隐藏宿主。'
    }
  } catch {
    [void][HiddenWindowProbe]::TerminateProcess($javmCreated.process, 1)
    throw
  } finally {
    [void][HiddenWindowProbe]::CloseHandle($javmCreated.thread)
    [void][HiddenWindowProbe]::CloseHandle($javmCreated.process)
  }
} else {
  $javmChild = [Diagnostics.Process]::Start($javmStart)
}
[HiddenWindowProbe]::Target = $javmChild.Id
$javmVisible = $false
$javmFocused = $false
$javmDeadline = [DateTime]::UtcNow.AddSeconds($TimeoutSeconds)
$javmTimedOut = $false
try {
  while (!$javmChild.HasExited -and [DateTime]::UtcNow -lt $javmDeadline) {
    [HiddenWindowProbe]::Pump()
    if([HiddenWindowProbe]::AnyVisible($javmChild.Id)) { $javmVisible=$true }
    $javmCurrent=[HiddenWindowProbe]::GetForegroundWindow()
    $javmForegroundPid=[uint32]0
    [void][HiddenWindowProbe]::GetWindowThreadProcessId($javmCurrent,[ref]$javmForegroundPid)
    if($javmForegroundPid -eq $javmChild.Id) { $javmFocused=$true }
    Start-Sleep -Milliseconds 10
  }
  if(!$javmChild.HasExited) {
    $javmTimedOut = $true
    & "$env:SystemRoot\System32\taskkill.exe" /PID $javmChild.Id /T /F | Out-Null
    if(!$javmChild.WaitForExit(5000)) { throw '本任务的隐藏宿主未能在收尾期限内退出。' }
  }
  [HiddenWindowProbe]::Pump()
  $javmResultFile=Join-Path $javmProbeRoot '.storage\result.neustorage'
  $javmResult = if(Test-Path -LiteralPath $javmResultFile){Get-Content -LiteralPath $javmResultFile -Raw | ConvertFrom-Json} else {$null}
  $javmReport=@{
    launch=$Launch; scenario=$Scenario; root=$javmProbeRoot; exit=$javmChild.HasExited;
    visible=$javmVisible; focused=$javmFocused; showEvents=[HiddenWindowProbe]::ShowEvents;
    foregroundEvents=[HiddenWindowProbe]::ForegroundEvents; events=@([HiddenWindowProbe]::Events);
    result=$javmResult; timedOut=$javmTimedOut;
    readyPresent=(Test-Path -LiteralPath (Join-Path $javmProbeRoot '.storage\ready.neustorage'));
    sameForeground=([HiddenWindowProbe]::GetForegroundWindow() -eq $javmBefore)
  }
  [IO.File]::WriteAllText((Join-Path $javmProbeRoot 'report.json'), ($javmReport|ConvertTo-Json -Depth 5))
  $javmReport | ConvertTo-Json -Depth 5
  if($Launch -eq 'win32' -and ($javmVisible -or [HiddenWindowProbe]::ShowEvents -gt 0)) {
    throw '隐藏窗口断言失败，详见本任务的 report.json。'
  }
  if($Scenario -eq 'hang') {
    if(!$javmTimedOut -or !$javmReport.readyPresent) { throw '超时场景未按预期加载并由监督器结束。' }
  } elseif($javmTimedOut -or !$javmResult) {
    throw '安全页面未能正常报告并退出。'
  } elseif(($Scenario -eq 'success' -and !$javmResult.done) -or ($Scenario -eq 'no-result' -and $javmResult.reason -ne 'no_candidates')) {
    throw '安全页面返回的场景结果错误。'
  }
} finally {
  [void][HiddenWindowProbe]::UnhookWinEvent($javmShowHook)
  [void][HiddenWindowProbe]::UnhookWinEvent($javmFocusHook)
  if(!$javmChild.HasExited) { & "$env:SystemRoot\System32\taskkill.exe" /PID $javmChild.Id /T /F | Out-Null; $javmChild.WaitForExit() }
}

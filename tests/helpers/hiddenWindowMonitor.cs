using System;
using System.Runtime.InteropServices;

// 只观察测试创建的进程，不激活或修改任何窗口。
public static class SafeWindowMonitor {
  delegate bool EnumCallback(IntPtr window, IntPtr data);
  delegate void EventCallback(IntPtr hook, uint evt, IntPtr window, int obj, int child, uint thread, uint time);
  [StructLayout(LayoutKind.Sequential)] struct Message { public IntPtr window; public uint message; public UIntPtr wParam; public IntPtr lParam; public uint time; public int x, y; public uint extra; }
  [DllImport("user32.dll")] static extern bool EnumWindows(EnumCallback callback, IntPtr data);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr window);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr window, out uint pid);
  [DllImport("user32.dll")] static extern IntPtr SetWinEventHook(uint first, uint last, IntPtr library, EventCallback callback, uint pid, uint thread, uint flags);
  [DllImport("user32.dll")] static extern bool UnhookWinEvent(IntPtr hook);
  [DllImport("user32.dll")] static extern bool PeekMessage(out Message message, IntPtr window, uint first, uint last, uint remove);
  [DllImport("user32.dll")] static extern bool TranslateMessage(ref Message message);
  [DllImport("user32.dll")] static extern IntPtr DispatchMessage(ref Message message);
  static IntPtr hook;
  static uint target;
  static readonly EventCallback callback = (h, evt, window, obj, child, thread, time) => {
    uint pid; GetWindowThreadProcessId(window, out pid);
    if(pid == target && obj == 0 && child == 0) ShowEvents++;
  };
  public static int ShowEvents, VisibleSamples, Samples;
  public static void Start(uint pid) {
    target = pid;
    hook = SetWinEventHook(0x8002, 0x8002, IntPtr.Zero, callback, pid, 0, 0);
    if(hook == IntPtr.Zero) throw new InvalidOperationException("Cannot observe hidden test window");
  }
  public static void Sample() {
    Message message;
    while(PeekMessage(out message, IntPtr.Zero, 0, 0, 1)) {
      TranslateMessage(ref message); DispatchMessage(ref message);
    }
    Samples++;
    EnumWindows((window, data) => {
      uint pid; GetWindowThreadProcessId(window, out pid);
      if(pid == target && IsWindowVisible(window)) VisibleSamples++;
      return true;
    }, IntPtr.Zero);
  }
  public static void Stop() { Sample(); if(hook != IntPtr.Zero) UnhookWinEvent(hook); hook = IntPtr.Zero; }
}

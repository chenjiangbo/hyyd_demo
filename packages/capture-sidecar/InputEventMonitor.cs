using System.Runtime.InteropServices;

namespace Hyyd.CaptureSidecar;

/// <summary>
/// 全局输入/前台事件监听，用于"聪明截图"触发。
/// 在独立后台线程上跑 Win32 消息循环，安装：
///   - 低级键盘钩子（WH_KEYBOARD_LL）：捕获回车（发消息）
///   - 低级鼠标钩子（WH_MOUSE_LL）：捕获滚轮（翻历史）、左键（切会话）
///   - 前台变更事件（EVENT_SYSTEM_FOREGROUND）：窗口被激活
/// 任一事件触发时调用 onTrigger(reason)。回调里只做极轻的"置信号"动作，
/// 不在钩子里读进程名/截图——是否真的截由采集循环统一判定（前台是不是微信 + 去重）。
/// </summary>
internal sealed class InputEventMonitor : IDisposable
{
    private readonly Action<string> _onTrigger;
    private Thread? _thread;
    private uint _threadId;
    private volatile bool _running;

    private IntPtr _kbHook;
    private IntPtr _mouseHook;
    private IntPtr _winEventHook;

    // 必须持有委托引用，否则会被 GC 回收导致钩子回调崩溃
    private NativeMethods.HookProc? _kbProc;
    private NativeMethods.HookProc? _mouseProc;
    private NativeMethods.WinEventProc? _winEventProc;

    public InputEventMonitor(Action<string> onTrigger)
    {
        _onTrigger = onTrigger;
    }

    public void Start()
    {
        if (_thread is not null)
        {
            return;
        }
        _running = true;
        _thread = new Thread(ThreadMain)
        {
            IsBackground = true,
            Name = "hyyd-input-monitor"
        };
        _thread.Start();
    }

    private void ThreadMain()
    {
        _threadId = NativeMethods.GetCurrentThreadId();
        var hMod = NativeMethods.GetModuleHandle(null);

        _kbProc = KeyboardProc;
        _mouseProc = MouseProc;
        _winEventProc = WinEventProc;

        _kbHook = NativeMethods.SetWindowsHookEx(NativeMethods.WH_KEYBOARD_LL, _kbProc, hMod, 0);
        _mouseHook = NativeMethods.SetWindowsHookEx(NativeMethods.WH_MOUSE_LL, _mouseProc, hMod, 0);
        _winEventHook = NativeMethods.SetWinEventHook(
            NativeMethods.EVENT_SYSTEM_FOREGROUND,
            NativeMethods.EVENT_SYSTEM_FOREGROUND,
            IntPtr.Zero,
            _winEventProc,
            0,
            0,
            NativeMethods.WINEVENT_OUTOFCONTEXT | NativeMethods.WINEVENT_SKIPOWNPROCESS);

        if (_kbHook == IntPtr.Zero || _mouseHook == IntPtr.Zero)
        {
            Console.Error.WriteLine("[capture] 输入钩子安装失败，将仅依赖兜底定时截图。");
        }

        // 钩子回调依赖本线程的消息泵
        while (_running && NativeMethods.GetMessage(out var msg, IntPtr.Zero, 0, 0) > 0)
        {
            NativeMethods.TranslateMessage(ref msg);
            NativeMethods.DispatchMessage(ref msg);
        }

        if (_kbHook != IntPtr.Zero) NativeMethods.UnhookWindowsHookEx(_kbHook);
        if (_mouseHook != IntPtr.Zero) NativeMethods.UnhookWindowsHookEx(_mouseHook);
        if (_winEventHook != IntPtr.Zero) NativeMethods.UnhookWinEvent(_winEventHook);
        _kbHook = _mouseHook = _winEventHook = IntPtr.Zero;
    }

    private IntPtr KeyboardProc(int nCode, IntPtr wParam, IntPtr lParam)
    {
        if (nCode == NativeMethods.HC_ACTION)
        {
            var msg = (int)wParam;
            if (msg == NativeMethods.WM_KEYDOWN || msg == NativeMethods.WM_SYSKEYDOWN)
            {
                // KBDLLHOOKSTRUCT 第一个 DWORD 是 vkCode
                var vk = Marshal.ReadInt32(lParam);
                if (vk == NativeMethods.VK_RETURN)
                {
                    SafeTrigger("key-enter");
                }
            }
        }
        return NativeMethods.CallNextHookEx(IntPtr.Zero, nCode, wParam, lParam);
    }

    private IntPtr MouseProc(int nCode, IntPtr wParam, IntPtr lParam)
    {
        if (nCode == NativeMethods.HC_ACTION)
        {
            var msg = (int)wParam;
            if (msg == NativeMethods.WM_MOUSEWHEEL)
            {
                SafeTrigger("wheel");
            }
            else if (msg == NativeMethods.WM_LBUTTONUP)
            {
                // 只在"松开"触发：覆盖普通点击（点完的结果）和拖动滚动条（滚完的结果），
                // 不在"按下"触发，避免截到动作开始前的旧画面、也避免与松开重复。
                SafeTrigger("click");
            }
        }
        return NativeMethods.CallNextHookEx(IntPtr.Zero, nCode, wParam, lParam);
    }

    private void WinEventProc(
        IntPtr hWinEventHook,
        uint eventType,
        IntPtr hwnd,
        int idObject,
        int idChild,
        uint dwEventThread,
        uint dwmsEventTime)
    {
        SafeTrigger("foreground");
    }

    private void SafeTrigger(string reason)
    {
        try
        {
            _onTrigger(reason);
        }
        catch
        {
            // 触发回调绝不能让钩子线程崩
        }
    }

    public void Dispose()
    {
        if (_thread is null)
        {
            return;
        }
        _running = false;
        if (_threadId != 0)
        {
            NativeMethods.PostThreadMessage(_threadId, NativeMethods.WM_QUIT, IntPtr.Zero, IntPtr.Zero);
        }
        _thread.Join(1000);
        _thread = null;
        _threadId = 0;
    }
}

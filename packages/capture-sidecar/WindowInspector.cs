using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text;

namespace Hyyd.CaptureSidecar;

internal sealed class WindowInspector
{
    private static readonly Dictionary<string, string> TargetProcesses = new(StringComparer.OrdinalIgnoreCase)
    {
        ["WXWork.exe"] = "wxwork",
        ["WeChat.exe"] = "wechat",   // 旧版微信
        ["Weixin.exe"] = "wechat"    // 新版微信(4.x)进程名改成了 Weixin.exe
    };

    public TargetWindow? GetForegroundTarget()
    {
        var hwnd = NativeMethods.GetForegroundWindow();
        return GetTargetFromHwnd(hwnd);
    }

    public TargetWindow? GetTargetFromHwnd(IntPtr hwnd)
    {
        if (hwnd == IntPtr.Zero)
        {
            return null;
        }

        if (!NativeMethods.IsWindowVisible(hwnd) || NativeMethods.IsIconic(hwnd))
        {
            return null;
        }

        NativeMethods.GetWindowThreadProcessId(hwnd, out var pid);
        if (pid == 0)
        {
            return null;
        }

        string processName;
        try
        {
            using var process = Process.GetProcessById((int)pid);
            processName = process.ProcessName.EndsWith(".exe", StringComparison.OrdinalIgnoreCase)
                ? process.ProcessName
                : $"{process.ProcessName}.exe";
        }
        catch
        {
            return null;
        }

        if (!TargetProcesses.TryGetValue(processName, out var channel))
        {
            return null;
        }

        // 只截“真正的主窗口”：排除被 own 的弹出窗（切换企业菜单、对话框、浮层等）和工具窗口。
        // 这些窗口同属 WXWork.exe/WeChat.exe，但带阴影/透明外扩边距，CopyFromScreen 会把桌面也抠进来。
        var owner = NativeMethods.GetWindow(hwnd, NativeMethods.GW_OWNER);
        var exStyle = NativeMethods.GetWindowLongPtr(hwnd, NativeMethods.GWL_EXSTYLE).ToInt64();
        var isToolWindow = (exStyle & NativeMethods.WS_EX_TOOLWINDOW) != 0;
        if (owner != IntPtr.Zero || isToolWindow)
        {
            Console.Error.WriteLine(
                $"[capture] 跳过非主窗口 process={processName} class={GetClassName(hwnd)} " +
                $"owned={owner != IntPtr.Zero} toolWindow={isToolWindow}"
            );
            return null;
        }

        var title = GetWindowTitle(hwnd);
        var className = GetClassName(hwnd);

        // 企微：只截主聊天窗（class=WeWorkWindow），跳过登录窗(WeChatLogin)等其它窗口。
        // 可用 HYYD_WXWORK_MAIN_CLASS 覆盖（万一以后版本改了类名）。
        // 微信：主窗和登录窗 class 一样(Qt51514QWindowIcon，且带版本号会变)，无法靠类名区分 → 不限制，照旧全截。
        if (channel == "wxwork")
        {
            var mainClass = Environment.GetEnvironmentVariable("HYYD_WXWORK_MAIN_CLASS");
            if (string.IsNullOrWhiteSpace(mainClass)) mainClass = "WeWorkWindow";
            if (!string.Equals(className, mainClass, StringComparison.Ordinal))
            {
                Console.Error.WriteLine($"[capture] 跳过企微非主窗口 class={className}（仅截 {mainClass}）");
                return null;
            }
        }

        if (!TryGetVisibleRect(hwnd, out var rect))
        {
            throw new InvalidOperationException($"GetWindowRect failed for {processName}.");
        }

        if (IsFullScreenCaptureOverlay(processName, title, rect))
        {
            Console.Error.WriteLine(
                $"[capture] 跳过全屏截图遮罩 process={processName} class={className} {rect.Width}x{rect.Height}");
            return null;
        }

        // 太小的多半是表情/通知/输入法等弹窗，不是主聊天窗 → 静默跳过（不抛异常，否则会被
        // 当成采集错误反复弹到状态栏）。阈值放宽到 200，避免误杀新版微信(Weixin.exe)较窄的窗口。
        if (rect.Width < 200 || rect.Height < 200)
        {
            Console.Error.WriteLine(
                $"[capture] 跳过过小窗口 process={processName} {rect.Width}x{rect.Height}（疑似弹窗/输入法）");
            return null;
        }

        return new TargetWindow(
            hwnd,
            channel,
            processName,
            title,
            rect,
            "normal",
            className
        );
    }

    // 优先用 DWM 可见边界（排除隐形边框/阴影，截图不带周围背景）；DWM 失败或拿到空 rect 时回退 GetWindowRect。
    private static bool TryGetVisibleRect(IntPtr hwnd, out WinRect rect)
    {
        if (NativeMethods.DwmGetWindowAttribute(
                hwnd, NativeMethods.DWMWA_EXTENDED_FRAME_BOUNDS, out rect, Marshal.SizeOf<WinRect>()) == 0
            && rect.Width > 0 && rect.Height > 0)
        {
            return true;
        }
        return NativeMethods.GetWindowRect(hwnd, out rect);
    }

    // 微信/企微的"截图工具遮罩"是一个覆盖整块屏幕的窗口（连任务栏都盖住）。它和主窗口同 class
    // (Qt51514QWindowIcon)、也可能有标题，所以不能靠 class/标题区分；改用"尺寸≈整块屏幕"判定。
    // 关键：只比**整屏**(SM_CXSCREEN/CYSCREEN 或虚拟屏)，不比工作区——这样"最大化的主窗口"(只占
    // 工作区、比整屏矮一截任务栏)不会被误判为遮罩。
    private static bool IsFullScreenCaptureOverlay(string processName, string title, WinRect rect)
    {
        if (!processName.Equals("Weixin.exe", StringComparison.OrdinalIgnoreCase) &&
            !processName.Equals("WeChat.exe", StringComparison.OrdinalIgnoreCase) &&
            !processName.Equals("WXWork.exe", StringComparison.OrdinalIgnoreCase))
        {
            return false;
        }

        // 整块主屏
        var pw = NativeMethods.GetSystemMetrics(NativeMethods.SM_CXSCREEN);
        var ph = NativeMethods.GetSystemMetrics(NativeMethods.SM_CYSCREEN);
        if (pw > 0 && ph > 0 && Math.Abs(rect.Width - pw) <= 4 && Math.Abs(rect.Height - ph) <= 4)
        {
            return true;
        }

        // 整块虚拟屏（多显示器）
        var vx = NativeMethods.GetSystemMetrics(NativeMethods.SM_XVIRTUALSCREEN);
        var vy = NativeMethods.GetSystemMetrics(NativeMethods.SM_YVIRTUALSCREEN);
        var vw = NativeMethods.GetSystemMetrics(NativeMethods.SM_CXVIRTUALSCREEN);
        var vh = NativeMethods.GetSystemMetrics(NativeMethods.SM_CYVIRTUALSCREEN);
        return vw > 0 && vh > 0 &&
            Math.Abs(rect.Left - vx) <= 2 &&
            Math.Abs(rect.Top - vy) <= 2 &&
            Math.Abs(rect.Width - vw) <= 4 &&
            Math.Abs(rect.Height - vh) <= 4;
    }

    private static string GetWindowTitle(IntPtr hwnd)
    {
        var builder = new StringBuilder(512);
        _ = NativeMethods.GetWindowText(hwnd, builder, builder.Capacity);
        return builder.ToString();
    }

    private static string GetClassName(IntPtr hwnd)
    {
        var builder = new StringBuilder(256);
        _ = NativeMethods.GetClassName(hwnd, builder, builder.Capacity);
        return builder.ToString();
    }
}

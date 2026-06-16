using System.Diagnostics;
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

        if (!NativeMethods.GetWindowRect(hwnd, out var rect))
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
            "normal"
        );
    }

    private static bool IsFullScreenCaptureOverlay(string processName, string title, WinRect rect)
    {
        if (!string.IsNullOrWhiteSpace(title))
        {
            return false;
        }

        if (!processName.Equals("Weixin.exe", StringComparison.OrdinalIgnoreCase) &&
            !processName.Equals("WeChat.exe", StringComparison.OrdinalIgnoreCase) &&
            !processName.Equals("WXWork.exe", StringComparison.OrdinalIgnoreCase))
        {
            return false;
        }

        var vx = NativeMethods.GetSystemMetrics(NativeMethods.SM_XVIRTUALSCREEN);
        var vy = NativeMethods.GetSystemMetrics(NativeMethods.SM_YVIRTUALSCREEN);
        var vw = NativeMethods.GetSystemMetrics(NativeMethods.SM_CXVIRTUALSCREEN);
        var vh = NativeMethods.GetSystemMetrics(NativeMethods.SM_CYVIRTUALSCREEN);
        if (vw <= 0 || vh <= 0)
        {
            return false;
        }

        return Math.Abs(rect.Left - vx) <= 2 &&
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

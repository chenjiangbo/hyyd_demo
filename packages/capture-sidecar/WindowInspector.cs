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

        if (!NativeMethods.GetWindowRect(hwnd, out var rect))
        {
            throw new InvalidOperationException($"GetWindowRect failed for {processName}.");
        }

        if (rect.Width < 320 || rect.Height < 240)
        {
            throw new InvalidOperationException($"Target window size is too small: {rect.Width}x{rect.Height}.");
        }

        return new TargetWindow(
            channel,
            processName,
            GetWindowTitle(hwnd),
            rect,
            "normal"
        );
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


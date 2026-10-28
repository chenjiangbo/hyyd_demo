using System.Diagnostics;
using System.Windows.Automation;

namespace Hyyd.CaptureSidecar;

/// <summary>
/// Identifies the WeChat image preview window through the UI Automation tree.
/// The preview hwnd and title are version-dependent and are intentionally not
/// used as the sole identity.
/// </summary>
internal static class WeChatPreviewInspector
{
    private static readonly string[] PreviewControlNames =
    {
        "上一张",
        "下一张",
        "放大",
        "缩小",
        "图片原始大小",
        "图片适应窗口大小",
        "翻译",
        "提取文字",
        "识别图中二维码",
        "另存为..."
    };

    internal sealed record Evidence(
        bool Matched,
        string? RootClassName,
        string? RootControlType,
        string? RootName,
        IReadOnlyList<string> Controls,
        string? Error);

    public static bool TryInspect(IntPtr hwnd, out Evidence evidence)
    {
        evidence = new Evidence(false, null, null, null, Array.Empty<string>(), null);
        if (hwnd == IntPtr.Zero)
        {
            evidence = evidence with { Error = "empty-hwnd" };
            return false;
        }

        try
        {
            var element = AutomationElement.FromHandle(hwnd);
            if (element is null)
            {
                evidence = evidence with { Error = "uia-from-hwnd-null" };
                return false;
            }

            var current = element.Current;
            var controls = new List<string>();
            var descendants = element.FindAll(
                TreeScope.Descendants,
                new PropertyCondition(AutomationElement.IsControlElementProperty, true));

            foreach (AutomationElement child in descendants)
            {
                var name = child.Current.Name?.Trim();
                if (string.IsNullOrEmpty(name)) continue;
                if (Array.Exists(PreviewControlNames, candidate =>
                        string.Equals(candidate, name, StringComparison.OrdinalIgnoreCase)))
                {
                    if (!controls.Contains(name, StringComparer.OrdinalIgnoreCase))
                    {
                        controls.Add(name);
                    }
                }
            }

            var rootClass = current.ClassName;
            var classMatch = string.Equals(rootClass, "ImagePreviewWnd", StringComparison.OrdinalIgnoreCase);
            var controlMatch = controls.Count >= 2;
            evidence = new Evidence(
                classMatch || controlMatch,
                rootClass,
                current.ControlType?.ProgrammaticName,
                current.Name,
                controls,
                null);
            return evidence.Matched;
        }
        catch (ElementNotAvailableException ex)
        {
            evidence = evidence with { Error = $"element-not-available:{ex.Message}" };
            return false;
        }
        catch (Exception ex)
        {
            evidence = evidence with { Error = $"uia-error:{ex.GetType().Name}:{ex.Message}" };
            return false;
        }
    }

    public static bool IsWeChatProcess(IntPtr hwnd)
    {
        try
        {
            NativeMethods.GetWindowThreadProcessId(hwnd, out var pid);
            if (pid == 0) return false;
            using var process = Process.GetProcessById((int)pid);
            return process.ProcessName.Equals("Weixin", StringComparison.OrdinalIgnoreCase) ||
                   process.ProcessName.Equals("WeChat", StringComparison.OrdinalIgnoreCase);
        }
        catch
        {
            return false;
        }
    }
}

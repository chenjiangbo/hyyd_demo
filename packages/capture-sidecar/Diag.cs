namespace Hyyd.CaptureSidecar;

/// <summary>
/// 轻量调试日志，只写 stderr（不污染 stdout 的 JSON 协议）。
/// 默认关闭；独立自测模式（--standalone）下打开，方便把控制台输出贴回来排查。
/// </summary>
internal static class Diag
{
    public static bool Verbose;

    public static void Line(string message)
    {
        if (!Verbose)
        {
            return;
        }
        Console.Error.WriteLine($"{DateTimeOffset.Now:HH:mm:ss.fff} {message}");
    }
}

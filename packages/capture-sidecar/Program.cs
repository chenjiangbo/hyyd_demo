using System.Text.Json;
using System.Text.Json.Serialization;

namespace Hyyd.CaptureSidecar;

internal static class Program
{
    private static readonly JsonSerializerOptions JsonOptions = new()
    {
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
        DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull
    };

    public static async Task Main()
    {
        // 让中文输出走 UTF-8（默认 Windows 控制台是 GBK，经 SSH/管道会乱码）
        try { Console.OutputEncoding = System.Text.Encoding.UTF8; } catch { /* 某些宿主不支持，忽略 */ }
        // stderr 同样强制 UTF-8（Diag.Line 走 stderr，Electron 主进程 chunk.toString('utf8') 解码）
        try
        {
            var utf8Err = new System.IO.StreamWriter(Console.OpenStandardError(), System.Text.Encoding.UTF8) { AutoFlush = true };
            Console.SetError(utf8Err);
        }
        catch { /* ignore */ }
        NativeMethods.TryEnableDpiAwareness();

        var writer = new JsonLineWriter(JsonOptions);
        using var collector = new CaptureCollector(writer);

        await writer.WriteAsync(new
        {
            type = "ready",
            protocolVersion = 1
        });

        // 独立自测模式：直接运行 exe（不需要 tray-app 喂 stdin）。
        //   触发方式：命令行加 --standalone，或设环境变量 HYYD_CAPTURE_STANDALONE=1
        // 行为：自动开始采集、保持运行直到 Ctrl+C；frame 事件打到 stdout，截图落盘到
        //   %LOCALAPPDATA%\HyydCaptureSidecar\frames\<日期>\
        var standalone =
            Environment.GetCommandLineArgs().Any(a =>
                string.Equals(a, "--standalone", StringComparison.OrdinalIgnoreCase)) ||
            Environment.GetEnvironmentVariable("HYYD_CAPTURE_STANDALONE") == "1";

        // 离线测试模式：对一张 PNG 跑 OCR + 消息结构化并打印（不开窗口、可重复，用于调参）。
        //   用法：hyyd-capture-sidecar.exe --test-image <png路径>
        var args = Environment.GetCommandLineArgs();
        var tiIdx = Array.FindIndex(args, a => string.Equals(a, "--test-image", StringComparison.OrdinalIgnoreCase));
        if (tiIdx >= 0 && tiIdx + 1 < args.Length)
        {
            await RunTestImageAsync(args[tiIdx + 1]);
            return;
        }

        if (standalone)
        {
            writer.Muted = true; // 静音 stdout JSON（含 OCR 逐字 bbox），只看 stderr 简洁事件
            await RunStandaloneAsync(collector);
            return;
        }

        // tray 模式下始终打开诊断日志（stderr 由 Electron 主进程捕获并展示到调试页，不影响用户）
        Diag.Verbose = true;

        string? line;
        while ((line = await Console.In.ReadLineAsync()) is not null)
        {
            if (string.IsNullOrWhiteSpace(line))
            {
                continue;
            }

            await HandleCommandAsync(line, collector, writer);
        }
    }

    private static async Task RunTestImageAsync(string path)
    {
        // WinRT StorageFile 要求完整反斜杠绝对路径，规范化（正斜杠/相对路径都转过来）
        path = System.IO.Path.GetFullPath(path);
        Console.Error.WriteLine($"============ 离线图片测试：{path} ============");
        if (!System.IO.File.Exists(path))
        {
            Console.Error.WriteLine("❌ 文件不存在");
            return;
        }
        OcrPayload ocr;
        try
        {
            ocr = await OcrEngineFactory.CreateDefault().RecognizeAsync(path);
        }
        catch (Exception ex)
        {
            Console.Error.WriteLine("❌ OCR 失败：" + ex.Message);
            return;
        }
        var raw = (ocr.Text ?? string.Empty).Replace('\r', ' ').Replace('\n', ' ').Trim();
        Console.Error.WriteLine($"OCR[{ocr.Status}] {raw.Length} 字、{ocr.Blocks.Count} 词块");
        Console.Error.WriteLine("OCR 全文（前 300 字）：" + (raw.Length > 300 ? raw.Substring(0, 300) + "…" : raw));

        // 诊断导出：所有词块坐标（供分析"列检测/行分组"可行性）。一行 JSON，前缀 __BLOCKS__
        using var bmpForSize = new System.Drawing.Bitmap(path);
        var dump = new System.Text.StringBuilder();
        dump.Append("__BLOCKS__{\"w\":").Append(bmpForSize.Width).Append(",\"h\":").Append(bmpForSize.Height).Append(",\"b\":[");
        for (int i = 0; i < ocr.Blocks.Count; i++)
        {
            var bl = ocr.Blocks[i];
            if (i > 0) dump.Append(',');
            dump.Append('{')
                .Append("\"x\":").Append(bl.Bbox.X).Append(",\"y\":").Append(bl.Bbox.Y)
                .Append(",\"w\":").Append(bl.Bbox.Width).Append(",\"h\":").Append(bl.Bbox.Height)
                .Append(",\"t\":").Append(System.Text.Json.JsonSerializer.Serialize(bl.Text))
                .Append('}');
        }
        dump.Append("]}");
        Console.Error.WriteLine(dump.ToString());

        var lowerPath = path.ToLowerInvariant();
        var channel = lowerPath.Contains("企微") || lowerPath.Contains("wxwork")
            ? "wxwork"
            : "wechat";

        using var bmp = new System.Drawing.Bitmap(path);
        var enriched = ocr with { Blocks = BlockColorSampler.Enrich(bmp, ocr.Blocks) };
        var structure = MessageStructurer.Build(bmp, enriched.Blocks, channel);
        Console.Error.WriteLine($"---- 渠道：{channel} ----");
        Console.Error.WriteLine($"---- 标题：\"{structure.Title}\" ----");
        Console.Error.WriteLine($"---- 结构化消息（{structure.Messages.Count} 条）----");
        foreach (var m in structure.Messages)
        {
            var t = m.Text.Replace('\n', ' ');
            if (t.Length > 60) t = t.Substring(0, 60) + "…";
            Console.Error.WriteLine($"  [{m.Speaker}{(m.Kind != null ? ":" + m.Kind : "")}]{(m.Name != null ? " " + m.Name : "")} {t}");
        }
        Console.Error.WriteLine("============ 测试结束 ============");
    }

    private static async Task RunStandaloneAsync(CaptureCollector collector)
    {
        Diag.Verbose = true; // 打开可读的 stderr 调试日志
        Console.Error.WriteLine("================ 独立自测模式 ================");
        Console.Error.WriteLine("已开始采集微信/企微（仅在它们为前台窗口时截图）。");
        Console.Error.WriteLine("触发：激活微信 / 回车 / 滚轮 / 左键点击；另有 5 秒兜底。");
        Console.Error.WriteLine(@"截图目录：%LOCALAPPDATA%\HyydCaptureSidecar\frames\<日期>\");
        Console.Error.WriteLine("下方每出现一行 \"type\":\"frame\" 即表示保留了一张关键帧（imagePath 是文件路径）。");
        Console.Error.WriteLine("按 Ctrl+C 退出。");
        Console.Error.WriteLine("=============================================");

        var done = new TaskCompletionSource();
        Console.CancelKeyPress += (_, e) =>
        {
            e.Cancel = true; // 自己优雅退出，不让 runtime 直接杀
            done.TrySetResult();
        };

        collector.Start();
        await done.Task;
        Console.Error.WriteLine(
            $"本次统计：保留 {collector.KeptCount} 张 | 去重跳过 {collector.SkippedCount} 张 | 非客户会话过滤 {collector.FilteredCount} 张。" +
            $"（去重跳过的从未写盘；过滤的先写盘后删除）截图目录：%LOCALAPPDATA%\\HyydCaptureSidecar\\frames\\<日期>\\");
        collector.Stop();
        Console.Error.WriteLine("已停止采集。");
    }

    private static async Task HandleCommandAsync(string line, CaptureCollector collector, JsonLineWriter writer)
    {
        Command? command;
        try
        {
            command = JsonSerializer.Deserialize<Command>(line, JsonOptions);
        }
        catch (Exception ex)
        {
            await writer.WriteErrorAsync($"Invalid JSON command: {ex.Message}");
            return;
        }

        if (command?.Type is null)
        {
            await writer.WriteErrorAsync("Command type is required.");
            return;
        }

        switch (command.Type)
        {
            case "ping":
                await writer.WriteStatusAsync(collector.IsCollecting);
                break;

            case "start":
                collector.Start();
                await writer.WriteStatusAsync(true);
                break;

            case "stop":
                collector.Stop();
                await writer.WriteStatusAsync(false);
                break;

            default:
                await writer.WriteErrorAsync($"Unsupported command type: {command.Type}");
                break;
        }
    }

    private sealed class Command
    {
        public string? Type { get; set; }
        public string? RequestId { get; set; }
    }
}

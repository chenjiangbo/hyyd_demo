using System.Drawing;

namespace Hyyd.CaptureSidecar;

internal sealed class CaptureCollector : IDisposable
{
    // 兜底定时间隔，默认 5 秒；可用环境变量 HYYD_CAPTURE_INTERVAL_SECONDS 覆盖。
    // 主要靠键鼠/前台事件触发截图，这个只是"没事件时"的保底兜底。
    private static readonly TimeSpan FallbackInterval = ReadFallbackInterval();
    private static readonly TimeSpan FirstFrameDelay = TimeSpan.FromMilliseconds(700);
    // 抠图前用它做"窗口是否稳定"检查：两次读取 rect 间隔，避免截到正在拖动/缩放中的窗口
    private static readonly TimeSpan StableCheckDelay = TimeSpan.FromMilliseconds(150);
    // 尾沿防抖：事件触发后等输入停顿这么久再截，避免连续打字/滚动时狂截
    private static readonly TimeSpan DebounceDelay = TimeSpan.FromMilliseconds(600);
    // 两次截图的最小间隔，进一步压制事件风暴（去重已能省存储，这个省 CPU/OCR）
    private static readonly TimeSpan MinCaptureInterval = TimeSpan.FromMilliseconds(1000);

    private static TimeSpan ReadFallbackInterval()
    {
        var raw = Environment.GetEnvironmentVariable("HYYD_CAPTURE_INTERVAL_SECONDS");
        if (double.TryParse(raw, out var seconds) && seconds >= 1)
        {
            return TimeSpan.FromSeconds(seconds);
        }
        return TimeSpan.FromSeconds(5);
    }

    private readonly JsonLineWriter _writer;
    private readonly WindowInspector _windowInspector = new();
    private readonly WindowCapture _windowCapture = new();
    private readonly FrameDeduplicator _dedup = new();
    private WindowsOcr? _ocr;
    private readonly CancellationTokenSource _disposeCts = new();
    private CancellationTokenSource? _captureCts;
    private Task? _captureTask;
    private string? _lastWindowKey;
    private DateTimeOffset _targetWindowFirstSeenAt = DateTimeOffset.MinValue;
    private string? _lastError;
    private long _keptCount;
    private long _skippedCount;

    // 事件触发：钩子线程置信号，采集循环醒来。SemaphoreSlim(0,1) 当"可合并的唤醒信号"用。
    private readonly SemaphoreSlim _wake = new(0, 1);
    private InputEventMonitor? _inputMonitor;
    private DateTimeOffset _lastCaptureAt = DateTimeOffset.MinValue;
    private volatile string _lastTriggerReason = "interval";

    private long _filteredCount;

    public long KeptCount => _keptCount;
    public long SkippedCount => _skippedCount;
    public long FilteredCount => _filteredCount;

    // 客户会话关键词：OCR 全文命中任一即视为"与客户/群的沟通"，保留；否则丢弃。
    // 可用环境变量 HYYD_CAPTURE_TITLE_KEYWORDS 覆盖（逗号分隔）；默认"就医服务群"。
    private static readonly string[] TitleKeywords = ReadKeywords();

    private static string[] ReadKeywords()
    {
        var raw = Environment.GetEnvironmentVariable("HYYD_CAPTURE_TITLE_KEYWORDS");
        if (string.IsNullOrWhiteSpace(raw))
        {
            return new[] { "就医服务群" };
        }
        return raw
            .Split(new[] { ',', '，' }, StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries);
    }

    // 订单号：高客 fwyy+数字；普客 COD/CCOD/OD + 恰好 16 位 hex。IgnoreCase 容忍 OCR 大小写偏差。
    // COD/OD 用精确 16 位：去空格后能避免把后面紧邻的时间戳数字也粘进订单号。
    // body 容忍 OCR 误读（如 fwyy1→fwyyl、hex 位认成字母）：抽到含噪候选即可，后端再做归一+编辑距离精确匹配。
    private static readonly System.Text.RegularExpressions.Regex OrderNoRegex = new(
        @"fwyy[0-9a-z|]{6,24}|(?:CCOD|COD|OD)[0-9a-z|]{12,18}",
        System.Text.RegularExpressions.RegexOptions.IgnoreCase | System.Text.RegularExpressions.RegexOptions.Compiled);

    // Windows OCR 对中文常逐字拆开、字符间塞空格，会把订单号和"就医服务群"打散；匹配前先去掉所有空白
    private static readonly System.Text.RegularExpressions.Regex WhitespaceRegex = new(
        @"\s+",
        System.Text.RegularExpressions.RegexOptions.Compiled);

    internal readonly record struct ConversationClass(bool IsCustomer, string? Kind, string? OrderNo);

    /// <summary>
    /// 判断截图是否"与客户的会话"，并尽量抽出订单号。
    /// 群聊：OCR 命中"就医服务群"关键词即算（高客/普客通吃）。
    /// 单聊：标题/全文里出现订单号（fwyy 或 COD/CCOD/OD）即算。
    /// 命中关键词或抽到订单号任一 → 客户会话。
    /// </summary>
    private static ConversationClass Classify(OcrPayload ocr)
    {
        var text = ocr.Text ?? string.Empty;
        if (text.Length == 0 && ocr.Blocks is { Count: > 0 })
        {
            text = string.Concat(ocr.Blocks.Select(b => b.Text));
        }
        // 去掉所有空白后再匹配（OCR 会在字符间塞空格，否则订单号/关键词会被截断）
        var compact = WhitespaceRegex.Replace(text, string.Empty);

        var isGroup = TitleKeywords.Any(kw => compact.Contains(kw, StringComparison.OrdinalIgnoreCase));
        var m = OrderNoRegex.Match(compact);
        var orderNo = m.Success ? m.Value : null;

        var isCustomer = isGroup || orderNo is not null;
        var kind = isCustomer ? (isGroup ? "group" : "single") : null;
        return new ConversationClass(isCustomer, kind, orderNo);
    }

    private static void TryDelete(string path)
    {
        try
        {
            System.IO.File.Delete(path);
        }
        catch
        {
            // 删不掉就算了，下次启动也无所谓
        }
    }

    public CaptureCollector(JsonLineWriter writer)
    {
        _writer = writer;
    }

    // 由输入钩子线程调用，必须极轻、不阻塞
    private void OnInputTrigger(string reason)
    {
        _lastTriggerReason = reason;
        if (_wake.CurrentCount == 0)
        {
            try
            {
                _wake.Release();
            }
            catch (SemaphoreFullException)
            {
                // 已是满的，忽略
            }
        }
    }

    public bool IsCollecting => _captureTask is { IsCompleted: false };

    public void Start()
    {
        if (IsCollecting)
        {
            return;
        }

        _captureCts = CancellationTokenSource.CreateLinkedTokenSource(_disposeCts.Token);
        _captureTask = Task.Run(() => RunAsync(_captureCts.Token));

        _inputMonitor ??= new InputEventMonitor(OnInputTrigger);
        _inputMonitor.Start();

        Diag.Line($"去重配置：{_dedup.ConfigSummary}");
        Diag.Line($"客户会话识别：群聊关键词[{string.Join(" / ", TitleKeywords)}] 或 订单号[fwyy… / COD/CCOD/OD…]，命中其一才保留");
    }

    public void Stop()
    {
        _captureCts?.Cancel();
        _captureCts?.Dispose();
        _captureCts = null;
        _captureTask = null;
        _lastWindowKey = null;
        _targetWindowFirstSeenAt = DateTimeOffset.MinValue;
        _dedup.ResetAll();

        _inputMonitor?.Dispose();
        _inputMonitor = null;
    }

    public void Dispose()
    {
        Stop();
        _disposeCts.Cancel();
        _disposeCts.Dispose();
        _wake.Dispose();
    }

    private async Task RunAsync(CancellationToken cancellationToken)
    {
        // 启动先截一张当前状态
        try
        {
            await CaptureOnceIfTargetAsync(cancellationToken);
            _lastCaptureAt = DateTimeOffset.UtcNow;
        }
        catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
        {
            return;
        }
        catch (Exception ex)
        {
            await WriteErrorOnceAsync(ex.Message);
        }

        while (!cancellationToken.IsCancellationRequested)
        {
            try
            {
                await WaitForCaptureAsync(cancellationToken);

                // 最小间隔节流：距上次截图太近就等一会儿，压制事件风暴
                var since = DateTimeOffset.UtcNow - _lastCaptureAt;
                if (since < MinCaptureInterval)
                {
                    await Task.Delay(MinCaptureInterval - since, cancellationToken);
                }

                await CaptureOnceIfTargetAsync(cancellationToken);
                _lastCaptureAt = DateTimeOffset.UtcNow;
            }
            catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
            {
                return;
            }
            catch (Exception ex)
            {
                await WriteErrorOnceAsync(ex.Message);
                await Task.Delay(FallbackInterval, cancellationToken);
            }
        }
    }

    // 等到"该截图了"：要么有输入/前台事件触发（经尾沿防抖），要么兜底间隔到。
    private async Task WaitForCaptureAsync(CancellationToken cancellationToken)
    {
        var signaled = await _wake.WaitAsync(FallbackInterval, cancellationToken);
        if (!signaled)
        {
            _lastTriggerReason = "interval";
            return; // 兜底定时
        }

        // 尾沿防抖：只要还有事件在 DebounceDelay 内陆续到来，就继续等，直到输入停顿
        while (await _wake.WaitAsync(DebounceDelay, cancellationToken))
        {
            // 持续有输入，继续等其停稳
        }
    }

    private async Task CaptureOnceIfTargetAsync(CancellationToken cancellationToken)
    {
        var target = _windowInspector.GetForegroundTarget();
        if (target is null)
        {
            if (_lastWindowKey is not null)
            {
                Diag.Line("前台不是微信/企微 → 暂停截图");
            }
            _lastWindowKey = null;
            _targetWindowFirstSeenAt = DateTimeOffset.MinValue;
            await _writer.WriteStatusAsync(false);
            return;
        }

        // 本次截图的归因：默认取触发原因；若是窗口刚切入（激活），固定记为 foreground，
        // 避免被"点图标激活"那一下的 click 覆盖（截图发生在渲染延迟之后，期间共享变量会被改）。
        var captureReason = _lastTriggerReason;

        var windowKey = $"{target.ProcessName}:{target.WindowTitle}:{target.Rect.Width}x{target.Rect.Height}";
        var now = DateTimeOffset.UtcNow;
        if (!string.Equals(_lastWindowKey, windowKey, StringComparison.Ordinal))
        {
            _lastWindowKey = windowKey;
            _targetWindowFirstSeenAt = now;
            captureReason = "foreground";
            await _writer.WriteStatusAsync(true);
            Diag.Line($"命中目标窗口 [{target.Channel}] \"{target.WindowTitle}\" {target.Rect.Width}x{target.Rect.Height}");
            await Task.Delay(FirstFrameDelay, cancellationToken);
        }

        // 关键：抠图前重新读取最新窗口位置/大小，并确认窗口没在移动。
        // 否则用旧 rect 的屏幕坐标 CopyFromScreen，会截到窗口旧位置(此刻是桌面/别的窗口)。
        var stable = await GetStableTargetAsync(target.Channel, cancellationToken);
        if (stable is null)
        {
            return; // 已切走 / 正在拖动缩放 → 本轮跳过，等下一轮窗口停稳再截
        }
        target = stable;

        // 先截到内存，算缩略图指纹，做去重判定；只有保留的关键帧才落盘 + OCR + 上报
        using var bitmap = _windowCapture.CaptureBitmap(target);

        if (IsLikelyBlank(bitmap))
        {
            Diag.Line("⚠️ 截到的画面接近全黑/空白——很可能是 GPU/CEF 渲染，BitBlt 抠不到，需改用 PrintWindow");
        }

        var signature = FrameSignature.Build(bitmap, _dedup.ThumbnailWidth);
        var decision = _dedup.Decide(
            target.Channel,
            target.Rect.Width,
            target.Rect.Height,
            signature,
            DateTimeOffset.UtcNow
        );

        if (decision.Action == DedupAction.Skip)
        {
            _skippedCount++;
            _lastError = null;
            Diag.Line($"跳过·近似重复 diff={decision.DiffScore:0.###}（reason={captureReason}）");
            return; // 近似重复：不落盘、不 OCR、不上报
        }

        var capturedAt = DateTimeOffset.UtcNow;
        var image = _windowCapture.Persist(bitmap, target, capturedAt);

        // OCR（RecognizeAsync 只接受文件路径，所以先落盘再 OCR；不命中客户会话再删）
        OcrPayload ocr;
        try
        {
            _ocr ??= new WindowsOcr();
            ocr = await _ocr.RecognizeAsync(image.Path);
        }
        catch (Exception ex)
        {
            ocr = new OcrPayload("windows", "failed", string.Empty, Array.Empty<OcrBlock>());
            await WriteErrorOnceAsync($"OCR 失败（保留该帧，跳过会话过滤）：{ex.Message}");
        }

        // 诊断：打印 OCR 实际读到的内容（前 160 字，空白压平），用于排查"识别不到"是 OCR 问题还是匹配问题
        if (Diag.Verbose)
        {
            var t = (ocr.Text ?? string.Empty).Replace('\r', ' ').Replace('\n', ' ').Trim();
            Diag.Line($"OCR[{ocr.Status}] {t.Length}字: {(t.Length > 160 ? t.Substring(0, 160) + "…" : t)}");
        }

        // 给每个词块采样气泡填充色（像素只有本机有）。结构化/判说话人已移到后端，
        // 后端按这些颜色样本算 HSV 饱和度判 self/other；采不到色的块后端按位置兜底。
        if (ocr.Status == "success" && ocr.Blocks.Count > 0)
        {
            ocr = ocr with { Blocks = BlockColorSampler.Enrich(bitmap, ocr.Blocks) };
        }

        // 客户会话过滤：群聊命中"就医服务群"或标题/全文出现订单号(fwyy / COD/CCOD/OD) → 保留并抽订单号；
        // 否则非客户聊天，删盘、不上报。OCR 失败(status!=success)时不过滤，保留该帧以免漏采。
        var conv = ocr.Status == "success" ? Classify(ocr) : new ConversationClass(true, null, null);
        if (!conv.IsCustomer)
        {
            TryDelete(image.Path);
            _filteredCount++;
            _lastError = null;
            Diag.Line($"非客户会话，丢弃 → 已删 {System.IO.Path.GetFileName(image.Path)}");
            return;
        }

        Diag.Line(
            $"保留关键帧 [{decision.Reason}] {conv.Kind ?? "ocr?"} 订单号={conv.OrderNo ?? "无"} " +
            $"diff={decision.DiffScore:0.###} 触发={captureReason} → {image.Path}");

        // 路线1：结构化出"带说话人"的消息列表（颜色+位置判 self/other）
        var messages = ocr.Status == "success"
            ? MessageStructurer.Build(bitmap, ocr.Blocks, target.Channel)
            : Array.Empty<StructuredMessage>();
        if (Diag.Verbose && messages.Count > 0)
        {
            Diag.Line($"  结构化消息（{messages.Count} 条）：");
            foreach (var msg in messages)
            {
                var t = msg.Text.Replace('\n', ' ');
                if (t.Length > 40) t = t.Substring(0, 40) + "…";
                Diag.Line($"    [{msg.Speaker}]{(msg.Name != null ? " " + msg.Name : "")} {t}");
            }
        }

        var payload = new FramePayload(
            "frame",
            target.Channel,
            target.ProcessName,
            target.WindowTitle,
            capturedAt.UtcDateTime.ToString("O"),
            new WindowPayload(
                target.Rect.Left,
                target.Rect.Top,
                target.Rect.Width,
                target.Rect.Height,
                target.ShowState
            ),
            image.Path,
            image.Sha256,
            ocr,
            decision.Reason,
            decision.DiffScore,
            conv.Kind,
            conv.OrderNo,
            messages
        );

        _keptCount++;
        _lastError = null;
        await _writer.WriteAsync(payload);
    }

    // 读取当前前台目标窗口，并确认它"没在移动/缩放"：间隔 150ms 读两次，rect 一致才算稳定。
    // 返回最新（稳定）窗口；若已切走或正在拖动则返回 null（本轮跳过）。
    private async Task<TargetWindow?> GetStableTargetAsync(string expectChannel, CancellationToken ct)
    {
        var a = SafeGetForegroundTarget();
        if (a is null || !string.Equals(a.Channel, expectChannel, StringComparison.Ordinal))
        {
            return null;
        }
        await Task.Delay(StableCheckDelay, ct);
        var b = SafeGetForegroundTarget();
        if (b is null || !string.Equals(b.Channel, expectChannel, StringComparison.Ordinal))
        {
            return null;
        }
        // WinRect 是 record struct，值相等比较；rect 不变 = 窗口没在拖动/缩放
        return a.Rect == b.Rect ? b : null;
    }

    private TargetWindow? SafeGetForegroundTarget()
    {
        try
        {
            return _windowInspector.GetForegroundTarget();
        }
        catch
        {
            // 缩放过程中窗口可能瞬时过小/取 rect 失败，视为不稳定
            return null;
        }
    }

    // 网格采样判断画面是否接近全黑（CEF/GPU 渲染时 BitBlt 常抠出黑屏）。
    private static bool IsLikelyBlank(Bitmap bmp)
    {
        var w = bmp.Width;
        var h = bmp.Height;
        if (w < 2 || h < 2)
        {
            return false;
        }
        const int steps = 12;
        int dark = 0, total = 0;
        for (var i = 1; i < steps; i++)
        {
            for (var j = 1; j < steps; j++)
            {
                var p = bmp.GetPixel(w * i / steps, h * j / steps);
                total++;
                if (p.R < 12 && p.G < 12 && p.B < 12)
                {
                    dark++;
                }
            }
        }
        return total > 0 && dark * 100 / total >= 95;
    }

    private async Task WriteErrorOnceAsync(string message)
    {
        if (string.Equals(_lastError, message, StringComparison.Ordinal))
        {
            return;
        }

        _lastError = message;
        Diag.Line($"错误：{message}");
        await _writer.WriteErrorAsync(message);
    }
}

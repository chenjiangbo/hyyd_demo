using System.Drawing;
using System.Threading.Channels;

namespace Hyyd.CaptureSidecar;

internal sealed class CaptureCollector : IDisposable
{
    // 兜底定时间隔，默认 5 秒；可用环境变量 HYYD_CAPTURE_INTERVAL_SECONDS 覆盖。
    // 主要靠键鼠/前台事件触发截图，这个只是"没事件时"的保底兜底。
    private static readonly TimeSpan FallbackInterval = ReadFallbackInterval();
    private static readonly TimeSpan FirstFrameDelay = TimeSpan.FromMilliseconds(700);
    // 抠图前用它做"窗口是否稳定"检查：两次读取 rect 间隔，避免截到正在拖动/缩放中的窗口
    private static readonly TimeSpan StableCheckDelay = TimeSpan.FromMilliseconds(150);
    // 尾沿防抖：事件触发后等输入停顿这么久再截，避免连续打字/滚动时狂截。
    // 调小到 200ms：抓得更快，松手翻动后能赶在画面回弹/变化前截到。
    private static readonly TimeSpan DebounceDelay = TimeSpan.FromMilliseconds(200);
    // 两次截图的最小间隔，进一步压制事件风暴（去重已能省存储，这个省 CPU/OCR）
    private static readonly TimeSpan MinCaptureInterval = TimeSpan.FromMilliseconds(1000);
    // 打字静默期：兜底定时截图若发现最近这么久内还有按键，判定"用户正在打字"，跳过本轮，
    // 避免把半截、还没发送的消息截下来。回车(发送)会单独触发截图，不受此限。
    private static readonly TimeSpan TypingQuietPeriod = TimeSpan.FromMilliseconds(2500);

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
    private IOcrEngine? _ocr;
    private readonly CancellationTokenSource _disposeCts = new();
    private CancellationTokenSource? _captureCts;
    private Task? _captureTask;
    private string? _lastWindowKey;
    private IntPtr _lastForegroundHwnd = IntPtr.Zero; // 上次抓图的目标窗口句柄；变了=刚激活，给重绘缓冲
    private DateTimeOffset _targetWindowFirstSeenAt = DateTimeOffset.MinValue;
    private string? _lastError;
    private long _keptCount;
    private long _skippedCount;

    // 事件触发：钩子线程置信号，采集循环醒来。SemaphoreSlim(0,1) 当"可合并的唤醒信号"用。
    private readonly SemaphoreSlim _wake = new(0, 1);

    // 抓图与 OCR 解耦：采集循环只负责"快速抓像素 + 去重判定"，命中的关键帧丢进这个有界队列；
    // 后台 worker 慢慢做 落盘 + OCR + 结构化 + 上报，不阻塞下一次抓图。
    // 这样"切到企微/微信就能立刻抓到图"，不会被上一帧的 OCR（几百ms~1s）卡住。
    private sealed record CaptureJob(
        Bitmap Bitmap,
        TargetWindow Target,
        string TriggerReason, // 触发原因：foreground/click/wheel/key-enter/interval
        string KeepReason,    // 去重判定保留原因：first_frame/visual_changed/heartbeat…
        double DiffScore,
        DateTimeOffset CapturedAt);
    // 队列容量小（抓图最快 1/秒，OCR ~1s，基本跟得上）；满了就丢这一帧（TryWrite 返回 false），不阻塞循环。
    private Channel<CaptureJob>? _jobs;
    private Task? _processTask;

    private InputEventMonitor? _inputMonitor;
    private DateTimeOffset _lastCaptureAt = DateTimeOffset.MinValue;
    private volatile string _lastTriggerReason = "interval";
    private readonly object _triggerLock = new();
    private TargetWindow? _pendingForegroundTarget;

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

    // OCR 仍可能把订单号和"就医服务群"拆散或插空白；匹配前先去掉所有空白
    private static readonly System.Text.RegularExpressions.Regex WhitespaceRegex = new(
        @"\s+",
        System.Text.RegularExpressions.RegexOptions.Compiled);

    internal readonly record struct ConversationClass(bool IsCustomer, string? Kind, string? OrderNo);

    /// <summary>
    /// 判断是否"与客户的会话"，并尽量抽订单号——**只看聊天区标题行**（不再用全图 OCR，避免左侧联系人列表污染）。
    /// 群聊：标题含"就医服务群"关键词。
    /// 单聊：标题含订单号（fwyy 或 COD/CCOD/OD）——会话名可被改成订单号。
    /// 命中其一 → 客户会话。标题为空（OCR 没读到/分区失败）→ 非客户。
    /// </summary>
    internal static ConversationClass ClassifyTitle(string? title)
    {
        // 去掉所有空白后再匹配（OCR 会在字符间塞空格，否则订单号/关键词会被截断）
        var compact = WhitespaceRegex.Replace(title ?? string.Empty, string.Empty);
        if (compact.Length == 0)
        {
            return new ConversationClass(false, null, null);
        }

        var isGroup = TitleKeywords.Any(kw => compact.Contains(kw, StringComparison.OrdinalIgnoreCase));
        var m = OrderNoRegex.Match(compact);
        var orderNo = m.Success ? m.Value : null;

        var isCustomer = isGroup || orderNo is not null;
        var kind = isCustomer ? (isGroup ? "group" : "single") : null;
        return new ConversationClass(isCustomer, kind, orderNo);
    }

    public CaptureCollector(JsonLineWriter writer)
    {
        _writer = writer;
    }

    // 由输入钩子线程调用，必须极轻、不阻塞
    private void OnInputTrigger(string reason, IntPtr? hwnd)
    {
        lock (_triggerLock)
        {
            _lastTriggerReason = reason;
            if (reason == "foreground" && hwnd is { } h)
            {
                try
                {
                    _pendingForegroundTarget = _windowInspector.GetTargetFromHwnd(h);
                }
                catch
                {
                    _pendingForegroundTarget = null;
                }
            }
            else
            {
                _pendingForegroundTarget = null;
            }
        }
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

        // 后台处理队列：满了 TryWrite 返回 false（FullMode.Wait 下不阻塞），抓图侧据此丢帧、不卡循环。
        _jobs = Channel.CreateBounded<CaptureJob>(new BoundedChannelOptions(3)
        {
            SingleReader = true,
            SingleWriter = true,
            FullMode = BoundedChannelFullMode.Wait
        });
        var jobs = _jobs;
        _processTask = Task.Run(() => ProcessLoopAsync(jobs, _disposeCts.Token));

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
        _lastForegroundHwnd = IntPtr.Zero;
        _targetWindowFirstSeenAt = DateTimeOffset.MinValue;
        _dedup.ResetAll();

        // 不再接收新帧；后台 worker 会把队列里剩余的帧处理完后自然退出（WaitToReadAsync 返回 false）。
        _jobs?.Writer.TryComplete();
        _jobs = null;
        _processTask = null;

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
                if (!IsForegroundTriggerPending())
                {
                    var since = DateTimeOffset.UtcNow - _lastCaptureAt;
                    if (since < MinCaptureInterval)
                    {
                        await Task.Delay(MinCaptureInterval - since, cancellationToken);
                    }
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

        string reason;
        lock (_triggerLock)
        {
            reason = _lastTriggerReason;
        }
        if (reason == "foreground")
        {
            return;
        }

        // 尾沿防抖：只要还有事件在 DebounceDelay 内陆续到来，就继续等，直到输入停顿
        while (await _wake.WaitAsync(DebounceDelay, cancellationToken))
        {
            // 持续有输入，继续等其停稳
        }
    }

    private bool IsForegroundTriggerPending()
    {
        lock (_triggerLock)
        {
            return _lastTriggerReason == "foreground" && _pendingForegroundTarget is not null;
        }
    }

    private async Task CaptureOnceIfTargetAsync(CancellationToken cancellationToken)
    {
        string captureReason;
        TargetWindow? pendingForeground;
        lock (_triggerLock)
        {
            captureReason = _lastTriggerReason;
            pendingForeground = _pendingForegroundTarget;
            _pendingForegroundTarget = null;
        }

        var target = pendingForeground ?? _windowInspector.GetForegroundTarget();
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
        var targetCameFromForegroundEvent = pendingForeground is not null;

        // 正在打字 + 仅是兜底定时触发 → 跳过本轮，等回车(发送)再截，避免截到半截还没发出去的消息。
        // 收到对方消息时没有本地按键，静默期早已过，照常被兜底定时截到。
        if (captureReason == "interval" && _inputMonitor is not null)
        {
            var sinceKey = DateTimeOffset.UtcNow - _inputMonitor.LastTypingAt;
            if (sinceKey < TypingQuietPeriod)
            {
                Diag.Line("打字中，跳过兜底定时截图（等回车发送再截）");
                return;
            }
        }

        var windowKey = $"{target.ProcessName}:{target.WindowTitle}:{target.Rect.Width}x{target.Rect.Height}";
        var now = DateTimeOffset.UtcNow;
        if (!string.Equals(_lastWindowKey, windowKey, StringComparison.Ordinal))
        {
            _lastWindowKey = windowKey;
            _targetWindowFirstSeenAt = now;
            captureReason = "foreground";
            await _writer.WriteStatusAsync(true);
            Diag.Line($"命中目标窗口 [{target.Channel}] \"{target.WindowTitle}\" class={target.ClassName} {target.Rect.Width}x{target.Rect.Height}");
        }

        // 窗口刚被激活（前台句柄变了）→ 给重绘缓冲再抓。微信/企微是 CEF，激活后内容要等一会儿才重绘，
        // 抓太早会截到上一个会话的旧画面（点未激活窗口尤其明显）。不论是前台事件还是点击激活，都补这个延迟。
        var justActivated = target.Hwnd != _lastForegroundHwnd;
        _lastForegroundHwnd = target.Hwnd;
        if (justActivated)
        {
            await Task.Delay(FirstFrameDelay, cancellationToken);
        }

        // 关键：抠图前重新读取最新窗口位置/大小，并确认窗口没在移动。
        // 否则用旧 rect 的屏幕坐标 CopyFromScreen，会截到窗口旧位置(此刻是桌面/别的窗口)。
        var stable = targetCameFromForegroundEvent
            ? await GetStableTargetByWindowAsync(target, cancellationToken)
            : await GetStableForegroundTargetAsync(target.Channel, cancellationToken);
        if (stable is null)
        {
            return; // 已切走 / 正在拖动缩放 → 本轮跳过，等下一轮窗口停稳再截
        }
        target = stable;

        // 抓像素（快）+ 算指纹去重。命中的关键帧丢进后台队列，慢的 OCR/落盘/上报由 worker 做，
        // 不卡这条循环（否则 OCR 期间切来的事件全被堵住、丢图）。bitmap 所有权转移给 worker，这里别 using/dispose。
        var bitmap = _windowCapture.CaptureBitmap(target);

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
            Interlocked.Increment(ref _skippedCount);
            _lastError = null;
            Diag.Line($"跳过·近似重复 diff={decision.DiffScore:0.###}（reason={captureReason}）");
            bitmap.Dispose();
            return; // 近似重复：不落盘、不 OCR、不上报
        }

        // 命中关键帧 → 入后台队列。队列满（OCR 跟不上）就丢这一帧，不堆内存、不卡循环。
        var job = new CaptureJob(bitmap, target, captureReason, decision.Reason, decision.DiffScore, DateTimeOffset.UtcNow);
        if (_jobs is null || !_jobs.Writer.TryWrite(job))
        {
            bitmap.Dispose();
            Diag.Line("处理队列忙，跳过本帧（OCR 跟不上）");
        }
    }

    // 后台 worker：从队列取关键帧，串行做 落盘 + OCR + 结构化 + 客户会话判断 + 写帧（保持帧顺序）。
    private async Task ProcessLoopAsync(Channel<CaptureJob> jobs, CancellationToken ct)
    {
        var reader = jobs.Reader;
        try
        {
            while (await reader.WaitToReadAsync(ct))
            {
                while (reader.TryRead(out var job))
                {
                    try
                    {
                        await ProcessJobAsync(job, ct);
                    }
                    catch (OperationCanceledException) when (ct.IsCancellationRequested)
                    {
                        return;
                    }
                    catch (Exception ex)
                    {
                        await WriteErrorOnceAsync(ex.Message);
                    }
                    finally
                    {
                        job.Bitmap.Dispose();
                    }
                }
            }
        }
        catch (OperationCanceledException) when (ct.IsCancellationRequested)
        {
            // 队列被取消（进程退出），正常退出
        }
    }

    // 处理一帧关键帧（后台线程）：落盘 + OCR + 结构化 + 判客户会话 + 写帧。bitmap 由 ProcessLoopAsync 统一释放。
    private async Task ProcessJobAsync(CaptureJob job, CancellationToken cancellationToken)
    {
        var target = job.Target;
        var bitmap = job.Bitmap;
        var captureReason = job.TriggerReason;
        var capturedAt = job.CapturedAt;
        var image = _windowCapture.Persist(bitmap, target, capturedAt);

        // OCR（RecognizeAsync 只接受文件路径，所以先落盘再 OCR；不命中客户会话再删）
        OcrPayload ocr;
        try
        {
            _ocr ??= OcrEngineFactory.CreateDefault();
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

        // 给每个词块采样气泡填充色（像素只有本机有），随 OCR 块上传供调试页查看。
        // 注意：说话人判定只看气泡位置，不再用颜色；颜色仅用于「找气泡」（DetectBubbleRegions）。
        if (ocr.Status == "success" && ocr.Blocks.Count > 0)
        {
            ocr = ocr with { Blocks = BlockColorSampler.Enrich(bitmap, ocr.Blocks) };
        }

        // 分区 + 结构化（sidecar 本地完成）：切聊天区 → 拼行 → 顶行=标题 → 判说话人 → 抽昵称。
        // OCR 失败时跳过结构化，保留该帧以免漏采（title=null）。
        // 结构化失败（分区/气泡检测抛异常）不再吞掉整帧：捕获异常、记录堆栈，仍把帧吐给 tray-app
        // （走非客户路径，保留原图+OCR 供调试页排查），异常文本随帧上报到调试页右侧。
        StructureResult structure;
        string? structureError = null;
        if (ocr.Status == "success")
        {
            try
            {
                structure = MessageStructurer.Build(bitmap, ocr.Blocks, target.Channel);
            }
            catch (Exception ex)
            {
                structure = new StructureResult(null, Array.Empty<StructuredMessage>());
                structureError = ex.ToString();
                Diag.Line($"结构化失败（保留该帧供调试）：{ex.Message}");
            }
        }
        else
        {
            structure = new StructureResult(null, Array.Empty<StructuredMessage>());
        }

        // 客户会话判断：只看聊天区**标题行**（群名含"就医服务群" 或 标题含订单号）。
        // OCR 失败时不过滤（保留该帧）。
        var conv = ocr.Status == "success" ? ClassifyTitle(structure.Title) : new ConversationClass(true, null, null);
        if (!conv.IsCustomer)
        {
            // 非客户会话：不入库、不上报，但保留截图、仍把整帧吐给 tray-app（Filtered=true），供调试页看截图+OCR。
            Interlocked.Increment(ref _filteredCount);
            _lastError = null;
            Diag.Line($"非客户会话，不入库（保留截图供调试）标题=\"{structure.Title}\" 触发={captureReason} → {image.Path}");
            var filteredPayload = new FramePayload(
                "frame",
                target.Channel,
                target.ProcessName,
                structure.Title,
                capturedAt.UtcDateTime.ToString("O"),
                new WindowPayload(target.Rect.Left, target.Rect.Top, target.Rect.Width, target.Rect.Height, target.ShowState),
                image.Path,
                image.Sha256,
                ocr,
                job.KeepReason,
                job.DiffScore,
                null,
                null,
                structure.Messages,
                Filtered: true,
                ChatX0: structure.ChatX0,
                ChatX1: structure.ChatX1,
                InputCutY: structure.InputCutY,
                InputCut: structure.InputCut,
                DroppedBlockCount: structure.DroppedBlockCount,
                StructureError: structureError,
                ScanY0: structure.ScanY0,
                ScanY1: structure.ScanY1,
                ContactRight: structure.ContactRight,
                Bubbles: structure.Bubbles
            );
            _writer.WriteDebugFileSafe(DebugJsonPath(image.Path), filteredPayload);
            await _writer.WriteAsync(filteredPayload);
            return;
        }

        Diag.Line(
            $"保留关键帧 [{job.KeepReason}] {conv.Kind ?? "?"} 标题=\"{structure.Title}\" 订单号={conv.OrderNo ?? "无"} " +
            $"diff={job.DiffScore:0.###} 触发={captureReason} → {image.Path}");

        if (Diag.Verbose && structure.Messages.Count > 0)
        {
            Diag.Line($"  结构化消息（{structure.Messages.Count} 条）：");
            foreach (var msg in structure.Messages)
            {
                var t = msg.Text.Replace('\n', ' ');
                if (t.Length > 40) t = t.Substring(0, 40) + "…";
                Diag.Line($"    [{msg.Speaker}{(msg.Kind != null ? ":" + msg.Kind : "")}]{(msg.Name != null ? " " + msg.Name : "")} {t}");
            }
        }

        var payload = new FramePayload(
            "frame",
            target.Channel,
            target.ProcessName,
            structure.Title,
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
            job.KeepReason,
            job.DiffScore,
            conv.Kind,
            conv.OrderNo,
            structure.Messages,
            Filtered: false,
            ChatX0: structure.ChatX0,
            ChatX1: structure.ChatX1,
            InputCutY: structure.InputCutY,
            InputCut: structure.InputCut,
            DroppedBlockCount: structure.DroppedBlockCount,
            StructureError: structureError,
            ScanY0: structure.ScanY0,
            ScanY1: structure.ScanY1,
            ContactRight: structure.ContactRight,
            Bubbles: structure.Bubbles
        );

        Interlocked.Increment(ref _keptCount);
        _lastError = null;
        _writer.WriteDebugFileSafe(DebugJsonPath(image.Path), payload);
        await _writer.WriteAsync(payload);
    }

    // 截图旁边的调试文件：<同名>.debug.json（含分区/扫描带/全部气泡/OCR块+采样色/消息判据）。
    private static string DebugJsonPath(string pngPath)
    {
        var dir = System.IO.Path.GetDirectoryName(pngPath) ?? ".";
        var name = System.IO.Path.GetFileNameWithoutExtension(pngPath);
        return System.IO.Path.Combine(dir, name + ".debug.json");
    }

    // 读取当前前台目标窗口，并确认它"没在移动/缩放"：间隔 150ms 读两次，rect 一致才算稳定。
    // 返回最新（稳定）窗口；若已切走或正在拖动则返回 null（本轮跳过）。
    private async Task<TargetWindow?> GetStableForegroundTargetAsync(string expectChannel, CancellationToken ct)
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

    private async Task<TargetWindow?> GetStableTargetByWindowAsync(TargetWindow target, CancellationToken ct)
    {
        if (NativeMethods.GetForegroundWindow() != target.Hwnd)
        {
            return null;
        }
        var a = SafeGetTargetFromHwnd(target.Hwnd);
        if (a is null || !string.Equals(a.Channel, target.Channel, StringComparison.Ordinal))
        {
            return null;
        }
        await Task.Delay(StableCheckDelay, ct);
        if (NativeMethods.GetForegroundWindow() != target.Hwnd)
        {
            return null;
        }
        var b = SafeGetTargetFromHwnd(target.Hwnd);
        if (b is null || !string.Equals(b.Channel, target.Channel, StringComparison.Ordinal))
        {
            return null;
        }
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

    private TargetWindow? SafeGetTargetFromHwnd(IntPtr hwnd)
    {
        try
        {
            return _windowInspector.GetTargetFromHwnd(hwnd);
        }
        catch
        {
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

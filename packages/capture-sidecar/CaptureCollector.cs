namespace Hyyd.CaptureSidecar;

internal sealed class CaptureCollector : IDisposable
{
    // 采集间隔，默认 10 秒；可用环境变量 HYYD_CAPTURE_INTERVAL_SECONDS 覆盖
    private static readonly TimeSpan CaptureInterval = ReadCaptureInterval();
    private static readonly TimeSpan FirstFrameDelay = TimeSpan.FromMilliseconds(700);
    // 抠图前用它做"窗口是否稳定"检查：两次读取 rect 间隔，避免截到正在拖动/缩放中的窗口
    private static readonly TimeSpan StableCheckDelay = TimeSpan.FromMilliseconds(150);

    private static TimeSpan ReadCaptureInterval()
    {
        var raw = Environment.GetEnvironmentVariable("HYYD_CAPTURE_INTERVAL_SECONDS");
        if (double.TryParse(raw, out var seconds) && seconds >= 1)
        {
            return TimeSpan.FromSeconds(seconds);
        }
        return TimeSpan.FromSeconds(10);
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

    public CaptureCollector(JsonLineWriter writer)
    {
        _writer = writer;
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
    }

    public void Dispose()
    {
        Stop();
        _disposeCts.Cancel();
        _disposeCts.Dispose();
    }

    private async Task RunAsync(CancellationToken cancellationToken)
    {
        while (!cancellationToken.IsCancellationRequested)
        {
            try
            {
                await CaptureOnceIfTargetAsync(cancellationToken);
                await Task.Delay(CaptureInterval, cancellationToken);
            }
            catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
            {
                return;
            }
            catch (Exception ex)
            {
                await WriteErrorOnceAsync(ex.Message);
                await Task.Delay(CaptureInterval, cancellationToken);
            }
        }
    }

    private async Task CaptureOnceIfTargetAsync(CancellationToken cancellationToken)
    {
        var target = _windowInspector.GetForegroundTarget();
        if (target is null)
        {
            _lastWindowKey = null;
            _targetWindowFirstSeenAt = DateTimeOffset.MinValue;
            await _writer.WriteStatusAsync(false);
            return;
        }

        var windowKey = $"{target.ProcessName}:{target.WindowTitle}:{target.Rect.Width}x{target.Rect.Height}";
        var now = DateTimeOffset.UtcNow;
        if (!string.Equals(_lastWindowKey, windowKey, StringComparison.Ordinal))
        {
            _lastWindowKey = windowKey;
            _targetWindowFirstSeenAt = now;
            await _writer.WriteStatusAsync(true);
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
            return; // 近似重复：不落盘、不 OCR、不上报
        }

        var capturedAt = DateTimeOffset.UtcNow;
        var image = _windowCapture.Persist(bitmap, target, capturedAt);

        // OCR 仅作为附带元数据，失败不丢弃关键帧（后续消息重建交给 AI，不依赖 OCR）
        OcrPayload ocr;
        try
        {
            _ocr ??= new WindowsOcr();
            ocr = await _ocr.RecognizeAsync(image.Path);
        }
        catch (Exception ex)
        {
            ocr = new OcrPayload("windows", "failed", string.Empty, Array.Empty<OcrBlock>());
            await WriteErrorOnceAsync($"OCR 失败（已保留关键帧）：{ex.Message}");
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
            decision.DiffScore
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

    private async Task WriteErrorOnceAsync(string message)
    {
        if (string.Equals(_lastError, message, StringComparison.Ordinal))
        {
            return;
        }

        _lastError = message;
        await _writer.WriteErrorAsync(message);
    }
}

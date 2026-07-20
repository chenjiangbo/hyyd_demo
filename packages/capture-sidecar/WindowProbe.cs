using System.Diagnostics;
using System.Drawing;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.Json;
using System.Text.Json.Serialization;

namespace Hyyd.CaptureSidecar;

internal sealed class WindowProbe : IDisposable
{
    private static readonly JsonSerializerOptions JsonOptions = new()
    {
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
        DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull
    };

    private static readonly HashSet<string> TargetProcesses = new(StringComparer.OrdinalIgnoreCase)
    {
        "WXWork.exe",
        "WeChat.exe",
        "Weixin.exe"
    };

    private readonly WindowInspector _windowInspector = new();
    private readonly WindowCapture _windowCapture = new();
    private readonly string _probeRoot;
    private readonly SemaphoreSlim _eventWriteLock = new(1, 1);
    private StreamWriter? _eventLog;
    private IOcrEngine? _ocr;
    private Thread? _thread;
    private uint _threadId;
    private volatile bool _running;
    private NativeMethods.HookProc? _mouseProc;
    private NativeMethods.WinEventProc? _winEventProc;
    private IntPtr _mouseHook;
    private IntPtr _winEventHook;
    private bool _disposed;
    private ProbeContext? _lastClickContext;
    private ProbeContext? _lastValidCustomerContext;
    private SourceClick? _lastSourceClick;
    private Task? _pendingContextRefresh;
    private DateTimeOffset _lastMouseUpAt = DateTimeOffset.MinValue;
    private int _captureSeq;
    private readonly HashSet<long> _capturedPreviewHwnds = new();
    private sealed record SourceClick(
        DateTimeOffset At,
        long MainHwnd,
        string Channel,
        string ProcessName,
        string ClassName,
        string? Title,
        int X,
        int Y);

    private sealed record PreviewBinding(
        ProbeContext? Context,
        SourceClick? Source,
        DateTimeOffset MouseUpAt,
        double? SinceClickMs,
        string? Binding);

    public WindowProbe()
    {
        _probeRoot = Path.Combine(
            Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
            "HyydCaptureSidecar",
            "probe",
            DateTimeOffset.Now.ToString("yyyyMMdd-HHmmss"));
    }

    public async Task RunAsync()
    {
        Directory.CreateDirectory(_probeRoot);
        _eventLog = new StreamWriter(
            File.Open(Path.Combine(_probeRoot, "probe-events.jsonl"), FileMode.Create, FileAccess.Write, FileShare.Read),
            new UTF8Encoding(false))
        {
            AutoFlush = true
        };

        await WriteEventAsync(new
        {
            type = "probe-ready",
            protocolVersion = 1,
            probeRoot = _probeRoot,
            eventLogPath = Path.Combine(_probeRoot, "probe-events.jsonl"),
            note = "Open WeChat/WXWork image previews. Press Ctrl+C here when done."
        });

        var done = new TaskCompletionSource();
        Console.CancelKeyPress += (_, e) =>
        {
            e.Cancel = true;
            done.TrySetResult();
        };

        Start();
        await done.Task;
        await WriteEventAsync(new { type = "probe-stopped", probeRoot = _probeRoot });
        Dispose();
    }

    private void Start()
    {
        if (_thread is not null) return;
        _running = true;
        _thread = new Thread(ThreadMain)
        {
            IsBackground = true,
            Name = "hyyd-window-probe"
        };
        _thread.Start();
    }

    private void ThreadMain()
    {
        _threadId = NativeMethods.GetCurrentThreadId();
        var hMod = NativeMethods.GetModuleHandle(null);
        _mouseProc = MouseProc;
        _winEventProc = WinEventProc;
        _mouseHook = NativeMethods.SetWindowsHookEx(NativeMethods.WH_MOUSE_LL, _mouseProc, hMod, 0);
        _winEventHook = NativeMethods.SetWinEventHook(
            NativeMethods.EVENT_SYSTEM_FOREGROUND,
            NativeMethods.EVENT_SYSTEM_FOREGROUND,
            IntPtr.Zero,
            _winEventProc,
            0,
            0,
            NativeMethods.WINEVENT_OUTOFCONTEXT | NativeMethods.WINEVENT_SKIPOWNPROCESS);

        Emit(new
        {
            type = "probe-hooks",
            mouseHook = _mouseHook != IntPtr.Zero,
            foregroundHook = _winEventHook != IntPtr.Zero
        });

        while (_running && NativeMethods.GetMessage(out var msg, IntPtr.Zero, 0, 0) > 0)
        {
            NativeMethods.TranslateMessage(ref msg);
            NativeMethods.DispatchMessage(ref msg);
        }

        if (_mouseHook != IntPtr.Zero) NativeMethods.UnhookWindowsHookEx(_mouseHook);
        if (_winEventHook != IntPtr.Zero) NativeMethods.UnhookWinEvent(_winEventHook);
        _mouseHook = _winEventHook = IntPtr.Zero;
    }

    private IntPtr MouseProc(int nCode, IntPtr wParam, IntPtr lParam)
    {
        if (nCode == NativeMethods.HC_ACTION)
        {
            var msg = (int)wParam;
            if (msg == NativeMethods.WM_LBUTTONDOWN || msg == NativeMethods.WM_LBUTTONUP)
            {
                var pt = Marshal.PtrToStructure<MouseHookStruct>(lParam).Pt;
                var hwndAtPoint = NativeMethods.WindowFromPoint(new WinPoint(pt.X, pt.Y));
                var foreground = NativeMethods.GetForegroundWindow();
                var infoAtPoint = WindowInfo.FromHwnd(hwndAtPoint);
                var foregroundInfo = WindowInfo.FromHwnd(foreground);
                Emit(new
                {
                    type = "probe-mouse",
                    action = msg == NativeMethods.WM_LBUTTONDOWN ? "down" : "up",
                    point = new { x = pt.X, y = pt.Y },
                    hwndAtPoint = infoAtPoint,
                    foreground = foregroundInfo
                });

                if (msg == NativeMethods.WM_LBUTTONUP)
                {
                    _lastMouseUpAt = DateTimeOffset.UtcNow;
                    if (IsConfirmedPreview(infoAtPoint) || IsConfirmedPreview(foregroundInfo))
                    {
                        var previewHwnd = infoAtPoint is not null && IsConfirmedPreview(infoAtPoint)
                            ? hwndAtPoint
                            : foreground;
                        var previewInfo = infoAtPoint is not null && IsConfirmedPreview(infoAtPoint)
                            ? infoAtPoint
                            : foregroundInfo;
                        if (previewInfo is not null)
                        {
                            _ = Task.Run(() => CapturePreviewCandidateAsync(
                                previewHwnd,
                                previewInfo,
                                "preview-click",
                                CaptureBindingNow(previewInfo)));
                        }
                    }
                    else if (foregroundInfo is not null && IsChatMainWindow(foregroundInfo))
                    {
                        _lastSourceClick = new SourceClick(
                            DateTimeOffset.UtcNow,
                            foregroundInfo.Hwnd,
                            foregroundInfo.Channel ?? "unknown",
                            foregroundInfo.ProcessName ?? "unknown",
                            foregroundInfo.ClassName ?? string.Empty,
                            foregroundInfo.Title,
                            pt.X,
                            pt.Y);
                        Emit(new { type = "probe-source-click", source = _lastSourceClick, foreground = foregroundInfo });
                        var task = Task.Run(() => RefreshClickContextAsync(foreground, pt.X, pt.Y));
                        _pendingContextRefresh = task;
                    }
                }
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
        if (eventType != NativeMethods.EVENT_SYSTEM_FOREGROUND ||
            idObject != NativeMethods.OBJID_WINDOW ||
            idChild != 0 ||
            hwnd == IntPtr.Zero)
        {
            return;
        }

        var info = WindowInfo.FromHwnd(hwnd);
        Emit(new { type = "probe-foreground", window = info });
        if (info is not null && IsPreviewCandidate(info))
        {
            _ = Task.Run(() => TrackPreviewCandidateAsync(hwnd, info, "foreground"));
        }
    }

    private async Task RefreshClickContextAsync(IntPtr foregroundHwnd, int x, int y)
    {
        TargetWindow? target;
        try
        {
            target = _windowInspector.GetTargetFromHwnd(foregroundHwnd);
        }
        catch (Exception ex)
        {
            Emit(new { type = "probe-context-error", stage = "target", message = ex.Message });
            return;
        }

        if (target is null)
        {
            return;
        }

        string? imagePath = null;
        string? title = null;
        string? ocrStatus = null;
        string? error = null;
        CaptureCollector.ConversationClass conv = default;

        try
        {
            using var bmp = _windowCapture.CaptureBitmap(target);
            imagePath = PersistProbeBitmap(bmp, "context", target.Channel, DateTimeOffset.UtcNow);
            _ocr ??= OcrEngineFactory.CreateDefault();
            var ocr = await _ocr.RecognizeAsync(imagePath);
            ocrStatus = ocr.Status;
            if (ocr.Status == "success")
            {
                var enriched = ocr with { Blocks = BlockColorSampler.Enrich(bmp, ocr.Blocks) };
                var structure = MessageStructurer.Build(bmp, enriched.Blocks, target.Channel);
                title = structure.Title;
                conv = CaptureCollector.ClassifyTitle(title);
            }
        }
        catch (Exception ex)
        {
            error = ex.ToString();
        }

        var context = new ProbeContext(
            DateTimeOffset.UtcNow,
            target.Hwnd.ToInt64(),
            target.Channel,
            target.ProcessName,
            target.ClassName,
            target.Rect,
            title,
            conv.IsCustomer,
            conv.Kind,
            conv.OrderNo,
            imagePath,
            x,
            y);
        _lastClickContext = context;
        if (context.IsCustomer)
        {
            _lastValidCustomerContext = context;
        }

        Emit(new
        {
            type = "probe-context",
            context,
            ocrStatus,
            error
        });
    }

    private async Task TrackPreviewCandidateAsync(IntPtr hwnd, WindowInfo initialInfo, string trigger)
    {
        var delays = new[] { 120, 300, 700, 1200, 1800 };
        Emit(new { type = "probe-preview-tracking", trigger, window = initialInfo });

        if (IsConfirmedPreview(initialInfo))
        {
            Emit(new
            {
                type = "probe-preview-ready",
                trigger,
                window = initialInfo,
                note = "Capture requires a left-click inside the preview window."
            });
            return;
        }

        foreach (var delay in delays)
        {
            await Task.Delay(delay);
            var info = WindowInfo.FromHwnd(hwnd);
            Emit(new { type = "probe-preview-observed", delayMs = delay, window = info });
            if (info is not null && IsConfirmedPreview(info))
            {
                Emit(new
                {
                    type = "probe-preview-ready",
                    trigger = "delayed-confirm",
                    window = info,
                    note = "Capture requires a left-click inside the preview window."
                });
                return;
            }
        }
    }

    private async Task CapturePreviewCandidateAsync(IntPtr hwnd, WindowInfo info, string trigger, PreviewBinding bindingSnapshot)
    {
        if (!IsConfirmedPreview(info))
        {
            Emit(new { type = "probe-preview-rejected", trigger, reason = "not-confirmed-preview", window = info });
            return;
        }

        Emit(new
        {
            type = "probe-preview-binding-snapshot",
            trigger,
            window = info,
            bindingSnapshot,
            lastContext = _lastClickContext,
            lastValidCustomerContext = _lastValidCustomerContext
        });

        if (!string.Equals(trigger, "preview-click", StringComparison.Ordinal))
        {
            Emit(new
            {
                type = "probe-preview-aborted",
                trigger,
                reason = "preview-click-required",
                window = info
            });
            return;
        }

        // 用户点击大图后再等一小拍，让微信/企微把预览图层提交到屏幕合成结果。
        await Task.Delay(160);
        var finalInfo = WindowInfo.FromHwnd(hwnd);
        if (finalInfo is null || !IsConfirmedPreview(finalInfo))
        {
            Emit(new { type = "probe-preview-aborted", trigger, reason = "closed-after-stable", window = finalInfo });
            return;
        }
        var foreground = NativeMethods.GetForegroundWindow();
        if (foreground != hwnd)
        {
            Emit(new
            {
                type = "probe-preview-aborted",
                trigger,
                reason = "not-foreground-after-click",
                window = finalInfo,
                foreground = WindowInfo.FromHwnd(foreground)
            });
            return;
        }
        info = finalInfo;
        Emit(new { type = "probe-preview-final", trigger, window = info });

        lock (_capturedPreviewHwnds)
        {
            if (!_capturedPreviewHwnds.Add(info.Hwnd))
            {
                Emit(new { type = "probe-preview-duplicate", trigger, window = info });
                return;
            }
        }

        var pending = _pendingContextRefresh;
        if (pending is not null && !pending.IsCompleted)
        {
            await Task.WhenAny(pending, Task.Delay(2500));
        }

        var now = DateTimeOffset.UtcNow;
        var resolved = ResolveBinding(bindingSnapshot, info);
        var context = resolved.Context;
        var sinceClickMs = resolved.SinceClickMs;
        var binding = resolved.Binding;

        Emit(new
        {
            type = "probe-preview-binding-resolved",
            trigger,
            window = info,
            bindingSnapshot,
            resolved,
            lastContext = _lastClickContext,
            lastValidCustomerContext = _lastValidCustomerContext
        });

        Emit(new { type = "probe-preview-capture-start", trigger, window = info, binding, context });

        var target = new TargetWindow(
            hwnd,
            info.Channel ?? "unknown",
            info.ProcessName ?? "unknown",
            info.Title ?? string.Empty,
            new WinRect(info.Left, info.Top, info.Right, info.Bottom),
            "normal",
            info.ClassName ?? string.Empty);
        string? imagePath = null;
        string? captureError = null;
        try
        {
            using var bmp = _windowCapture.CaptureBitmap(target);
            imagePath = PersistProbeBitmap(bmp, "preview-click", target.Channel, now);
        }
        catch (Exception ex)
        {
            captureError = ex.ToString();
        }

        string? wgcImagePath = null;
        string? wgcCaptureError = null;
        try
        {
            using var bmp = await WindowsGraphicsCaptureProbe.CaptureWindowAsync(hwnd, TimeSpan.FromMilliseconds(1500));
            wgcImagePath = PersistProbeBitmap(bmp, "preview-wgc", target.Channel, DateTimeOffset.UtcNow);
        }
        catch (Exception ex)
        {
            wgcCaptureError = ex.ToString();
        }

        await WriteEventAsync(new
        {
            type = "probe-preview-candidate",
            trigger,
            window = info,
            screenshotPath = imagePath,
            captureError,
            captureBackend = "screen-copy-after-preview-click",
            captureDelayMs = 160,
            wgcScreenshotPath = wgcImagePath,
            wgcCaptureError,
            wgcBackend = "windows-graphics-capture",
            binding,
            sinceClickMs,
            context,
            shouldCollectIfFormal = binding is not null && context is { IsCustomer: true }
        });
    }

    private PreviewBinding ResolveBinding(PreviewBinding snapshot, WindowInfo previewInfo)
    {
        var context = snapshot.Context;
        if ((context is null || !context.IsCustomer) &&
            snapshot.Source is { } source &&
            _lastClickContext is { } latest &&
            latest.MainHwnd == source.MainHwnd)
        {
            context = latest;
        }

        if ((context is null || !context.IsCustomer) &&
            snapshot.Source is { } source2 &&
            _lastValidCustomerContext is { } valid &&
            valid.MainHwnd == source2.MainHwnd)
        {
            context = valid;
        }

        var binding = snapshot.Binding;
        if (binding is null && context is not null)
        {
            if (previewInfo.OwnerHwnd == context.MainHwnd)
            {
                binding = "owner";
            }
            else if (previewInfo.ParentHwnd == context.MainHwnd)
            {
                binding = "parent";
            }
            else if (snapshot.Source is { } source3 && source3.MainHwnd == context.MainHwnd)
            {
                binding = "source-click-context";
            }
        }

        return snapshot with { Context = context, Binding = binding };
    }

    private PreviewBinding CaptureBindingNow(WindowInfo previewInfo)
    {
        var source = _lastSourceClick;
        var context = _lastClickContext;
        if (source is not null && context is not null && context.MainHwnd != source.MainHwnd)
        {
            context = null;
        }
        if (context is null &&
            source is not null &&
            _lastValidCustomerContext is { } valid &&
            valid.MainHwnd == source.MainHwnd)
        {
            context = valid;
        }
        var sinceClickMs = _lastMouseUpAt == DateTimeOffset.MinValue
            ? (double?)null
            : (DateTimeOffset.UtcNow - _lastMouseUpAt).TotalMilliseconds;
        var byRecentClick = source is not null && sinceClickMs is not null && sinceClickMs <= 2500;
        var byOwner = context is not null && previewInfo.OwnerHwnd == context.MainHwnd;
        var byParent = context is not null && previewInfo.ParentHwnd == context.MainHwnd;
        var bySource = source is not null && context is not null && source.MainHwnd == context.MainHwnd;
        var binding = byOwner
            ? "owner"
            : byParent
                ? "parent"
                : bySource
                    ? "source-click-context"
                    : byRecentClick
                        ? "recent-click-pending-context"
                        : null;
        return new PreviewBinding(context, source, _lastMouseUpAt, sinceClickMs, binding);
    }

    private async Task<WindowInfo?> WaitForStablePreviewAsync(IntPtr hwnd, string trigger)
    {
        WindowInfo? prev = null;
        var deadline = DateTimeOffset.UtcNow + TimeSpan.FromSeconds(3);
        var stableCount = 0;
        while (DateTimeOffset.UtcNow < deadline)
        {
            await Task.Delay(120);
            var cur = WindowInfo.FromHwnd(hwnd);
            var foreground = NativeMethods.GetForegroundWindow();
            Emit(new
            {
                type = "probe-preview-stability",
                trigger,
                window = cur,
                foreground = WindowInfo.FromHwnd(foreground),
                foregroundMatches = foreground == hwnd,
                stableCount
            });
            if (cur is null || !IsConfirmedPreview(cur))
            {
                stableCount = 0;
                prev = cur;
                continue;
            }
            if (foreground != hwnd)
            {
                // 用户已经关闭/切走大图；不要补截旧窗口。
                return null;
            }
            if (prev is not null &&
                prev.Left == cur.Left &&
                prev.Top == cur.Top &&
                prev.Right == cur.Right &&
                prev.Bottom == cur.Bottom &&
                prev.Style == cur.Style &&
                prev.ExStyle == cur.ExStyle &&
                string.Equals(prev.Title, cur.Title, StringComparison.Ordinal))
            {
                stableCount++;
                if (stableCount >= 2)
                {
                    Emit(new { type = "probe-preview-settled", trigger, window = cur, stableCount });
                    return cur;
                }
            }
            else
            {
                stableCount = 0;
            }
            prev = cur;
        }
        return null;
    }

    private string PersistProbeBitmap(Bitmap bitmap, string kind, string channel, DateTimeOffset capturedAt)
    {
        Directory.CreateDirectory(_probeRoot);
        var seq = Interlocked.Increment(ref _captureSeq);
        var path = Path.Combine(_probeRoot, $"{seq:000}-{capturedAt:HHmmss-fff}-{kind}-{channel}.png");
        bitmap.Save(path, System.Drawing.Imaging.ImageFormat.Png);
        return path;
    }

    private static bool IsChatMainWindow(WindowInfo info)
    {
        if (info.ProcessName is null || !TargetProcesses.Contains(info.ProcessName)) return false;
        if (!info.Visible || info.Iconic) return false;
        if (IsConfirmedPreview(info) || IsPendingPreview(info)) return false;

        if (string.Equals(info.Channel, "wxwork", StringComparison.OrdinalIgnoreCase))
        {
            var mainClass = Environment.GetEnvironmentVariable("HYYD_WXWORK_MAIN_CLASS");
            if (string.IsNullOrWhiteSpace(mainClass)) mainClass = "WeWorkWindow";
            return string.Equals(info.ClassName, mainClass, StringComparison.Ordinal);
        }

        return string.Equals(info.Channel, "wechat", StringComparison.OrdinalIgnoreCase) &&
               string.Equals(info.Title, "微信", StringComparison.Ordinal);
    }

    private static bool IsPreviewCandidate(WindowInfo info)
    {
        if (info.ProcessName is null || !TargetProcesses.Contains(info.ProcessName)) return false;
        if (info.Iconic) return false;
        if (IsChatMainWindow(info)) return false;
        return IsConfirmedPreview(info) || IsPendingPreview(info) || IsWxworkNonMainWindow(info);
    }

    private static bool IsConfirmedPreview(WindowInfo? info)
    {
        if (info is null || info.ProcessName is null || !TargetProcesses.Contains(info.ProcessName)) return false;
        if (!info.Visible || info.Iconic) return false;
        if (string.Equals(info.Channel, "wechat", StringComparison.OrdinalIgnoreCase))
        {
            return string.Equals(info.Title, "图片和视频", StringComparison.Ordinal);
        }

        // 企微大图窗口特征还需要采样确认。probe 阶段只把非主窗口作为候选，正式逻辑不能直接照搬。
        return string.Equals(info.Channel, "wxwork", StringComparison.OrdinalIgnoreCase) &&
               IsWxworkNonMainWindow(info);
    }

    private static bool IsPendingPreview(WindowInfo info)
    {
        if (info.ProcessName is null || !TargetProcesses.Contains(info.ProcessName)) return false;
        if (string.Equals(info.Channel, "wechat", StringComparison.OrdinalIgnoreCase))
        {
            return !info.Visible && string.Equals(info.Title, "Weixin", StringComparison.Ordinal);
        }

        return string.Equals(info.Channel, "wxwork", StringComparison.OrdinalIgnoreCase) &&
               !info.Visible &&
               IsWxworkNonMainWindow(info);
    }

    private static bool IsWxworkNonMainWindow(WindowInfo info)
    {
        if (!string.Equals(info.Channel, "wxwork", StringComparison.OrdinalIgnoreCase)) return false;
        var mainClass = Environment.GetEnvironmentVariable("HYYD_WXWORK_MAIN_CLASS");
        if (string.IsNullOrWhiteSpace(mainClass)) mainClass = "WeWorkWindow";
        return !string.Equals(info.ClassName, mainClass, StringComparison.Ordinal);
    }

    private void Emit(object message)
    {
        _ = WriteEventAsync(message);
    }

    private async Task WriteEventAsync(object message)
    {
        var json = JsonSerializer.Serialize(message, JsonOptions);
        await _eventWriteLock.WaitAsync();
        try
        {
            await Console.Out.WriteLineAsync(json);
            await Console.Out.FlushAsync();
            if (_eventLog is not null)
            {
                await _eventLog.WriteLineAsync(json);
            }
        }
        finally
        {
            _eventWriteLock.Release();
        }
    }

    public void Dispose()
    {
        if (_disposed) return;
        _disposed = true;
        _running = false;
        if (_threadId != 0)
        {
            NativeMethods.PostThreadMessage(_threadId, NativeMethods.WM_QUIT, IntPtr.Zero, IntPtr.Zero);
        }
        _thread?.Join(1000);
        _thread = null;
        _threadId = 0;
        if (_ocr is IDisposable d) d.Dispose();
        _eventLog?.Dispose();
        _eventLog = null;
        _eventWriteLock.Dispose();
    }

    [StructLayout(LayoutKind.Sequential)]
    private readonly struct MouseHookStruct
    {
        public readonly WinPoint Pt;
        public readonly int MouseData;
        public readonly int Flags;
        public readonly int Time;
        public readonly IntPtr ExtraInfo;
    }

    private sealed record ProbeContext(
        DateTimeOffset CapturedAt,
        long MainHwnd,
        string Channel,
        string ProcessName,
        string ClassName,
        WinRect Rect,
        string? Title,
        bool IsCustomer,
        string? ConversationKind,
        string? OrderNo,
        string? ScreenshotPath,
        int ClickX,
        int ClickY);

    private sealed record WindowInfo(
        long Hwnd,
        string? ProcessName,
        string? Channel,
        string? ClassName,
        string? Title,
        bool Visible,
        bool Iconic,
        long OwnerHwnd,
        long ParentHwnd,
        long Style,
        long ExStyle,
        bool ToolWindow,
        int Left,
        int Top,
        int Right,
        int Bottom,
        int Width,
        int Height)
    {
        public static WindowInfo? FromHwnd(IntPtr hwnd)
        {
            if (hwnd == IntPtr.Zero) return null;

            string? processName = null;
            string? channel = null;
            try
            {
                NativeMethods.GetWindowThreadProcessId(hwnd, out var pid);
                if (pid != 0)
                {
                    using var process = Process.GetProcessById((int)pid);
                    processName = process.ProcessName.EndsWith(".exe", StringComparison.OrdinalIgnoreCase)
                        ? process.ProcessName
                        : $"{process.ProcessName}.exe";
                    channel = processName.Equals("WXWork.exe", StringComparison.OrdinalIgnoreCase)
                        ? "wxwork"
                        : processName.Equals("WeChat.exe", StringComparison.OrdinalIgnoreCase) ||
                          processName.Equals("Weixin.exe", StringComparison.OrdinalIgnoreCase)
                            ? "wechat"
                            : null;
                }
            }
            catch
            {
                // Keep null process fields; the probe should still emit hwnd/style data.
            }

            var visible = NativeMethods.IsWindowVisible(hwnd);
            var iconic = NativeMethods.IsIconic(hwnd);
            var owner = NativeMethods.GetWindow(hwnd, NativeMethods.GW_OWNER);
            var parent = NativeMethods.GetParent(hwnd);
            var style = NativeMethods.GetWindowLongPtr(hwnd, NativeMethods.GWL_STYLE).ToInt64();
            var exStyle = NativeMethods.GetWindowLongPtr(hwnd, NativeMethods.GWL_EXSTYLE).ToInt64();
            var tool = (exStyle & NativeMethods.WS_EX_TOOLWINDOW) != 0;
            _ = NativeMethods.GetWindowRect(hwnd, out var rect);

            return new WindowInfo(
                hwnd.ToInt64(),
                processName,
                channel,
                ReadClassName(hwnd),
                ReadTitle(hwnd),
                visible,
                iconic,
                owner.ToInt64(),
                parent.ToInt64(),
                style,
                exStyle,
                tool,
                rect.Left,
                rect.Top,
                rect.Right,
                rect.Bottom,
                rect.Width,
                rect.Height);
        }

        private static string ReadTitle(IntPtr hwnd)
        {
            var builder = new StringBuilder(512);
            _ = NativeMethods.GetWindowText(hwnd, builder, builder.Capacity);
            return builder.ToString();
        }

        private static string ReadClassName(IntPtr hwnd)
        {
            var builder = new StringBuilder(256);
            _ = NativeMethods.GetClassName(hwnd, builder, builder.Capacity);
            return builder.ToString();
        }
    }
}

namespace Hyyd.CaptureSidecar;

internal enum DedupAction
{
    Keep,
    Skip
}

internal sealed record DedupDecision(DedupAction Action, string Reason, double DiffScore);

/// <summary>
/// 关键帧筛选：纯视觉判断（不依赖 OCR）。每个渠道维护"最近 N 张被保留的关键帧"指纹，
/// 当前帧与这 N 张逐一比较——与任意一张几乎无像素差异即视为重复跳过。
/// 这样"切到别的会话又切回、画面没变"产生的重复图也能被识别（不仅仅比相邻的上一张）。
/// 长时间静止用 heartbeat 兜底保留一张。
/// </summary>
internal sealed class FrameDeduplicator
{
    private sealed class ChannelState
    {
        public List<FrameSignature> History { get; } = new(); // 最近被保留的指纹（旧→新）
        public int WindowWidth { get; set; }
        public int WindowHeight { get; set; }
        public DateTimeOffset KeptAt { get; set; }
    }

    private readonly double _diffThreshold;
    private readonly int _perPixelThreshold;
    private readonly TimeSpan _heartbeat;
    private readonly int _historySize;
    private readonly Dictionary<string, ChannelState> _states = new(StringComparer.Ordinal);

    public int ThumbnailWidth { get; }

    public string ConfigSummary =>
        $"diff阈值={_diffThreshold} 像素阈值={_perPixelThreshold} 心跳={_heartbeat.TotalSeconds:0}s 历史={_historySize}张 缩略图宽={ThumbnailWidth}";

    public FrameDeduplicator()
    {
        // 阈值全部可通过环境变量覆盖；默认偏保守（宁可多保留）。
        _diffThreshold = ReadDouble("HYYD_CAPTURE_DIFF_THRESHOLD", 0.002);
        _perPixelThreshold = (int)ReadDouble("HYYD_CAPTURE_PIXEL_THRESHOLD", 24);
        _heartbeat = TimeSpan.FromSeconds(ReadDouble("HYYD_CAPTURE_HEARTBEAT_SECONDS", 300));
        ThumbnailWidth = Math.Max(64, (int)ReadDouble("HYYD_CAPTURE_THUMBNAIL_WIDTH", 320));
        _historySize = Math.Max(1, (int)ReadDouble("HYYD_CAPTURE_DEDUP_HISTORY", 30));
    }

    public DedupDecision Decide(string channel, int winW, int winH, FrameSignature sig, DateTimeOffset now)
    {
        if (!_states.TryGetValue(channel, out var state))
        {
            state = new ChannelState();
            _states[channel] = state;
            Commit(state, winW, winH, sig, now);
            return new DedupDecision(DedupAction.Keep, "first_frame", 0);
        }

        // 窗口尺寸变了（缩放/最大化切换），缩略图无法对齐，清空历史并保留
        if (state.WindowWidth != winW || state.WindowHeight != winH)
        {
            state.History.Clear();
            Commit(state, winW, winH, sig, now);
            return new DedupDecision(DedupAction.Keep, "size_changed", 1.0);
        }

        // 与最近 N 张被保留帧逐一比，命中任意一张（几乎无差异）即算重复
        double minDiff = 1.0;
        foreach (var h in state.History)
        {
            double d = sig.DiffAgainst(h, _perPixelThreshold);
            if (d < minDiff) minDiff = d;
            if (d < _diffThreshold)
            {
                // 与近期某张几乎相同：默认跳过；但超过 heartbeat 间隔仍保留一张证明窗口还开着
                if (now - state.KeptAt >= _heartbeat)
                {
                    Commit(state, winW, winH, sig, now);
                    return new DedupDecision(DedupAction.Keep, "heartbeat", d);
                }
                return new DedupDecision(DedupAction.Skip, "near_duplicate", d);
            }
        }

        // 与最近 N 张都不同 → 保留
        Commit(state, winW, winH, sig, now);
        return new DedupDecision(DedupAction.Keep, "visual_changed", minDiff);
    }

    public void ResetAll() => _states.Clear();

    private void Commit(ChannelState state, int winW, int winH, FrameSignature sig, DateTimeOffset now)
    {
        state.WindowWidth = winW;
        state.WindowHeight = winH;
        state.KeptAt = now;
        state.History.Add(sig);
        if (state.History.Count > _historySize)
        {
            state.History.RemoveAt(0);
        }
    }

    private static double ReadDouble(string key, double fallback)
    {
        var v = Environment.GetEnvironmentVariable(key);
        return double.TryParse(v, out var parsed) ? parsed : fallback;
    }
}

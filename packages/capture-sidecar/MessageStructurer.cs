using System.Drawing;
using System.Text.RegularExpressions;

namespace Hyyd.CaptureSidecar;

/// <summary>
/// 路线1：把一张聊天截图的 OCR 结果 + 像素，结构化成"带说话人"的消息列表。
/// 说话人判定不靠 AI 猜，靠确定性规则：
///   - 气泡背景"有色(高饱和=绿/蓝)" → self；"灰/白(低饱和)" → other（深浅色模式都成立，自己永远是有色那个）
///   - 辅以左右位置（右=self、左=other）做兜底
///   - 居中 + 时间/日期/撤回 文案 → system
/// 区域上裁掉顶部标题栏、底部输入框（按比例，可调）。侧边会话列表暂不裁（默认全宽，后续按真实全窗口截图调 left 比例）。
/// 这是第一版，阈值/比例都走环境变量，便于在真实截图上调。
/// </summary>
internal static class MessageStructurer
{
    private static double EnvD(string key, double dflt)
    {
        var v = Environment.GetEnvironmentVariable(key);
        return double.TryParse(v, out var d) ? d : dflt;
    }

    // 列检测：把所有词块 X 投影成覆盖直方图，栏与栏之间是宽空白竖条；按空白条切列，取最宽的密集列 = 聊天区。
    // 纯动态：每张图用自己的 OCR 坐标算，不写死比例/坐标，不受窗口大小、成员面板开合影响。
    private static (int x0, int x1) DetectChatXRange(IReadOnlyList<OcrBlock> blocks, int w)
    {
        int gapMin = (int)EnvD("HYYD_CHAT_COL_GAP", 18); // 视作栏间隙的最小空白宽
        int minBlocks = (int)EnvD("HYYD_CHAT_COL_MINBLOCKS", 5);
        var cover = new int[w];
        foreach (var b in blocks)
        {
            int xs = Math.Max(0, b.Bbox.X), xe = Math.Min(w, b.Bbox.X + b.Bbox.Width);
            for (int x = xs; x < xe; x++) cover[x]++;
        }
        // 扫描切列：一列持续到遇见 >=gapMin 的连续空白；小于 gapMin 的空白算列内
        var cols = new List<(int s, int e)>();
        int i = 0;
        while (i < w)
        {
            while (i < w && cover[i] == 0) i++;
            if (i >= w) break;
            int s = i, lastNonZero = i;
            while (i < w)
            {
                if (cover[i] > 0) { lastNonZero = i; i++; }
                else
                {
                    int z = i;
                    while (z < w && cover[z] == 0) z++;
                    if (z - i >= gapMin) break; // 栏间隙，列结束
                    i = z; // 列内小空白，继续
                }
            }
            cols.Add((s, lastNonZero + 1));
        }
        // 取 块数>=minBlocks 的列里最宽的
        (int s, int e) best = (0, w);
        int bestWidth = -1;
        foreach (var c in cols)
        {
            int n = blocks.Count(b =>
            {
                var cx = b.Bbox.X + b.Bbox.Width / 2;
                return cx >= c.s && cx < c.e;
            });
            if (n >= minBlocks && c.e - c.s > bestWidth) { bestWidth = c.e - c.s; best = c; }
        }
        return best;
    }

    // 气泡"有色"判定的饱和度阈值（≥ 视为 self）
    private static double SatThreshold => EnvD("HYYD_BUBBLE_SAT", 0.15);

    private static readonly Regex TimeLine = new(
        @"^\s*(\d{1,2}\s*[:：]\s*\d{2}|\d{1,2}\s*月\s*\d{1,2}\s*日|昨天|星期[一二三四五六日天]|上午|下午|\d{2}/\d{1,2}/\d{1,2})",
        RegexOptions.Compiled);
    private static readonly Regex SystemKeyword = new(
        @"撤回|以下为新消息|拍了拍|加入了群聊|邀请|领取了你的|红包",
        RegexOptions.Compiled);

    private sealed class Line
    {
        public readonly List<OcrBlock> Words = new();
        public int MinX, MinY, MaxX, MaxY;
        public int CenterY => (MinY + MaxY) / 2;
        public int Height => MaxY - MinY;
        public string Text => string.Join(string.Empty, Words.OrderBy(w => w.Bbox.X).Select(w => w.Text));
    }

    // 词块 → 行：按 Y 顺序，垂直中心重叠算同一行
    private static List<Line> GroupLines(IEnumerable<OcrBlock> blocks)
    {
        var lines = new List<Line>();
        foreach (var b in blocks.OrderBy(b => b.Bbox.Y).ThenBy(b => b.Bbox.X))
        {
            var cy = b.Bbox.Y + b.Bbox.Height / 2;
            var last = lines.Count > 0 ? lines[^1] : null;
            // 同一行：垂直中心重叠即可。（列检测已隔离聊天列，不再需要 X 间隔断行——那样会切坏正常多行消息）
            if (last != null && Math.Abs(cy - last.CenterY) <= Math.Max(b.Bbox.Height, last.Height) * 0.6)
            {
                last.Words.Add(b);
                last.MinX = Math.Min(last.MinX, b.Bbox.X);
                last.MinY = Math.Min(last.MinY, b.Bbox.Y);
                last.MaxX = Math.Max(last.MaxX, b.Bbox.X + b.Bbox.Width);
                last.MaxY = Math.Max(last.MaxY, b.Bbox.Y + b.Bbox.Height);
            }
            else
            {
                var ln = new Line
                {
                    MinX = b.Bbox.X,
                    MinY = b.Bbox.Y,
                    MaxX = b.Bbox.X + b.Bbox.Width,
                    MaxY = b.Bbox.Y + b.Bbox.Height
                };
                ln.Words.Add(b);
                lines.Add(ln);
            }
        }
        return lines;
    }

    public static IReadOnlyList<StructuredMessage> Build(Bitmap bmp, IReadOnlyList<OcrBlock> blocks, string channel)
    {
        if (blocks.Count == 0) return Array.Empty<StructuredMessage>();
        int w = bmp.Width, h = bmp.Height;
        // 1) 列检测（动态，按本张图自己的 OCR 坐标算，不写死比例/坐标）：
        //    X 投影 → 找栏间空白竖条 → 取最宽的密集列 = 聊天区。
        //    天然排除 图标栏/会话列表/右侧成员面板/工具栏，且不受窗口大小、面板开合影响。
        var (chatX0, chatX1) = DetectChatXRange(blocks, w);
        // 顶/底仍按比例轻裁（标题栏/输入框；这俩沿垂直方向，远不如左右栏敏感）。
        int top = (int)(h * EnvD("HYYD_CHAT_TOP_FRAC", 0.08));
        int bottom = h - (int)(h * EnvD("HYYD_CHAT_BOTTOM_FRAC", 0.10));

        var inChat = blocks
            .Where(b =>
            {
                var cx = b.Bbox.X + b.Bbox.Width / 2;
                var cy = b.Bbox.Y + b.Bbox.Height / 2;
                return cy >= top && cy <= bottom && cx >= chatX0 && cx < chatX1;
            })
            .ToList();
        if (inChat.Count == 0) return Array.Empty<StructuredMessage>();

        // 2) 词 → 行
        var lines = GroupLines(inChat);
        if (lines.Count == 0) return Array.Empty<StructuredMessage>();

        var lineH = Median(lines.Select(l => l.Height).Where(x => x > 0).ToList());
        if (lineH <= 0) lineH = 20;
        var midX = (chatX0 + chatX1) / 2.0;

        // 3) 行 → 消息（气泡）：垂直间隔大 或 左右侧切换 → 新消息
        var msgs = new List<List<Line>>();
        foreach (var ln in lines)
        {
            bool newMsg = msgs.Count == 0;
            if (!newMsg)
            {
                var cur = msgs[^1];
                var gap = ln.MinY - cur[^1].MaxY;
                var sidePrev = SideOf(cur[^1], midX);
                var sideCur = SideOf(ln, midX);
                if (gap > lineH * 0.9 || sidePrev != sideCur) newMsg = true;
            }
            if (newMsg) msgs.Add(new List<Line> { ln });
            else msgs[^1].Add(ln);
        }

        // 4) 每条消息判说话人
        var result = new List<StructuredMessage>();
        foreach (var m in msgs)
        {
            var text = string.Join("\n", m.Select(l => l.Text)).Trim();
            if (text.Length == 0) continue;

            int mnX = m.Min(l => l.MinX), mxX = m.Max(l => l.MaxX);
            int mnY = m.Min(l => l.MinY), mxY = m.Max(l => l.MaxY);
            var center = (mnX + mxX) / 2.0;

            // system：单行、居中、时间/日期/撤回等
            if (m.Count == 1 && Math.Abs(center - midX) < (chatX1 - chatX0) * 0.18 &&
                (TimeLine.IsMatch(text) || SystemKeyword.IsMatch(text)) && text.Length <= 30)
            {
                result.Add(new StructuredMessage("system", null, text));
                continue;
            }

            var speaker = ClassifySpeaker(bmp, mnX, mnY, mxX, mxY, center, midX);
            result.Add(new StructuredMessage(speaker, null, text));
        }
        return result;
    }

    private static string SideOf(Line ln, double midX)
    {
        var c = (ln.MinX + ln.MaxX) / 2.0;
        return c >= midX ? "R" : "L";
    }

    // 颜色为主、位置兜底
    private static string ClassifySpeaker(Bitmap bmp, int x0, int y0, int x1, int y1, double center, double midX)
    {
        var fill = SampleFill(bmp, x0, y0, x1, y1);
        if (fill is { } c)
        {
            var (_, s, _) = ToHsv(c.R, c.G, c.B);
            if (s >= SatThreshold) return "self"; // 有色气泡（绿/蓝）= 自己（深浅色模式都成立）
            // 低饱和（灰/白）= 对方
            return "other";
        }
        // 取不到颜色 → 用左右位置
        return center >= midX ? "self" : "other";
    }

    // 网格采样气泡填充色：跳过近黑（文字）像素，对其余取平均 → 气泡底色
    private static (int R, int G, int B)? SampleFill(Bitmap bmp, int x0, int y0, int x1, int y1)
    {
        x0 = Math.Max(0, x0 - 4);
        y0 = Math.Max(0, y0);
        x1 = Math.Min(bmp.Width - 1, x1 + 4);
        y1 = Math.Min(bmp.Height - 1, y1);
        if (x1 <= x0 || y1 <= y0) return null;
        int stepX = Math.Max(1, (x1 - x0) / 24), stepY = Math.Max(1, (y1 - y0) / 8);
        long sr = 0, sg = 0, sb = 0;
        int n = 0;
        for (int y = y0; y <= y1; y += stepY)
        {
            for (int x = x0; x <= x1; x += stepX)
            {
                var p = bmp.GetPixel(x, y);
                int lum = (p.R * 30 + p.G * 59 + p.B * 11) / 100;
                if (lum < 70) continue; // 跳过文字笔画（深色）
                sr += p.R;
                sg += p.G;
                sb += p.B;
                n++;
            }
        }
        if (n == 0) return null;
        return ((int)(sr / n), (int)(sg / n), (int)(sb / n));
    }

    private static (double H, double S, double V) ToHsv(int r, int g, int b)
    {
        double rd = r / 255.0, gd = g / 255.0, bd = b / 255.0;
        double max = Math.Max(rd, Math.Max(gd, bd)), min = Math.Min(rd, Math.Min(gd, bd));
        double v = max;
        double s = max <= 0 ? 0 : (max - min) / max;
        double h = 0, d = max - min;
        if (d > 0)
        {
            if (max == rd) h = (gd - bd) / d % 6;
            else if (max == gd) h = (bd - rd) / d + 2;
            else h = (rd - gd) / d + 4;
            h *= 60;
            if (h < 0) h += 360;
        }
        return (h, s, v);
    }

    private static int Median(List<int> xs)
    {
        if (xs.Count == 0) return 0;
        xs.Sort();
        return xs[xs.Count / 2];
    }
}

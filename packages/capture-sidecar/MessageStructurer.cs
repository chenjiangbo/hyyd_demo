using System.Drawing;
using System.Text.RegularExpressions;

namespace Hyyd.CaptureSidecar;

/// <summary>
/// 把一张聊天截图的 OCR 词块 + 像素，结构化成「标题 + 带说话人的消息列表」。
/// 全在 sidecar 本地做（分区→拼行→判说话人→抽昵称），后端不再二次结构化。
///
/// 判说话人不靠 AI 猜，靠确定性的**左右位置**规则（见 §9.2）：
///   - 气泡靠右 → self（自己/专员）；靠左 → other（对方/客户）；居中且窄 → system（时间/通知）
///   - 颜色（气泡底色饱和度）仅在左右几乎对称的模糊带里做辅助，不同机器色差不影响主判据
///
/// 阈值都走环境变量，便于在真实截图上标定（默认值见各 EnvD）。
/// </summary>
internal static class MessageStructurer
{
    private static double EnvD(string key, double dflt)
    {
        var v = Environment.GetEnvironmentVariable(key);
        return double.TryParse(v, out var d) ? d : dflt;
    }

    // ── 阈值（相对量，不写死像素；换机器/分辨率不变） ──────────────────────────
    private static double CenterThresh => EnvD("HYYD_MSG_CENTER_THRESH", 0.12);    // |L-R| < 此值视为居中(system 候选)
    private static double CenterWidthFrac => EnvD("HYYD_MSG_CENTER_WIDTH", 0.6);   // 居中还要求气泡宽度 < 整区宽×此值（排除占满整宽的长消息）

    private static readonly Regex TimeLine = new(
        @"^\s*(\d{1,2}\s*[:：]\s*\d{2}|\d{1,2}\s*月\s*\d{1,2}\s*日|昨天|前天|星期[一二三四五六日天]|上午|下午|凌晨|中午|晚上|\d{2,4}[-/]\d{1,2}[-/]\d{1,2})",
        RegexOptions.Compiled);
    // 群通知/系统提示（可用 HYYD_CAPTURE_SYSTEM_KEYWORDS 追加，逗号分隔）
    private static readonly Regex SystemKeyword = BuildSystemKeyword();

    private static Regex BuildSystemKeyword()
    {
        var baseWords = new List<string>
        {
            "撤回", "以下为新消息", "拍了拍", "加入了群聊", "邀请", "领取了你的", "红包",
            "现在可以开始聊天", "已添加", "成为好友", "你已添加了", "通过了你的朋友验证",
            "对方正在输入", "该消息类型暂不支持", "进入了群聊", "移出了群聊", "修改群名"
        };
        var extra = Environment.GetEnvironmentVariable("HYYD_CAPTURE_SYSTEM_KEYWORDS");
        if (!string.IsNullOrWhiteSpace(extra))
        {
            baseWords.AddRange(extra.Split(new[] { ',', '，' }, StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries));
        }
        return new Regex(string.Join("|", baseWords.Select(Regex.Escape)), RegexOptions.Compiled);
    }

    /// 选聊天区：左界来自联系人列表行右端的重复最大值；企微右界只认"群成员"文字锚点。
    private static (int x0, int x1) DetectChatXRange(IReadOnlyList<OcrBlock> blocks, int w, string channel)
    {
        var contactRight = DetectContactRight(blocks, w);
        var leftPadding = (int)EnvD("HYYD_CHAT_LEFT_PADDING", 15);
        var chatX0 = Math.Min(w - 1, contactRight + leftPadding);
        var chatX1 = w;

        if (string.Equals(channel, "wxwork", StringComparison.OrdinalIgnoreCase))
        {
            var memberLeft = DetectGroupMemberLeft(blocks, chatX0);
            if (memberLeft != null)
            {
                chatX1 = memberLeft.Value;
            }
        }

        if (chatX1 <= chatX0)
        {
            throw new InvalidOperationException($"聊天区分区失败：右界 {chatX1} 不大于左界 {chatX0}。");
        }
        return (chatX0, chatX1);
    }

    private static int DetectContactRight(IReadOnlyList<OcrBlock> blocks, int w)
    {
        var minContactX = Math.Max(80, (int)(w * EnvD("HYYD_CONTACT_MIN_X_FRAC", 0.08)));
        var maxContactCenterX = w * EnvD("HYYD_CONTACT_MAX_CENTER_FRAC", 0.40);
        var minSupport = (int)EnvD("HYYD_CONTACT_RIGHT_MIN_SUPPORT", 2);

        var contactBlocks = blocks.Where(b =>
        {
            var cx = b.Bbox.X + b.Bbox.Width / 2.0;
            return b.Bbox.X >= minContactX && cx < maxContactCenterX;
        }).ToList();
        if (contactBlocks.Count == 0)
        {
            throw new InvalidOperationException("聊天区分区失败：左侧联系人候选 OCR 块为空。");
        }

        var rightCounts = ToLines(contactBlocks)
            .Select(l => l.MaxX)
            .GroupBy(x => x)
            .Select(g => new { Right = g.Key, Count = g.Count() })
            .OrderByDescending(g => g.Right)
            .ToList();

        var selected = rightCounts.FirstOrDefault(g => g.Count >= minSupport);
        if (selected == null)
        {
            var debug = string.Join(", ", rightCounts.Select(g => $"{g.Right}×{g.Count}"));
            throw new InvalidOperationException($"聊天区分区失败：联系人右边界没有重复值（{debug}）。");
        }

        return selected.Right;
    }

    private static int? DetectGroupMemberLeft(IReadOnlyList<OcrBlock> blocks, int chatX0)
    {
        foreach (var line in ToLines(blocks))
        {
            var words = line.Words.OrderBy(w => w.Bbox.X).ToList();
            for (int i = 0; i < words.Count; i++)
            {
                if (words[i].Bbox.X <= chatX0) continue;
                var text = string.Join(string.Empty, words.Skip(i).Take(8).Select(w => w.Text));
                if (text.Contains("群成员", StringComparison.Ordinal))
                {
                    return words[i].Bbox.X;
                }
            }
        }
        return null;
    }

    private static int? DetectSendButtonY(IReadOnlyList<Line> lines, int chatX0, int chatX1, int h)
    {
        var W = Math.Max(1, chatX1 - chatX0);
        foreach (var line in lines.OrderByDescending(l => l.MinY))
        {
            if (line.CenterY < h * 0.55) continue;
            if (line.MinX < chatX0 + W * 0.45) continue;
            var text = line.Text.Replace(" ", string.Empty);
            if (text.Contains("发送", StringComparison.Ordinal))
            {
                return line.MinY;
            }
        }
        return null;
    }

    // ── 词块 → 行 ──────────────────────────────────────────────────────────────
    private sealed class Line
    {
        public readonly List<OcrBlock> Words = new();
        public int MinX, MinY, MaxX, MaxY;
        public int CenterY => (MinY + MaxY) / 2;
        public int CenterX => (MinX + MaxX) / 2;
        public int Height => MaxY - MinY;
        public string Text => string.Join(string.Empty, Words.OrderBy(w => w.Bbox.X).Select(w => w.Text));
    }

    private sealed record BubbleRegion(int X, int Y, int W, int H, int Area, int MaxRow)
    {
        public int MaxX => X + W;
        public int MaxY => Y + H;
        public int CenterX => X + W / 2;
    }

    // RapidOCR 当前输出已经是行级结果；这里只做轻量封装，不再把多个块二次拼成一行。
    private static List<Line> ToLines(IEnumerable<OcrBlock> blocks)
    {
        var lines = new List<Line>();
        foreach (var b in blocks.OrderBy(b => b.Bbox.Y).ThenBy(b => b.Bbox.X))
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
        return lines;
    }

    private static List<BubbleRegion> DetectBubbleRegions(Bitmap bmp, int chatX0, int chatX1, int y0, int y1, string channel)
    {
        var width = bmp.Width;
        var height = bmp.Height;
        y0 = Math.Clamp(y0, 0, height - 1);
        y1 = Math.Clamp(y1, y0 + 1, height);
        chatX0 = Math.Clamp(chatX0, 0, width - 1);
        chatX1 = Math.Clamp(chatX1, chatX0 + 1, width);

        var mask = new bool[width, height];
        for (int y = y0; y < y1; y++)
        {
            for (int x = chatX0; x < chatX1; x++)
            {
                if (IsBubbleFill(bmp.GetPixel(x, y), channel))
                {
                    mask[x, y] = true;
                }
            }
        }

        var closed = Erode(Dilate(mask, width, height, chatX0, chatX1, y0, y1, 3), width, height, chatX0, chatX1, y0, y1, 2);
        var seen = new bool[width, height];
        var regions = new List<BubbleRegion>();
        var q = new Queue<(int X, int Y)>();
        var dirs = new (int X, int Y)[] { (1, 0), (-1, 0), (0, 1), (0, -1) };

        for (int y = y0; y < y1; y++)
        {
            for (int x = chatX0; x < chatX1; x++)
            {
                if (!closed[x, y] || seen[x, y]) continue;

                int minX = x, maxX = x, minY = y, maxY = y, area = 0;
                var rowCounts = new Dictionary<int, int>();
                q.Clear();
                q.Enqueue((x, y));
                seen[x, y] = true;

                while (q.Count > 0)
                {
                    var cur = q.Dequeue();
                    area++;
                    minX = Math.Min(minX, cur.X);
                    maxX = Math.Max(maxX, cur.X);
                    minY = Math.Min(minY, cur.Y);
                    maxY = Math.Max(maxY, cur.Y);
                    rowCounts[cur.Y] = rowCounts.TryGetValue(cur.Y, out var c) ? c + 1 : 1;

                    foreach (var d in dirs)
                    {
                        var nx = cur.X + d.X;
                        var ny = cur.Y + d.Y;
                        if (nx < chatX0 || nx >= chatX1 || ny < y0 || ny >= y1) continue;
                        if (!closed[nx, ny] || seen[nx, ny]) continue;
                        seen[nx, ny] = true;
                        q.Enqueue((nx, ny));
                    }
                }

                var w = maxX - minX + 1;
                var h = maxY - minY + 1;
                if (area < 120 || w < 18 || h < 12) continue;

                var maxRow = rowCounts.Values.DefaultIfEmpty().Max();
                var threshold = Math.Max(24, maxRow * 0.28);
                var solidRows = rowCounts
                    .Where(kv => kv.Value >= threshold)
                    .Select(kv => kv.Key)
                    .Order()
                    .ToList();
                if (solidRows.Count > 0)
                {
                    minY = solidRows[0];
                    maxY = solidRows[^1];
                    h = maxY - minY + 1;
                }

                if (IsLikelyBubbleRegion(minX, minY, w, h, chatX0, chatX1, y0, y1))
                {
                    regions.Add(new BubbleRegion(minX, minY, w, h, area, maxRow));
                }
            }
        }

        return regions.OrderBy(r => r.Y).ThenBy(r => r.X).ToList();
    }

    private static bool IsBubbleFill(Color p, string channel)
    {
        if (p.A < 200) return false;
        if (string.Equals(channel, "wxwork", StringComparison.OrdinalIgnoreCase))
        {
            return p.R >= 188 && p.R <= 215 &&
                   p.G >= 220 && p.G <= 240 &&
                   p.B >= 248 && p.B <= 255;
        }

        var neutral = Math.Abs(p.R - p.G) <= 4 && Math.Abs(p.G - p.B) <= 5;
        var lightGrayBubble = neutral && p.R >= 228 && p.R <= 246 && p.G >= 228 && p.G <= 246 && p.B >= 228 && p.B <= 247;
        var greenBubble = p.G >= 220 && p.G <= 248 && p.R >= 145 && p.R <= 185 && p.B >= 145 && p.B <= 185;
        return lightGrayBubble || greenBubble;
    }

    private static bool IsLikelyBubbleRegion(int x, int y, int w, int h, int chatX0, int chatX1, int y0, int y1)
    {
        if (w <= 45 && h <= 45) return false;
        if (h < 10) return false;
        if (w <= 40 && h >= 60) return false;
        if (w <= 32 && h >= 100) return false;
        if (h <= 22 && w <= 90) return false;
        if (h <= 12 && w <= 140) return false;
        if (x <= chatX0 + 36 && w <= 42) return false;
        if (x + w >= chatX1 - 18 && w <= 42) return false;
        if (y >= y1 - 140 && w <= 32 && h >= 80) return false;
        return true;
    }

    private static bool[,] Dilate(bool[,] src, int width, int height, int x0, int x1, int y0, int y1, int radius)
    {
        var dst = new bool[width, height];
        for (int y = y0; y < y1; y++)
        {
            for (int x = x0; x < x1; x++)
            {
                var on = false;
                for (int dy = -radius; dy <= radius && !on; dy++)
                {
                    for (int dx = -radius; dx <= radius; dx++)
                    {
                        var xx = x + dx;
                        var yy = y + dy;
                        if (xx < x0 || xx >= x1 || yy < y0 || yy >= y1) continue;
                        if (src[xx, yy]) { on = true; break; }
                    }
                }
                dst[x, y] = on;
            }
        }
        return dst;
    }

    private static bool[,] Erode(bool[,] src, int width, int height, int x0, int x1, int y0, int y1, int radius)
    {
        var dst = new bool[width, height];
        for (int y = y0; y < y1; y++)
        {
            for (int x = x0; x < x1; x++)
            {
                var on = true;
                for (int dy = -radius; dy <= radius && on; dy++)
                {
                    for (int dx = -radius; dx <= radius; dx++)
                    {
                        var xx = x + dx;
                        var yy = y + dy;
                        if (xx < x0 || xx >= x1 || yy < y0 || yy >= y1 || !src[xx, yy])
                        {
                            on = false;
                            break;
                        }
                    }
                }
                dst[x, y] = on;
            }
        }
        return dst;
    }

    // ── 主入口 ──────────────────────────────────────────────────────────────────
    public static StructureResult Build(Bitmap bmp, IReadOnlyList<OcrBlock> blocks, string channel)
    {
        if (blocks.Count == 0) return new StructureResult(null, Array.Empty<StructuredMessage>());
        int w = bmp.Width;

        // 1) 分区：切出聊天区（已排除图标栏/联系人列表/(企微)成员区）
        var (chatX0, chatX1) = DetectChatXRange(blocks, w, channel);
        double W = Math.Max(1, chatX1 - chatX0);

        var inChat = blocks.Where(b =>
        {
            var cx = b.Bbox.X + b.Bbox.Width / 2;
            return cx >= chatX0 && cx < chatX1;
        }).ToList();
        int dropped = blocks.Count - inChat.Count; // 聊天区外被丢弃的词块（联系人区/图标栏/成员区）
        if (inChat.Count == 0) return new StructureResult(null, Array.Empty<StructuredMessage>(), chatX0, chatX1, null, null, dropped);

        // 2) 拼行
        var lines = ToLines(inChat);
        if (lines.Count == 0) return new StructureResult(null, Array.Empty<StructuredMessage>(), chatX0, chatX1, null, null, dropped);

        // 3) 标题 = 跳过窗口系统按钮后的聊天区顶行。RapidOCR 会识别右上角 □/×，
        // 这些不属于聊天区标题。
        var topChromeY = Math.Max(28, (int)(bmp.Height * 0.04));
        var contentLines = lines.Where(l => l.MinY >= topChromeY).ToList();
        if (contentLines.Count == 0)
        {
            return new StructureResult(null, Array.Empty<StructuredMessage>(), chatX0, chatX1, null, null, dropped);
        }
        var titleLine = contentLines[0];
        var title = titleLine.Text;

        // 4) 像素 → 气泡。OCR 只提供文字行；消息边界以截图里的气泡/卡片底色为准。
        // 输入区分区先不参与正式结果，但发送按钮同一行及其下方的工具栏 OCR 需要丢弃。
        var lineH = Median(contentLines.Select(l => l.Height).Where(x => x > 0).ToList());
        if (lineH <= 0) lineH = 20;
        var bodyLines = contentLines.Skip(1).ToList();

        var sendLine = contentLines
            .Where(l => l.Text.Replace(" ", string.Empty).Contains("发送", StringComparison.Ordinal))
            .Where(l => l.CenterY >= bmp.Height * 0.55)
            .OrderByDescending(l => l.MinY)
            .FirstOrDefault();
        var visibleBodyLines = bodyLines
            .Where(l => !IsInputNoiseLine(l, sendLine))
            .ToList();
        if (visibleBodyLines.Count == 0)
        {
            return new StructureResult(title, Array.Empty<StructuredMessage>(), chatX0, chatX1, null, null, dropped);
        }

        var midX = (chatX0 + chatX1) / 2.0;
        var scanY0 = Math.Min(bmp.Height - 1, Math.Max(titleLine.MaxY + 4, topChromeY + 20));
        var scanY1 = sendLine == null
            ? Math.Min(bmp.Height, (int)(bmp.Height * 0.92))
            : Math.Clamp(sendLine.MinY - 4, scanY0 + 1, bmp.Height);
        var regions = DetectBubbleRegions(bmp, chatX0, chatX1, scanY0, scanY1, channel);
        if (regions.Count == 0)
        {
            throw new InvalidOperationException($"消息气泡检测失败：聊天区 {chatX0}-{chatX1}，扫描 Y={scanY0}-{scanY1}。");
        }

        // 5) 气泡内文字 → 消息；气泡外且相对居中的文字 → system。
        var result = new List<StructuredMessage>();
        var usedLines = new HashSet<Line>();
        foreach (var region in regions)
        {
            var inside = visibleBodyLines
                .Where(l => LineInsideRegion(l, region, pad: 6))
                .OrderBy(l => l.MinY)
                .ThenBy(l => l.MinX)
                .ToList();
            if (inside.Count == 0) continue;

            var speaker = region.CenterX >= midX ? "self" : "other";
            string? sender = null;
            if (speaker == "other")
            {
                if (!PromoteOverlappingSenderName(inside, region, lineH, ref sender))
                {
                    sender = FindSenderNameForRegion(visibleBodyLines, regions, region, midX, lineH);
                }
            }

            foreach (var line in inside) usedLines.Add(line);
            var text = string.Join("\n", inside.Select(l => l.Text)).Trim();
            if (text.Length == 0) continue;

            var box = new MsgBox(region.X, region.Y, region.W, region.H);
            var leftGap = (region.X - chatX0) / W;
            var rightGap = (chatX1 - region.MaxX) / W;
            result.Add(new StructuredMessage(speaker, string.IsNullOrEmpty(sender) ? null : sender, text, null, box, leftGap, rightGap, "bubble"));
        }

        foreach (var line in visibleBodyLines.OrderBy(l => l.MinY).ThenBy(l => l.MinX))
        {
            if (usedLines.Contains(line)) continue;
            if (LineInsideAnyRegion(line, regions, pad: 6)) continue;
            if (!IsCenteredSystemLine(line, chatX0, chatX1)) continue;

            var text = line.Text.Trim();
            if (text.Length == 0) continue;
            string kind = TimeLine.IsMatch(text) ? "time" : SystemKeyword.IsMatch(text) ? "notice" : "other";
            var box = new MsgBox(line.MinX, line.MinY, line.MaxX - line.MinX, line.MaxY - line.MinY);
            var leftGap = (line.MinX - chatX0) / W;
            var rightGap = (chatX1 - line.MaxX) / W;
            result.Add(new StructuredMessage("system", null, text, kind, box, leftGap, rightGap, "center"));
        }

        result = result
            .OrderBy(m => m.Box?.Y ?? 0)
            .ThenBy(m => m.Box?.X ?? 0)
            .ToList();
        return new StructureResult(title, result, chatX0, chatX1, null, null, dropped);
    }

    private static bool IsInputNoiseLine(Line line, Line? sendLine)
    {
        if (sendLine == null) return false;
        if (line.MinY >= sendLine.MinY) return true;
        return Math.Abs(line.CenterY - sendLine.CenterY) <= Math.Max(18, sendLine.Height);
    }

    private static bool LineInsideRegion(Line line, BubbleRegion region, int pad)
    {
        return line.CenterX >= region.X - pad &&
               line.CenterX <= region.MaxX + pad &&
               line.CenterY >= region.Y - pad &&
               line.CenterY <= region.MaxY + pad;
    }

    private static bool LineInsideAnyRegion(Line line, IReadOnlyList<BubbleRegion> regions, int pad)
        => regions.Any(region => LineInsideRegion(line, region, pad));

    private static string? FindSenderNameForRegion(
        IReadOnlyList<Line> lines,
        IReadOnlyList<BubbleRegion> regions,
        BubbleRegion region,
        double midX,
        int lineH)
    {
        return lines
            .Where(l => l.CenterX < midX)
            .Where(l => !LineInsideAnyRegion(l, regions, pad: 3))
            .Where(l => l.MaxY <= region.Y + Math.Max(4, lineH / 3))
            .Where(l => region.Y - l.MaxY <= lineH * 2.4)
            .Where(l => l.MinX >= region.X - lineH * 1.2 && l.MinX <= region.X + lineH * 4.0)
            .Where(IsPlausibleSenderName)
            .OrderByDescending(l => l.MaxY)
            .Select(l => l.Text.Trim())
            .FirstOrDefault();
    }

    private static bool PromoteOverlappingSenderName(List<Line> inside, BubbleRegion region, int lineH, ref string? sender)
    {
        if (!string.IsNullOrWhiteSpace(sender)) return false;
        if (inside.Count < 2) return false;

        var first = inside[0];
        if (first.MinY > region.Y + Math.Max(4, lineH / 3)) return false;
        if (!IsPlausibleSenderName(first)) return false;

        sender = first.Text.Trim();
        inside.RemoveAt(0);
        return true;
    }

    private static bool IsPlausibleSenderName(Line line)
    {
        var text = line.Text.Trim();
        if (text.Length == 0 || text.Length > 26) return false;
        if (TimeLine.IsMatch(text) || SystemKeyword.IsMatch(text)) return false;
        if (text.Contains("http", StringComparison.OrdinalIgnoreCase) || text.Contains("www.", StringComparison.OrdinalIgnoreCase)) return false;
        if (text.Contains("微信电脑版", StringComparison.Ordinal) || text.Contains("企业微信", StringComparison.Ordinal)) return false;
        if (text.Contains("发送", StringComparison.Ordinal)) return false;
        return true;
    }

    private static bool IsCenteredSystemLine(Line line, int chatX0, int chatX1)
    {
        var chatW = Math.Max(1, chatX1 - chatX0);
        var center = (chatX0 + chatX1) / 2.0;
        var width = line.MaxX - line.MinX;
        var centerDistance = Math.Abs(line.CenterX - center);
        return centerDistance <= chatW * 0.16 && width <= chatW * CenterWidthFrac;
    }

    private static int Median(List<int> xs)
    {
        if (xs.Count == 0) return 0;
        xs.Sort();
        return xs[xs.Count / 2];
    }
}

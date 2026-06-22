using System.Drawing;
using System.Text.RegularExpressions;

namespace Hyyd.CaptureSidecar;

/// <summary>
/// 把一张聊天截图的 OCR 词块 + 像素，结构化成「标题 + 带说话人的消息列表」。
/// 全在 sidecar 本地做，后端不再二次结构化。
///
/// 流程（见文档 §四/§六/§七）：
///   1. 分区：联系人列表行右端的重复值 + 常量 → 聊天区左界；企微"群成员"锚点 → 右界。
///   2. 标题：聊天区跳过窗口系统按钮后的顶行。
///   3. 气泡：在聊天区按气泡底色做连通域，得到一条条消息气泡的包围盒。
///   4. 归属：OCR 行中心落进哪个气泡就属于哪条消息。
///   5. 说话人：只看气泡相对聊天区中线的左右位置——靠右 self、靠左 other；
///      没进任何气泡且相对居中的行 → system（time/notice/other）。颜色只用于「找气泡」，不判说话人。
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
    private static (int x0, int x1, int contactRight) DetectChatXRange(IReadOnlyList<OcrBlock> blocks, int w, string channel)
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
        return (chatX0, chatX1, contactRight);
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

        // 找「多行联系人右端对齐」形成的那条竖线当联系人右界。联系人列表每行右边有右对齐的时间戳，
        // 十几行的右端会对齐成一条线 → 行数最多的那一簇就是它。把右端排序，相邻相差 ≤tolerance(默认2px)
        // 归为一簇；取**支持行数最多**（≥minSupport）的那簇——不是最靠右的那簇，否则聊天区里偶尔
        // 两三条短消息右端凑在一起会被误选、把 chatX0 推进聊天区。同分行数时取更靠右的。
        var tolerance = Math.Max(1, (int)EnvD("HYYD_CONTACT_RIGHT_TOLERANCE", 2));
        var rights = ToLines(contactBlocks).Select(l => l.MaxX).OrderBy(x => x).ToList();
        var clusters = new List<List<int>>();
        foreach (var x in rights)
        {
            if (clusters.Count > 0 && x - clusters[^1][^1] <= tolerance)
            {
                clusters[^1].Add(x);
            }
            else
            {
                clusters.Add(new List<int> { x });
            }
        }

        var selected = clusters
            .Where(c => c.Count >= minSupport)
            .OrderByDescending(c => c.Count)
            .ThenByDescending(c => c[^1])
            .FirstOrDefault();
        if (selected == null)
        {
            var debug = string.Join(", ", clusters.OrderByDescending(c => c.Count).Select(c => $"~{c[^1]}×{c.Count}"));
            throw new InvalidOperationException(
                $"聊天区分区失败：联系人右端没有 ≥{minSupport} 行对齐的边界（tol={tolerance}，候选簇 {debug}）。");
        }

        return selected[^1];
    }

    // 企微右侧成员区左界：用"发送企业名片"按钮里的"企业名片"几个字定位（真实企微没有"群成员"字样）。
    // 关键词可用 HYYD_WXWORK_MEMBER_KEYWORD 覆盖。取所有命中行里最靠左的 X 当成员区左界 = 聊天区右界。
    private static int? DetectGroupMemberLeft(IReadOnlyList<OcrBlock> blocks, int chatX0)
    {
        var keyword = Environment.GetEnvironmentVariable("HYYD_WXWORK_MEMBER_KEYWORD");
        if (string.IsNullOrWhiteSpace(keyword)) keyword = "企业名片";

        int? memberLeft = null;
        foreach (var b in blocks)
        {
            if (b.Bbox.X <= chatX0) continue;
            if (b.Text.Replace(" ", string.Empty).Contains(keyword, StringComparison.Ordinal))
            {
                memberLeft = memberLeft == null ? b.Bbox.X : Math.Min(memberLeft.Value, b.Bbox.X);
            }
        }
        return memberLeft;
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

    private sealed record BubbleRegion(int X, int Y, int W, int H, int Area, int MaxRow, string Speaker)
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

    // self / other 各按自己的颜色分别找气泡，互不合并——气泡是什么颜色就是谁说的（不看位置）。
    private static List<BubbleRegion> DetectBubbleRegions(Bitmap bmp, int chatX0, int chatX1, int y0, int y1, string channel)
    {
        var height = bmp.Height;
        var width = bmp.Width;
        y0 = Math.Clamp(y0, 0, height - 1);
        y1 = Math.Clamp(y1, y0 + 1, height);
        chatX0 = Math.Clamp(chatX0, 0, width - 1);
        chatX1 = Math.Clamp(chatX1, chatX0 + 1, width);

        var regions = new List<BubbleRegion>();
        regions.AddRange(DetectRegionsForColor(bmp, chatX0, chatX1, y0, y1, p => IsSelfFill(p, channel), "self"));
        regions.AddRange(DetectRegionsForColor(bmp, chatX0, chatX1, y0, y1, p => IsOtherFill(p, channel), "other"));
        return regions.OrderBy(r => r.Y).ThenBy(r => r.X).ToList();
    }

    private static List<BubbleRegion> DetectRegionsForColor(
        Bitmap bmp, int chatX0, int chatX1, int y0, int y1, Func<Color, bool> match, string speaker)
    {
        var width = bmp.Width;
        var height = bmp.Height;

        var mask = new bool[width, height];
        for (int y = y0; y < y1; y++)
        {
            for (int x = chatX0; x < chatX1; x++)
            {
                if (match(bmp.GetPixel(x, y)))
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
                    regions.Add(new BubbleRegion(minX, minY, w, h, area, maxRow, speaker));
                }
            }
        }

        return regions;
    }

    // 气泡底色 = 已知的"对方/自己"基准色 ± 容差（兼容不同显示器色差）。基准色（Windows 上取色）：
    //   企微 other #E4E7EB(228,231,235) / self #C9E7FF(201,231,255)
    //   微信 other #EEEEF0(238,238,240) / self #9DF29F(157,242,159)
    // "自己"气泡底色：企微浅蓝 #C9E7FF / 微信浅绿 #9DF29F。饱和、离背景远，容差可大。
    private static bool IsSelfFill(Color p, string channel)
    {
        if (p.A < 200) return false;
        var selfTol = (int)EnvD("HYYD_BUBBLE_SELF_TOL", 16);
        return string.Equals(channel, "wxwork", StringComparison.OrdinalIgnoreCase)
            ? NearColor(p, 201, 231, 255, selfTol)
            : NearColor(p, 157, 242, 159, selfTol);
    }

    // "对方"气泡底色：企微浅灰 #E4E7EB / 微信浅灰 #EEEEF0。和聊天背景接近，容差小且压上限。
    private static bool IsOtherFill(Color p, string channel)
    {
        if (p.A < 200) return false;
        var grayTol = (int)EnvD("HYYD_BUBBLE_GRAY_TOL", 9);
        var grayCap = (int)EnvD("HYYD_BUBBLE_GRAY_CAP", 243);
        return string.Equals(channel, "wxwork", StringComparison.OrdinalIgnoreCase)
            ? NearColor(p, 228, 231, 235, grayTol) && p.R <= grayCap && p.G <= grayCap && p.B <= grayCap + 1
            : NearColor(p, 238, 238, 240, grayTol) && p.R <= grayCap && p.G <= grayCap && p.B <= grayCap;
    }

    private static bool NearColor(Color p, int r, int g, int b, int tol)
        => Near(p.R, r, tol) && Near(p.G, g, tol) && Near(p.B, b, tol);

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
        var (chatX0, chatX1, contactRight) = DetectChatXRange(blocks, w, channel);
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

        // 3) 标题 = 聊天区顶栏里"最靠左"的那一行（会话名）。
        // 先用很小的 topChromeY 排除最顶端窗口按钮行(□/×，y≈1)；阈值别太大，
        // 之前 0.04(=32px) 把 y=31 的真标题也切掉了，导致标题取成下面的系统提示、扫描带跟着下沉。
        var topChromeY = Math.Max(12, (int)(bmp.Height * 0.018));
        var contentLines = lines.Where(l => l.MinY >= topChromeY).ToList();
        if (contentLines.Count == 0)
        {
            return new StructureResult(null, Array.Empty<StructuredMessage>(), chatX0, chatX1, null, null, dropped);
        }

        var lineH = Median(contentLines.Select(l => l.Height).Where(x => x > 0).ToList());
        if (lineH <= 0) lineH = 20;

        // 顶栏里：左边是会话名、右边常有成员数/工具按钮等小图标（"… 个"、右上角窗口/表情按钮等），
        // 它们和会话名几乎同一排、偶尔还高几像素。所以不能取"最靠上的一行"（会被右侧图标抢走），
        // 而是取顶排里 MinX 最小（最靠左、贴着聊天区左界）的那一行当会话名。
        var firstRowY = contentLines.Min(l => l.MinY);
        var titleLine = contentLines
            .Where(l => l.MinY <= firstRowY + lineH * 0.6)
            .OrderBy(l => l.MinX)
            .First();
        var title = titleLine.Text;

        // 4) 像素 → 气泡。OCR 只提供文字行；消息边界以截图里的气泡/卡片底色为准。
        // 输入区分区先不参与正式结果，但发送按钮同一行及其下方的工具栏 OCR 需要丢弃。
        var bodyLines = contentLines.Where(l => !ReferenceEquals(l, titleLine)).ToList();

        // 企微输入区上沿锚点：输入区顶排右上角有"快速会议"四个字（微信没有这种锚点，保持原方案）。
        // 命中时它的 Y 就是输入区上沿——这一排(工具栏图标)及其下方全是输入区噪声，整体丢掉，
        // 避免那排图标被 OCR 成文字、误判成 system。关键词可用 HYYD_WXWORK_INPUT_ANCHOR 覆盖。
        int? inputTopY = null;
        if (string.Equals(channel, "wxwork", StringComparison.Ordinal))
        {
            var anchorKw = Environment.GetEnvironmentVariable("HYYD_WXWORK_INPUT_ANCHOR");
            if (string.IsNullOrWhiteSpace(anchorKw)) anchorKw = "快速会议";
            var anchor = contentLines
                .Where(l => l.Text.Replace(" ", string.Empty).Contains(anchorKw, StringComparison.Ordinal))
                .Where(l => l.CenterY >= bmp.Height * 0.5)
                .OrderBy(l => l.MinY)
                .FirstOrDefault();
            if (anchor != null) inputTopY = anchor.MinY;
        }

        var sendLine = contentLines
            .Where(l => l.Text.Replace(" ", string.Empty).Contains("发送", StringComparison.Ordinal))
            .Where(l => l.CenterY >= bmp.Height * 0.55)
            .OrderByDescending(l => l.MinY)
            .FirstOrDefault();
        var visibleBodyLines = bodyLines
            .Where(l => !IsInputNoiseLine(l, sendLine))
            .Where(l => inputTopY == null || l.MinY < inputTopY.Value - 4) // 企微：输入区上沿（快速会议）以下全丢
            .ToList();
        if (visibleBodyLines.Count == 0)
        {
            return new StructureResult(title, Array.Empty<StructuredMessage>(), chatX0, chatX1, null, null, dropped);
        }

        var midX = (chatX0 + chatX1) / 2.0;
        var scanY0 = Math.Min(bmp.Height - 1, Math.Max(titleLine.MaxY + 4, topChromeY + 20));
        var scanY1base = sendLine == null
            ? Math.Min(bmp.Height, (int)(bmp.Height * 0.92))
            : Math.Clamp(sendLine.MinY - 4, scanY0 + 1, bmp.Height);
        // 企微：用"快速会议"锚点把扫描下沿再收紧到输入区上沿之上（比"发送"更高，连工具栏图标行一起排除）
        var scanY1 = inputTopY != null
            ? Math.Clamp(Math.Min(scanY1base, inputTopY.Value - 4), scanY0 + 1, bmp.Height)
            : scanY1base;
        // 没扫到气泡是正常情况（空会话/全是图片/纯灰文字主题/滚动位置），不再抛错丢帧——
        // 照常返回标题+分区，气泡消息为空，下面的居中 system 行仍会被收集。
        var regions = DetectBubbleRegions(bmp, chatX0, chatX1, scanY0, scanY1, channel);

        // 5) 气泡内文字 → 消息；气泡外且相对居中的文字 → system。
        var result = new List<StructuredMessage>();
        var usedLines = new HashSet<Line>();
        var debugBubbles = new List<DebugBubble>(); // 所有检测到的气泡（含没有文字的空气泡），供调试
        foreach (var region in regions)
        {
            var speaker = region.Speaker; // 颜色即发送者：蓝/绿=self，灰=other（不看位置）
            var inside = visibleBodyLines
                .Where(l => LineInsideRegion(l, region, pad: 6))
                .OrderBy(l => l.MinY)
                .ThenBy(l => l.MinX)
                .ToList();
            debugBubbles.Add(new DebugBubble(region.X, region.Y, region.W, region.H, region.Area, speaker, inside.Count > 0));
            if (inside.Count == 0) continue;
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
        return new StructureResult(title, result, chatX0, chatX1, null, null, dropped,
            scanY0, scanY1, contactRight, debugBubbles);
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

    private static bool Near(int value, int target, int tol) => Math.Abs(value - target) <= tol;

    private static int Median(List<int> xs)
    {
        if (xs.Count == 0) return 0;
        xs.Sort();
        return xs[xs.Count / 2];
    }
}

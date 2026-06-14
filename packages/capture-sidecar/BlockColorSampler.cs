using System.Drawing;

namespace Hyyd.CaptureSidecar;

/// <summary>
/// 给每个 OCR 词块采样其所在"气泡的填充色"（跳过文字笔画的深色像素，取其余像素平均）。
/// 像素只有本机有，所以颜色在 sidecar 采、随 OCR 块上传；说话人判定（HSV 饱和度）放到后端做。
/// 这是把"结构化解释层"从 sidecar 挪到后端后，sidecar 仍需承担的唯一新增职责。
/// 采样逻辑与早期 MessageStructurer.SampleFill 一致（按消息区域采 → 改为按词块区域采）。
/// </summary>
internal static class BlockColorSampler
{
    /// 返回带 ColorSample 的新词块列表（采不到色的块 ColorSample 为 null，后端会按位置兜底）。
    public static IReadOnlyList<OcrBlock> Enrich(Bitmap bmp, IReadOnlyList<OcrBlock> blocks)
    {
        var result = new List<OcrBlock>(blocks.Count);
        foreach (var b in blocks)
        {
            var c = SampleFill(bmp, b.Bbox.X, b.Bbox.Y, b.Bbox.X + b.Bbox.Width, b.Bbox.Y + b.Bbox.Height);
            result.Add(c is { } v ? b with { ColorSample = new ColorSample(v.R, v.G, v.B) } : b);
        }
        return result;
    }

    // 网格采样气泡填充色：跳过近黑（文字）像素，对其余取平均 → 气泡底色。
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
}

using System.Drawing;
using System.Drawing.Drawing2D;
using System.Drawing.Imaging;
using System.Runtime.InteropServices;

namespace Hyyd.CaptureSidecar;

/// <summary>
/// 关键帧去重用的轻量指纹：把窗口截图缩到固定宽度的灰度缩略图。
/// 只跟“上一张被保留的关键帧”比较，计算变化像素比例。
/// </summary>
internal sealed record FrameSignature(int Width, int Height, byte[] Gray)
{
    public static FrameSignature Build(Bitmap src, int targetWidth)
    {
        int tw = Math.Max(1, targetWidth);
        int srcW = Math.Max(1, src.Width);
        int th = Math.Max(1, (int)Math.Round((double)src.Height / srcW * tw));

        using var small = new Bitmap(tw, th, PixelFormat.Format32bppArgb);
        using (var g = Graphics.FromImage(small))
        {
            g.InterpolationMode = InterpolationMode.Bilinear;
            g.PixelOffsetMode = PixelOffsetMode.HighQuality;
            g.DrawImage(src, new Rectangle(0, 0, tw, th));
        }

        var gray = new byte[tw * th];
        var data = small.LockBits(
            new Rectangle(0, 0, tw, th),
            ImageLockMode.ReadOnly,
            PixelFormat.Format32bppArgb
        );
        try
        {
            int stride = data.Stride;
            var buffer = new byte[stride * th];
            Marshal.Copy(data.Scan0, buffer, 0, buffer.Length);
            for (int y = 0; y < th; y++)
            {
                int rowBase = y * stride;
                int outBase = y * tw;
                for (int x = 0; x < tw; x++)
                {
                    int idx = rowBase + x * 4; // BGRA
                    byte b = buffer[idx + 0];
                    byte gg = buffer[idx + 1];
                    byte r = buffer[idx + 2];
                    // 近似亮度：0.299R + 0.587G + 0.114B
                    gray[outBase + x] = (byte)((r * 77 + gg * 150 + b * 29) >> 8);
                }
            }
        }
        finally
        {
            small.UnlockBits(data);
        }

        return new FrameSignature(tw, th, gray);
    }

    /// <summary>变化像素比例（0~1）。尺寸不同视为完全变化（返回 1）。</summary>
    public double DiffAgainst(FrameSignature other, int perPixelThreshold)
    {
        if (Width != other.Width || Height != other.Height)
        {
            return 1.0;
        }

        int n = Gray.Length;
        if (n == 0)
        {
            return 1.0;
        }

        int changed = 0;
        for (int i = 0; i < n; i++)
        {
            int d = Gray[i] - other.Gray[i];
            if (d < 0)
            {
                d = -d;
            }
            if (d > perPixelThreshold)
            {
                changed++;
            }
        }

        return (double)changed / n;
    }
}

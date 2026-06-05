using System.Drawing;
using System.Drawing.Imaging;
using System.Security.Cryptography;

namespace Hyyd.CaptureSidecar;

internal sealed class WindowCapture
{
    private readonly string _frameRoot;

    public WindowCapture()
    {
        _frameRoot = Path.Combine(
            Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
            "HyydCaptureSidecar",
            "frames"
        );
    }

    /// <summary>截取目标窗口到内存位图（调用方负责 Dispose），不落盘。用于去重前的像素比较。</summary>
    public Bitmap CaptureBitmap(TargetWindow window)
    {
        var bitmap = new Bitmap(window.Rect.Width, window.Rect.Height, PixelFormat.Format32bppArgb);
        try
        {
            using var graphics = Graphics.FromImage(bitmap);
            graphics.CopyFromScreen(
                window.Rect.Left,
                window.Rect.Top,
                0,
                0,
                new Size(window.Rect.Width, window.Rect.Height),
                CopyPixelOperation.SourceCopy
            );
        }
        catch
        {
            bitmap.Dispose();
            throw;
        }

        return bitmap;
    }

    /// <summary>仅在去重判定为“保留关键帧”时调用：编码 PNG 落盘。</summary>
    public CapturedImage Persist(Bitmap bitmap, TargetWindow window, DateTimeOffset capturedAt)
    {
        Directory.CreateDirectory(_frameRoot);

        var bytes = BitmapToPngBytes(bitmap);
        var hash = Convert.ToHexString(SHA256.HashData(bytes)).ToLowerInvariant();
        var dateDir = Path.Combine(_frameRoot, capturedAt.ToLocalTime().ToString("yyyy-MM-dd"));
        Directory.CreateDirectory(dateDir);
        var path = Path.Combine(dateDir, $"{capturedAt:yyyyMMdd-HHmmss-fff}-{window.Channel}-{hash[..12]}.png");
        File.WriteAllBytes(path, bytes);

        return new CapturedImage(path, hash, bytes);
    }

    private static byte[] BitmapToPngBytes(Bitmap bitmap)
    {
        using var stream = new MemoryStream();
        bitmap.Save(stream, ImageFormat.Png);
        return stream.ToArray();
    }
}

internal sealed record CapturedImage(string Path, string Sha256, byte[] PngBytes);


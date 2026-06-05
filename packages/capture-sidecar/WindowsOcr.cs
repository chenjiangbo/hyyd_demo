using Windows.Graphics.Imaging;
using Windows.Media.Ocr;
using Windows.Storage;

namespace Hyyd.CaptureSidecar;

internal sealed class WindowsOcr
{
    private readonly OcrEngine _engine;

    public WindowsOcr()
    {
        _engine = OcrEngine.TryCreateFromUserProfileLanguages()
            ?? throw new InvalidOperationException("Windows OCR engine is not available for current user languages.");
    }

    public async Task<OcrPayload> RecognizeAsync(string imagePath)
    {
        var file = await StorageFile.GetFileFromPathAsync(imagePath);
        using var stream = await file.OpenAsync(FileAccessMode.Read);
        var decoder = await BitmapDecoder.CreateAsync(stream);
        var bitmap = await decoder.GetSoftwareBitmapAsync(BitmapPixelFormat.Bgra8, BitmapAlphaMode.Premultiplied);
        var result = await _engine.RecognizeAsync(bitmap);

        var blocks = new List<OcrBlock>();
        foreach (var line in result.Lines)
        {
            foreach (var word in line.Words)
            {
                var rect = word.BoundingRect;
                blocks.Add(new OcrBlock(
                    word.Text,
                    new CaptureRect(
                        (int)Math.Round(rect.X),
                        (int)Math.Round(rect.Y),
                        (int)Math.Round(rect.Width),
                        (int)Math.Round(rect.Height)
                    ),
                    null
                ));
            }
        }

        return new OcrPayload(
            "windows_ocr",
            "success",
            result.Text ?? string.Empty,
            blocks
        );
    }
}

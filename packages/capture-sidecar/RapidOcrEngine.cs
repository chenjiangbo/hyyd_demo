using RapidOcrNet;

namespace Hyyd.CaptureSidecar;

internal sealed class RapidOcrEngine : IOcrEngine, IDisposable
{
    private readonly RapidOcr _ocr = new();
    private bool _initialized;

    public string Name => "rapidocr_ppocrv5_ch";

    public Task<OcrPayload> RecognizeAsync(string imagePath)
    {
        EnsureInitialized();

        var result = _ocr.Detect(imagePath, RapidOcrOptions.Default with
        {
            ReturnWordBox = false,
            DoAngle = true,
            TextScore = 0.5f
        });

        var blocks = result.TextBlocks
            .Select(block =>
            {
                var xs = block.BoxPoints.Select(p => Convert.ToDouble(p.X)).ToList();
                var ys = block.BoxPoints.Select(p => Convert.ToDouble(p.Y)).ToList();
                var minX = (int)Math.Floor(xs.Min());
                var minY = (int)Math.Floor(ys.Min());
                var maxX = (int)Math.Ceiling(xs.Max());
                var maxY = (int)Math.Ceiling(ys.Max());
                var score = block.CharScores == null || !block.CharScores.Any()
                    ? (double?)null
                    : block.CharScores.Average();

                return new OcrBlock(
                    block.Text,
                    new CaptureRect(minX, minY, Math.Max(1, maxX - minX), Math.Max(1, maxY - minY)),
                    score);
            })
            .ToList();

        return Task.FromResult(new OcrPayload(
            Name,
            "success",
            result.StrRes ?? string.Join(Environment.NewLine, blocks.Select(b => b.Text)),
            blocks));
    }

    public void Dispose() => _ocr.Dispose();

    private void EnsureInitialized()
    {
        if (_initialized) return;

        var modelDir = Path.Combine(AppContext.BaseDirectory, "models", "v5");
        var detPath = RequireModel(modelDir, "ch_PP-OCRv5_det_mobile.onnx");
        var clsPath = RequireModel(modelDir, "ch_PP-LCNet_x0_25_textline_ori_cls_mobile.onnx");
        var recPath = RequireModel(modelDir, "ch_PP-OCRv5_rec_mobile.onnx");
        var keysPath = RequireModel(modelDir, "ppocrv5_dict.txt");

        _ocr.InitModels(detPath, clsPath, recPath, keysPath);
        _initialized = true;
    }

    private static string RequireModel(string modelDir, string fileName)
    {
        var path = Path.Combine(modelDir, fileName);
        if (!File.Exists(path))
        {
            throw new FileNotFoundException($"RapidOCR 模型文件缺失：{path}");
        }
        return path;
    }
}

namespace Hyyd.CaptureSidecar;

internal interface IOcrEngine
{
    string Name { get; }

    Task<OcrPayload> RecognizeAsync(string imagePath);
}

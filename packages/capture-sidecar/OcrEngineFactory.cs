namespace Hyyd.CaptureSidecar;

internal static class OcrEngineFactory
{
    public static IOcrEngine CreateDefault() => new RapidOcrEngine();
}

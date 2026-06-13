using System.Text.Json;

namespace Hyyd.CaptureSidecar;

internal sealed class JsonLineWriter
{
    private readonly JsonSerializerOptions _jsonOptions;
    private readonly SemaphoreSlim _writeLock = new(1, 1);

    // 静音 stdout 的 JSON 协议输出（独立自测模式用：只看 stderr 上的简洁事件，不刷屏）。
    public bool Muted { get; set; }

    public JsonLineWriter(JsonSerializerOptions jsonOptions)
    {
        _jsonOptions = jsonOptions;
    }

    public Task WriteStatusAsync(bool collecting)
    {
        return WriteAsync(new
        {
            type = "status",
            collecting
        });
    }

    public Task WriteErrorAsync(string message)
    {
        return WriteAsync(new
        {
            type = "error",
            message
        });
    }

    public async Task WriteAsync(object message)
    {
        if (Muted)
        {
            return;
        }
        var json = JsonSerializer.Serialize(message, _jsonOptions);
        await _writeLock.WaitAsync();
        try
        {
            await Console.Out.WriteLineAsync(json);
            await Console.Out.FlushAsync();
        }
        finally
        {
            _writeLock.Release();
        }
    }
}


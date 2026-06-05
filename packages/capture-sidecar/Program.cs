using System.Text.Json;
using System.Text.Json.Serialization;

namespace Hyyd.CaptureSidecar;

internal static class Program
{
    private static readonly JsonSerializerOptions JsonOptions = new()
    {
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
        DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull
    };

    public static async Task Main()
    {
        NativeMethods.TryEnableDpiAwareness();

        var writer = new JsonLineWriter(JsonOptions);
        using var collector = new CaptureCollector(writer);

        await writer.WriteAsync(new
        {
            type = "ready",
            protocolVersion = 1
        });

        string? line;
        while ((line = await Console.In.ReadLineAsync()) is not null)
        {
            if (string.IsNullOrWhiteSpace(line))
            {
                continue;
            }

            await HandleCommandAsync(line, collector, writer);
        }
    }

    private static async Task HandleCommandAsync(string line, CaptureCollector collector, JsonLineWriter writer)
    {
        Command? command;
        try
        {
            command = JsonSerializer.Deserialize<Command>(line, JsonOptions);
        }
        catch (Exception ex)
        {
            await writer.WriteErrorAsync($"Invalid JSON command: {ex.Message}");
            return;
        }

        if (command?.Type is null)
        {
            await writer.WriteErrorAsync("Command type is required.");
            return;
        }

        switch (command.Type)
        {
            case "ping":
                await writer.WriteStatusAsync(collector.IsCollecting);
                break;

            case "start":
                collector.Start();
                await writer.WriteStatusAsync(true);
                break;

            case "stop":
                collector.Stop();
                await writer.WriteStatusAsync(false);
                break;

            default:
                await writer.WriteErrorAsync($"Unsupported command type: {command.Type}");
                break;
        }
    }

    private sealed class Command
    {
        public string? Type { get; set; }
        public string? RequestId { get; set; }
    }
}


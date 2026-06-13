namespace Hyyd.CaptureSidecar;

internal sealed record TargetWindow(
    string Channel,
    string ProcessName,
    string WindowTitle,
    WinRect Rect,
    string ShowState
);

internal sealed record CaptureRect(int X, int Y, int Width, int Height);

internal sealed record OcrBlock(string Text, CaptureRect Bbox, double? Confidence);

internal sealed record OcrPayload(string Engine, string Status, string Text, IReadOnlyList<OcrBlock> Blocks);

internal sealed record WindowPayload(int Left, int Top, int Width, int Height, string ShowState);

internal sealed record FramePayload(
    string Type,
    string Channel,
    string ProcessName,
    string? WindowTitle,
    string CapturedAt,
    WindowPayload Window,
    string ScreenshotPath,
    string? ImageHash,
    OcrPayload Ocr,
    string KeepReason,
    double DiffScore,
    // 客户会话识别结果：会话类型（group/single）与从标题/全文抽到的订单号（高客 fwyy… / 普客 COD/CCOD/OD…），抽不到为 null。
    string? ConversationKind,
    string? OrderNo,
    // 结构化消息：用气泡颜色+位置判出的"带说话人"的消息列表（路线1：供后端 LLM 抽关键信息）
    IReadOnlyList<StructuredMessage> Messages
);

/// 一条结构化消息。Speaker: 'self'（本员工）| 'other'（客户/群成员）| 'system'（时间/撤回等系统提示）。
/// Name: 群聊里对方的昵称（能识别时），单聊/自己为 null。
internal sealed record StructuredMessage(string Speaker, string? Name, string Text);


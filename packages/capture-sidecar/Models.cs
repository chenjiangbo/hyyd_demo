namespace Hyyd.CaptureSidecar;

internal sealed record TargetWindow(
    IntPtr Hwnd,
    string Channel,
    string ProcessName,
    string WindowTitle,
    WinRect Rect,
    string ShowState
);

internal sealed record CaptureRect(int X, int Y, int Width, int Height);

internal sealed record OcrBlock(string Text, CaptureRect Bbox, double? Confidence, ColorSample? ColorSample = null);

/// 词块所在气泡的填充色采样（跳过文字笔画后的底色）。供后端按 HSV 饱和度判 self/other。
/// 像素只有 sidecar 有，所以在本机采好、随 OCR 块上传；结构化算法本身移到后端。
internal sealed record ColorSample(int R, int G, int B);

internal sealed record OcrPayload(string Engine, string Status, string Text, IReadOnlyList<OcrBlock> Blocks);

internal sealed record WindowPayload(int Left, int Top, int Width, int Height, string ShowState);

internal sealed record FramePayload(
    string Type,
    string Channel,
    string ProcessName,
    // 会话标题：聊天区顶行 OCR（=会话名/群名）。不再用 Win32 GetWindowText（对微信不可靠）。
    string? Title,
    string CapturedAt,
    WindowPayload Window,
    string ScreenshotPath,
    string? ImageHash,
    OcrPayload Ocr,
    string KeepReason,
    double DiffScore,
    // 客户会话识别结果：会话类型（group/single）与从标题抽到的订单号（高客 fwyy… / 普客 COD/CCOD/OD…），抽不到为 null。
    string? ConversationKind,
    string? OrderNo,
    // 结构化消息：sidecar 分区+拼行+判说话人后的成品（后端不再二次结构化）。
    IReadOnlyList<StructuredMessage> Messages,
    // 非客户会话过滤掉的帧：仍输出该帧（供调试页看 OCR），但 tray-app 端只进调试缓冲、不入库不上报。
    bool Filtered = false,
    // ── 调试元数据（仅采集调试页用；tray-app 入库/上报时忽略）──
    int? ChatX0 = null,            // 聊天区左界（分区竖线）
    int? ChatX1 = null,            // 聊天区右界
    int? InputCutY = null,         // 输入框上沿 Y（此下被切），无则 null
    InputCutDebug? InputCut = null,// 输入区定位候选与最终依据（调试页展示）
    int? DroppedBlockCount = null, // 聊天区外被丢弃的词块数（联系人区/图标栏/成员区）
    // 结构化失败时的异常文本（含堆栈）。非 null 表示分区/气泡检测抛了异常——该帧仍输出（保留原图+OCR
    // 供调试），messages 为空。调试页应把它显示在右侧、可复制，便于排查。
    string? StructureError = null,
    // ── 气泡扫描调试（调试页"气泡"视图 + .debug.json）──
    int? ScanY0 = null,
    int? ScanY1 = null,
    int? ContactRight = null,
    IReadOnlyList<DebugBubble>? Bubbles = null
);

/// 词块/气泡的外接框（调试用）。
internal sealed record MsgBox(int X, int Y, int W, int H);

/// 检测到的一个气泡连通域（调试用，含没归到任何文字的空气泡，便于排查误检/漏检）。
/// Speaker: 按相对中线左右判的 self/other。HasText: 是否有 OCR 行落进来成为消息正文。
internal sealed record DebugBubble(int X, int Y, int W, int H, int Area, string Speaker, bool HasText);

/// 一条结构化消息。Speaker: 'self'（本员工）| 'other'（客户/群成员）| 'system'（时间/通知）。
/// Name: 群聊里对方的昵称（能识别时），单聊/自己为 null。
/// Kind: system 消息的细分——"time"(时间锚点，保留)/"notice"(群通知，可忽略)/"other"；非 system 为 null。
/// Box/L/R/DecidedBy: 调试元数据——气泡外接框、左右相对留白比、判据来源(position/color/center)。
internal sealed record StructuredMessage(
    string Speaker,
    string? Name,
    string Text,
    string? Kind = null,
    MsgBox? Box = null,
    double? L = null,
    double? R = null,
    string? DecidedBy = null);

/// 输入框定位调试信息。FinalCutY 与 FramePayload.InputCutY 一致。
internal sealed record InputCutDebug(
    int? SendButtonY,
    int? SeparatorLineY,
    int? GapCutY,
    int? LastBubbleBottomY,
    int? FinalCutY,
    string? FinalReason,
    int RemovedLineCount,
    IReadOnlyList<string> RemovedLinePreview);

/// 结构化产出：标题（聊天区顶行）+ 消息列表 + 分区调试信息。
internal sealed record StructureResult(
    string? Title,
    IReadOnlyList<StructuredMessage> Messages,
    int ChatX0 = 0,
    int ChatX1 = 0,
    int? InputCutY = null,
    InputCutDebug? InputCut = null,
    int DroppedBlockCount = 0,
    int ScanY0 = 0,                          // 气泡扫描带上沿（标题下方）
    int ScanY1 = 0,                          // 气泡扫描带下沿（发送按钮上方/保守下界）
    int? ContactRight = null,                // 联系人列表右界（chatX0 = 此 + padding）
    IReadOnlyList<DebugBubble>? Bubbles = null); // 检测到的所有气泡（含空气泡）

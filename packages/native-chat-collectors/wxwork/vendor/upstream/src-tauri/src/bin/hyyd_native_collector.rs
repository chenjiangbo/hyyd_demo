use std::collections::{BTreeMap, HashMap, HashSet};
use std::fs;
use std::io::{self, BufRead, Read, Write};
use std::path::{Path, PathBuf};
use std::sync::mpsc::{self, Receiver};
use std::thread;
use std::time::{Duration, Instant};

use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use uuid::Uuid;

use wecom_archive_desktop::collect_local_export_selected_with_cursors_and_pending_at_root;

const PAGE_SIZE: usize = 500;
const FULL_SCAN_INTERVAL: Duration = Duration::from_secs(120);
const PENDING_MEDIA_RESCAN_INTERVAL: Duration = Duration::from_secs(5 * 60);
const MEDIA_UPDATE_WINDOW_MS: i64 = 5 * 60 * 1000;

fn emit(value: &Value) -> Result<(), String> {
    let mut stdout = io::stdout().lock();
    serde_json::to_writer(&mut stdout, value).map_err(|error| error.to_string())?;
    stdout.write_all(b"\n").map_err(|error| error.to_string())?;
    stdout.flush().map_err(|error| error.to_string())
}

fn command_reader() -> Receiver<Value> {
    let (sender, receiver) = mpsc::channel();
    thread::spawn(move || {
        for line in io::stdin().lock().lines() {
            let line = match line {
                Ok(line) => line,
                Err(error) => {
                    let _ = sender.send(json!({"type":"__protocol_error","message":error.to_string()}));
                    break;
                }
            };
            match serde_json::from_str::<Value>(&line) {
                Ok(command) => {
                    if sender.send(command).is_err() { break; }
                }
                Err(error) => {
                    let _ = sender.send(json!({"type":"__protocol_error","message":error.to_string()}));
                    break;
                }
            }
        }
    });
    receiver
}

struct CollectorArgs {
    media_dir: PathBuf,
    source_root: String,
    account_directory_id: String,
}

fn parse_args() -> Result<CollectorArgs, String> {
    let mut args = std::env::args().skip(1);
    let mut media_dir = None;
    let mut source_root = None;
    let mut account_directory_id = None;
    while let Some(argument) = args.next() {
        if argument == "--media-dir" {
            let value = args.next().ok_or("--media-dir requires a path")?;
            media_dir = Some(PathBuf::from(value));
        } else if argument == "--source-root" {
            let value = args.next().ok_or("--source-root requires a path")?;
            source_root = Some(value);
        } else if argument == "--account-directory-id" {
            let value = args.next().ok_or("--account-directory-id requires a value")?;
            account_directory_id = Some(value);
        } else {
            return Err(format!("unknown argument: {argument}"));
        }
    }
    let media_dir = media_dir.ok_or("--media-dir is required")?;
    let source_root = source_root.ok_or("--source-root is required; automatic account discovery is disabled")?;
    let account_directory_id = account_directory_id.ok_or("--account-directory-id is required")?;
    fs::create_dir_all(&media_dir).map_err(|error| format!("media directory cannot be created: {error}"))?;
    let data_dir = std::env::var_os("WECOM_ARCHIVE_SERVER_DATA")
        .map(PathBuf::from)
        .ok_or("WECOM_ARCHIVE_SERVER_DATA is required")?;
    fs::create_dir_all(&data_dir).map_err(|error| format!("WeCom collector data directory cannot be created: {error}"))?;
    Ok(CollectorArgs { media_dir, source_root, account_directory_id })
}

fn cursor_source_row_id(cursor: &str) -> Result<i64, String> {
    let value: Value = serde_json::from_str(cursor).map_err(|_| "企微采集游标不是有效 JSON".to_owned())?;
    let row_id = value.get("sourceRowId").and_then(Value::as_i64)
        .ok_or_else(|| "企微采集游标缺少 sourceRowId".to_owned())?;
    if row_id < 0 { return Err("企微源行号游标不能为负数".into()); }
    Ok(row_id)
}

fn source_row_id(message: &Value) -> Result<i64, String> {
    let id = message.get("parentSourceMessageId").and_then(Value::as_str)
        .or_else(|| message.get("sourceMessageId").and_then(Value::as_str))
        .ok_or("企微规范消息缺少来源 ID")?;
    let root = id.split(':').next().ok_or("企微来源消息 ID 无效")?;
    let row_id = root.parse::<i64>().map_err(|_| format!("企微源消息 ID 不是数据库递增行号：{id}"))?;
    if row_id <= 0 { return Err(format!("企微源消息行号无效：{id}")); }
    Ok(row_id)
}

fn message_pages(rows: &[Value]) -> Result<Vec<Vec<Value>>, String> {
    let mut pages = Vec::new();
    let mut page = Vec::new();
    let mut current_row_id = None;
    for message in rows {
        let row_id = source_row_id(message)?;
        if current_row_id.is_some_and(|current| current != row_id) && page.len() >= PAGE_SIZE {
            pages.push(std::mem::take(&mut page));
        }
        current_row_id = Some(row_id);
        page.push(message.clone());
    }
    if !page.is_empty() { pages.push(page); }
    Ok(pages)
}

fn pending_source_row_id(source_message_id: &str) -> Result<i64, String> {
    let root = source_message_id.split(':').next().ok_or("待补资源消息 ID 无效")?;
    let row_id = root.parse::<i64>().map_err(|_| format!("待补资源消息 ID 不是企微源行号：{source_message_id}"))?;
    if row_id <= 0 { return Err(format!("待补资源消息行号无效：{source_message_id}")); }
    Ok(row_id)
}

fn parse_subscriptions(command: &Value) -> Result<(HashSet<String>, HashMap<String, i64>, HashMap<String, HashSet<i64>>), String> {
    let conversations = command.get("conversations").and_then(Value::as_array)
        .ok_or("subscribe.conversations must be an array")?;
    let mut selected = HashSet::new();
    let mut watermarks = HashMap::new();
    let mut pending_media = HashMap::new();
    for session in conversations {
        let conversation_id = session.get("sourceConversationId").and_then(Value::as_str)
            .filter(|id| !id.trim().is_empty())
            .ok_or("subscription missing sourceConversationId")?.to_owned();
        let cursor = session.get("cursor").and_then(Value::as_str)
            .ok_or_else(|| format!("subscription for {conversation_id} missing cursor"))?;
        let row_id = cursor_source_row_id(cursor)?;
        if !selected.insert(conversation_id.clone()) {
            return Err(format!("duplicate subscription for {conversation_id}"));
        }
        watermarks.insert(conversation_id.clone(), row_id);
        let pending_ids = session.get("pendingMediaSourceMessageIds").and_then(Value::as_array)
            .ok_or_else(|| format!("subscription for {conversation_id} missing pending media list"))?;
        let mut row_ids = HashSet::new();
        for pending_id in pending_ids {
            let message_id = pending_id.as_str().ok_or_else(|| format!("pending media message ID is not a string for {conversation_id}"))?;
            row_ids.insert(pending_source_row_id(message_id)?);
        }
        if !row_ids.is_empty() { pending_media.insert(conversation_id.to_owned(), row_ids); }
    }
    Ok((selected, watermarks, pending_media))
}

fn parse_ack_pending_media(command: &Value) -> Result<HashSet<i64>, String> {
    let ids = command.get("pendingMediaSourceMessageIds").and_then(Value::as_array)
        .ok_or("ack missing pending media message list")?;
    ids.iter().map(|value| {
        let message_id = value.as_str().ok_or("pending media message ID is not a string")?;
        pending_source_row_id(message_id)
    }).collect()
}

fn read_export(include_media: bool, selected: &[String], source_root: &str, time_cutoffs: &HashMap<String, i64>, rowid_cutoffs: &HashMap<String, i64>, pending_media_rowids: &HashMap<String, Vec<i64>>) -> Result<Value, String> {
    let export = collect_local_export_selected_with_cursors_and_pending_at_root(include_media, false, selected, source_root.to_owned(), time_cutoffs, rowid_cutoffs, pending_media_rowids)?;
    export.validate().map_err(|error| format!("source export validation failed: {error}"))?;
    serde_json::to_value(export).map_err(|error| format!("source export serialization failed: {error}"))
}

fn referenced_media_hashes(export: &Value, selected: &HashSet<String>) -> HashSet<String> {
    let mut hashes = HashSet::new();
    for message in export.get("batches").and_then(Value::as_array).into_iter().flatten()
        .flat_map(|batch| batch.get("messages").and_then(Value::as_array).into_iter().flatten())
    {
        if !message.get("conversation_id").and_then(Value::as_str).is_some_and(|id| selected.contains(id)) { continue; }
        for reference in message.get("media").and_then(Value::as_array).into_iter().flatten() {
            if let Some(hash) = reference.get("content_hash").and_then(Value::as_str) { hashes.insert(hash.to_lowercase()); }
        }
        for item in message.get("raw_payload").and_then(|payload| payload.get("items")).and_then(Value::as_array).into_iter().flatten() {
            let empty_metadata = Value::Null;
            let metadata = item.get("media").unwrap_or(&empty_metadata);
            for key in ["content_hash", "sha256", "fullmd5", "thumbfullmd5"] {
                if let Some(hash) = metadata.get(key).and_then(Value::as_str) { hashes.insert(hash.to_lowercase()); }
            }
        }
    }
    hashes
}

fn media_files(export: &Value, root: &Path, scan_id: &str, needed: &HashSet<String>) -> Result<HashMap<String, (String, u64)>, String> {
    let mut paths = HashMap::new();
    let run_dir = root.join(scan_id);
    fs::create_dir_all(&run_dir).map_err(|error| format!("media run directory creation failed: {error}"))?;
    for blob in export.get("media_blobs").and_then(Value::as_array).into_iter().flatten() {
        let content_hash = blob.get("content_hash").and_then(Value::as_str).ok_or("media blob missing content_hash")?;
        if !needed.contains(&content_hash.to_lowercase()) { continue; }
        let content_hex = blob.get("content_hex").and_then(Value::as_str).ok_or("media blob missing content_hex")?;
        let bytes = hex::decode(content_hex).map_err(|error| format!("media blob hex decode failed: {error}"))?;
        let file_path = run_dir.join(content_hash);
        fs::write(&file_path, &bytes).map_err(|error| format!("media blob write failed: {error}"))?;
        paths.insert(content_hash.to_lowercase(), (file_path.to_string_lossy().into_owned(), bytes.len() as u64));
    }
    Ok(paths)
}

fn message_kind(raw: &str) -> &'static str {
    match raw {
        "text" => "text",
        "image" => "image",
        "audio" => "audio",
        "video" => "video",
        "file" => "file",
        "link" => "link",
        "system" => "system",
        "unsupported" => "unknown",
        _ => "unknown",
    }
}

fn message_direction(message: &Value, account_directory_id: &str) -> &'static str {
    match message.get("direction").and_then(Value::as_str).unwrap_or("unknown") {
        "incoming" => return "incoming",
        "outgoing" => return "outgoing",
        "system" => return "system",
        _ => {}
    }
    let Some(sender_id) = message.get("sender_id").and_then(Value::as_str) else {
        return "unknown";
    };
    if sender_id.is_empty() || sender_id == "0" {
        return "unknown";
    }
    if sender_id == account_directory_id { "outgoing" } else { "incoming" }
}

fn staged_image_is_full(path: &str) -> bool {
    let Ok(file) = fs::File::open(path) else { return false; };
    let mut bytes = Vec::new();
    if file.take(1024 * 1024).read_to_end(&mut bytes).is_err() { return false; }
    let area = if bytes.starts_with(b"\x89PNG\r\n\x1a\n") && bytes.len() >= 24 {
        (u32::from_be_bytes(bytes[16..20].try_into().unwrap_or_default()) as u64)
            .saturating_mul(u32::from_be_bytes(bytes[20..24].try_into().unwrap_or_default()) as u64)
    } else if bytes.starts_with(&[0xff, 0xd8]) {
        let mut offset = 2usize;
        let mut area = 0;
        while offset + 4 <= bytes.len() {
            if bytes[offset] != 0xff { offset += 1; continue; }
            let marker = bytes[offset + 1];
            offset += 2;
            if marker == 0xd9 || marker == 0xda { break; }
            if matches!(marker, 0xd8 | 0x01 | 0xd0..=0xd7) { continue; }
            if offset + 2 > bytes.len() { break; }
            let length = u16::from_be_bytes([bytes[offset], bytes[offset + 1]]) as usize;
            if length < 2 || offset + length > bytes.len() { break; }
            if matches!(marker, 0xc0..=0xc3 | 0xc5..=0xc7 | 0xc9..=0xcb | 0xcd..=0xcf) && length >= 7 {
                let height = u16::from_be_bytes([bytes[offset + 3], bytes[offset + 4]]) as u64;
                let width = u16::from_be_bytes([bytes[offset + 5], bytes[offset + 6]]) as u64;
                area = width.saturating_mul(height);
                break;
            }
            offset += length;
        }
        area
    } else { 0 };
    area >= 100_000
}

fn message_attachments(message: &Value, source_id: &str, media: &HashMap<String, (String, u64)>) -> Vec<Value> {
    message.get("media").and_then(Value::as_array).into_iter().flatten().enumerate().map(|(index, reference)| {
        let content_hash = reference.get("content_hash").and_then(Value::as_str).unwrap_or("");
        let available = media.get(&content_hash.to_lowercase());
        let kind = message.get("message_type").and_then(Value::as_str).map(message_kind).unwrap_or("other");
        let mut source_metadata = reference.clone();
        if !source_metadata.is_object() { source_metadata = json!({}); }
        let mut attachment = json!({
            "sourceAttachmentId": format!("{source_id}:media:{index}"),
            "kind": if kind == "text" || kind == "unknown" { "other" } else { kind },
            "fileName": reference.get("original_name"),
            "mimeType": reference.get("mime_type"),
            "byteSize": reference.get("size_bytes"),
            "state": "not_downloaded",
            "sourceMetadata": source_metadata,
        });
        if let Some((path, size)) = available {
            attachment["localPath"] = json!(path);
            attachment["byteSize"] = json!(size);
            attachment["state"] = json!("available");
            if kind == "image" {
                let full = staged_image_is_full(path);
                attachment["sourceMetadata"]["rendition"] = json!(if full { "non_thumbnail" } else { "thumbnail" });
                attachment["sourceMetadata"]["nonThumbnailState"] = json!(if full { "available" } else { "pending" });
            }
        } else if kind == "image" {
            attachment["sourceMetadata"]["nonThumbnailState"] = json!("pending");
        }
        attachment
    }).collect()
}

fn merged_item_attachments(
    item: &Value,
    parent_source_id: &str,
    item_index: usize,
    media_files: &HashMap<String, (String, u64)>,
) -> Vec<Value> {
    let item_kind = item.get("type").and_then(Value::as_str).unwrap_or("unknown");
    if item_kind != "image" && item_kind != "file" { return Vec::new(); }
    let empty_metadata = Value::Null;
    let metadata = item.get("media").unwrap_or(&empty_metadata);
    let source_hash = metadata.get("content_hash").or_else(|| metadata.get("sha256"))
        .and_then(Value::as_str).unwrap_or("");
    let local_file = media_files.get(&source_hash.to_lowercase());
    let mut attachment = json!({
        "sourceAttachmentId":format!("{parent_source_id}:item:{item_index}:media"),
        "kind":item_kind,
        "fileName":metadata.get("original_name").or_else(||metadata.get("filename")).or_else(||metadata.get("name")),
        "mimeType":metadata.get("mime_type"),
        "byteSize":metadata.get("size_bytes"),
        "state":"not_downloaded",
        "sourceMetadata":metadata
    });
    if let Some((path, size)) = local_file {
        attachment["localPath"] = json!(path);
        attachment["byteSize"] = json!(size);
        attachment["state"] = json!("available");
        if item_kind == "image" {
            let full = staged_image_is_full(path);
            attachment["sourceMetadata"]["rendition"] = json!(if full { "non_thumbnail" } else { "thumbnail" });
            attachment["sourceMetadata"]["nonThumbnailState"] = json!(if full { "available" } else { "pending" });
        }
    } else if item_kind == "image" {
        attachment["sourceMetadata"]["nonThumbnailState"] = json!("pending");
    }
    vec![attachment]
}

fn normalized_messages(
    export: &Value,
    selected: &HashSet<String>,
    media: &HashMap<String, (String, u64)>,
    account_directory_id: &str,
) -> Result<(Vec<Value>, BTreeMap<String, Vec<Value>>), String> {
    let batches = export.get("batches").and_then(Value::as_array).ok_or("export missing batches")?;
    let account_id = batches.first().and_then(|batch| batch.get("source_instance_id")).and_then(Value::as_str).ok_or("export missing source instance ID")?;
    let participant_names = export.get("participants").and_then(Value::as_array).into_iter().flatten().filter_map(|participant| {
        Some((
            participant.get("participant_id")?.as_str()?.to_owned(),
            participant.get("display_name")?.as_str()?.to_owned(),
        ))
    }).collect::<HashMap<_, _>>();
    let mut conversations = BTreeMap::new();
    for conversation in export.get("conversations").and_then(Value::as_array).into_iter().flatten() {
        let id = conversation.get("conversation_id").and_then(Value::as_str).ok_or("conversation missing ID")?.to_owned();
        let kind = match conversation.get("conversation_type").and_then(Value::as_str).unwrap_or("") {
            "group" | "room" => "group",
            "single" | "direct" => "single",
            _ => "unknown",
        };
        let member_names = conversation.get("participant_ids").and_then(Value::as_array).into_iter().flatten().filter_map(|id| {
            participant_names.get(id.as_str()?).cloned()
        }).collect::<Vec<_>>();
        conversations.insert(id.clone(), json!({
            "channel":"wxwork", "accountId":account_id, "sourceConversationId":id,
            "title":conversation.get("display_name"), "kind":kind,
            "sourceMetadata":{"participantIds":conversation.get("participant_ids"),"participantNames":member_names,"accountDirectoryId":account_directory_id}
        }));
    }
    let mut messages_by_conversation = BTreeMap::<String, Vec<Value>>::new();
    for batch in batches {
        for message in batch.get("messages").and_then(Value::as_array).into_iter().flatten() {
            let conversation_id = message.get("conversation_id").and_then(Value::as_str).ok_or("message missing conversation ID")?;
            if !selected.contains(conversation_id) { continue; }
            let source_id = message.get("source_message_id").and_then(Value::as_str).ok_or("message missing source ID")?;
            let raw_type = message.get("raw_type").and_then(Value::as_str).unwrap_or("unknown");
            let raw_payload = message.get("raw_payload").cloned().unwrap_or(Value::Null);
            let is_merged = raw_payload.get("kind").and_then(Value::as_str) == Some("merged_forward");
            let kind = if is_merged { "merged" } else { message.get("message_type").and_then(Value::as_str).map(message_kind).unwrap_or("unknown") };
            let attachments = if is_merged { Vec::new() } else { message_attachments(message, source_id, media) };
            let normalized = json!({
                "channel":"wxwork", "accountId":account_id, "sourceConversationId":conversation_id,
                "sourceMessageId":source_id, "parentSourceMessageId":Value::Null, "sourceItemIndex":Value::Null,
                "direction":message_direction(message, account_directory_id),
                "senderId":message.get("sender_id"), "senderName":Value::Null,
                "kind":kind, "sourceTypeCode":raw_type,
                "text":message.get("body_text"), "occurredAt":message.get("sent_at"),
                "observedAt":export.get("generated_at"), "sourceMetadata":raw_payload,
                "attachments":attachments
            });
            let mut projected = vec![normalized];
            if is_merged {
                if let Some(items) = raw_payload.get("items").and_then(Value::as_array) {
                    for (item_index, item) in items.iter().enumerate() {
                        let item_type = item.get("type").and_then(Value::as_str).unwrap_or("unknown");
                        let child_type = match item_type { "text"=>"text", "image"=>"image", "file"=>"file", _=>"unknown" };
                        projected.push(json!({
                            "channel":"wxwork", "accountId":account_id, "sourceConversationId":conversation_id,
                            "sourceMessageId":format!("{source_id}:item:{item_index}"), "parentSourceMessageId":source_id,
                            "sourceItemIndex":item.get("record_index").and_then(Value::as_u64).unwrap_or(item_index as u64),
                            "direction":message_direction(item, account_directory_id), "senderId":item.get("sender_id"), "senderName":item.get("sender_name"),
                            "kind":child_type, "sourceTypeCode":item.get("type_code").map(Value::to_string).unwrap_or_else(||"unknown".into()),
                            "text":item.get("text"), "occurredAt":item.get("source_time").or_else(||message.get("sent_at")),
                            "observedAt":export.get("generated_at"), "sourceMetadata":item,
                            "attachments":merged_item_attachments(item, source_id, item_index, media)
                        }));
                    }
                }
            }
            messages_by_conversation.entry(conversation_id.to_owned()).or_default().extend(projected);
        }
    }
    Ok((conversations.into_values().collect(), messages_by_conversation))
}

fn main() {
    if std::env::args().any(|argument| argument == "--key-probe") {
        std::process::exit(wecom_archive_desktop::run_key_probe());
    }
    if let Err(error) = run() {
        let _ = emit(&json!({"event":"fatal","stage":"startup","message":error}));
        std::process::exit(1);
    }
}

fn run() -> Result<(), String> {
    let args = parse_args()?;
    let commands = command_reader();
    let mut selected = HashSet::<String>::new();
    let mut watermarks = HashMap::<String, i64>::new();
    let mut pending_media = HashMap::<String, HashSet<i64>>::new();
    let mut fingerprints = HashMap::<String, String>::new();
    let mut last_scan = Instant::now() - FULL_SCAN_INTERVAL;
    let mut last_pending_media_scan = Instant::now() - PENDING_MEDIA_RESCAN_INTERVAL;
    let mut ready_sent = false;
    let mut should_stop = false;

    while !should_stop {
        loop {
            let command = match commands.try_recv() {
                Ok(command) => command,
                Err(mpsc::TryRecvError::Empty) => break,
                Err(mpsc::TryRecvError::Disconnected) => return Err("collector command stream closed unexpectedly".into()),
            };
            match command.get("type").and_then(Value::as_str) {
                Some("__protocol_error") => return Err(format!("collector command protocol failed: {}", command.get("message").and_then(Value::as_str).unwrap_or("unknown input error"))),
                Some("subscribe") => {
                    let (next_selected, next_watermarks, next_pending_media) = parse_subscriptions(&command)?;
                    if next_selected != selected || next_watermarks != watermarks || next_pending_media != pending_media {
                        selected = next_selected;
                        watermarks = next_watermarks;
                        pending_media = next_pending_media;
                        last_scan = Instant::now() - FULL_SCAN_INTERVAL;
                    }
                }
                Some("stop") => should_stop = true,
                other => return Err(format!("unsupported collector command: {other:?}")),
            }
        }
        if should_stop { break; }
        if (!ready_sent && last_scan.elapsed() >= Duration::from_secs(30))
            || (ready_sent && last_scan.elapsed() >= FULL_SCAN_INTERVAL)
        {
            let mut selected_ids = selected.iter().cloned().collect::<Vec<_>>();
            selected_ids.sort();
            let conversation_rowid_cutoffs = selected.iter()
                .map(|conversation_id| {
                    watermarks.get(conversation_id)
                        .copied()
                        .map(|row_id| (conversation_id.clone(), row_id))
                        .ok_or_else(|| format!("subscription source rowid missing for {conversation_id}"))
                })
                .collect::<Result<HashMap<_, _>, _>>()?;
            let scan_time = chrono::Utc::now().timestamp_millis().saturating_sub(MEDIA_UPDATE_WINDOW_MS);
            let conversation_time_cutoffs = selected.iter().map(|conversation_id| (conversation_id.clone(), scan_time)).collect::<HashMap<_, _>>();
            let pending_media_rows = if last_pending_media_scan.elapsed() >= PENDING_MEDIA_RESCAN_INTERVAL {
                pending_media.iter().map(|(conversation, row_ids)| (conversation.clone(), row_ids.iter().copied().collect::<Vec<_>>())).collect::<HashMap<_, _>>()
            } else {
                HashMap::new()
            };
            let export = match read_export(
                !selected.is_empty(), &selected_ids, &args.source_root,
                &conversation_time_cutoffs, &conversation_rowid_cutoffs, &pending_media_rows,
            ) {
                Ok(export) => export,
                Err(error) => {
                    emit(&json!({"event":"error","stage":"source_scan","message":error}))?;
                    last_scan = Instant::now();
                    thread::sleep(Duration::from_secs(1));
                    continue;
                }
            };
            if !pending_media_rows.is_empty() { last_pending_media_scan = Instant::now(); }
            let scan_id = Uuid::new_v4().to_string();
            let needed_media = referenced_media_hashes(&export, &selected);
            let media = media_files(&export, &args.media_dir, &scan_id, &needed_media)?;
            let (sessions, messages) = normalized_messages(
                &export,
                &selected,
                &media,
                &args.account_directory_id,
            )?;
            let account_id = export.get("batches").and_then(Value::as_array).and_then(|batches|batches.first())
                .and_then(|batch|batch.get("source_instance_id")).and_then(Value::as_str)
                .ok_or("source export missing account ID")?.to_owned();
            if !ready_sent {
                emit(&json!({"event":"ready","channel":"wxwork","accountId":account_id.clone(),"sessions":sessions}))?;
                ready_sent = true;
            } else {
                emit(&json!({"event":"sessions","sessions":sessions}))?;
            }
            for (conversation_id, rows) in &messages {
                if !selected.contains(conversation_id) { continue; }
                for page in message_pages(rows)? {
                    let mut changed = Vec::new();
                    for message in &page {
                        let id = message.get("sourceMessageId").and_then(Value::as_str).ok_or("normalized message missing source ID")?;
                        let mut fingerprint_value = message.clone();
                        fingerprint_value.as_object_mut().map(|object| { object.remove("observedAt"); });
                        if let Some(attachments) = fingerprint_value.get_mut("attachments").and_then(Value::as_array_mut) {
                            for attachment in attachments {
                                if let Some(object) = attachment.as_object_mut() { object.remove("localPath"); }
                            }
                        }
                        let serialized = serde_json::to_vec(&fingerprint_value).map_err(|error| error.to_string())?;
                        let fingerprint = hex::encode(Sha256::digest(&serialized));
                        if fingerprints.get(id) != Some(&fingerprint) { changed.push((id.to_owned(), fingerprint, message.clone())); }
                    }
                    if changed.is_empty() { continue; }
                    let messages = changed.iter().map(|(_, _, message)| message.clone()).collect::<Vec<_>>();
                    let row_ids = page.iter().map(source_row_id).collect::<Result<Vec<_>, _>>()?;
                    let cursor_row_id = row_ids.into_iter().max().ok_or("企微消息页为空")?;
                    let cursor = json!({"sourceRowId":cursor_row_id}).to_string();
                    emit(&json!({"event":"message_batch","channel":"wxwork","accountId":account_id.clone(),"sourceConversationId":conversation_id,"cursorAfter":cursor,"messages":messages}))?;
                    loop {
                        match commands.recv_timeout(Duration::from_secs(1)) {
                            Ok(command) if command.get("type").and_then(Value::as_str) == Some("stop") => { should_stop = true; break; }
                            Ok(command) if command.get("type").and_then(Value::as_str) == Some("ack")
                                && command.get("sourceConversationId").and_then(Value::as_str) == Some(conversation_id.as_str())
                                && command.get("cursor").and_then(Value::as_str) == Some(cursor.as_str()) => {
                                    for (id, fingerprint, _) in changed { fingerprints.insert(id, fingerprint); }
                                    watermarks.entry(conversation_id.clone()).and_modify(|current| *current = (*current).max(cursor_row_id)).or_insert(cursor_row_id);
                                    let pending_ids = parse_ack_pending_media(&command)?;
                                    if pending_ids.is_empty() { pending_media.remove(conversation_id); }
                                    else { pending_media.insert(conversation_id.clone(), pending_ids); }
                                    break;
                                }
                            Ok(command) if command.get("type").and_then(Value::as_str) == Some("reject")
                                && command.get("sourceConversationId").and_then(Value::as_str) == Some(conversation_id.as_str())
                                && command.get("cursor").and_then(Value::as_str) == Some(cursor.as_str()) => {
                                    selected.remove(conversation_id);
                                    break;
                                }
                            Ok(command) if command.get("type").and_then(Value::as_str) == Some("subscribe") => {
                                let (next_selected, next_watermarks, next_pending_media) = parse_subscriptions(&command)?;
                                if next_selected != selected || next_watermarks != watermarks || next_pending_media != pending_media {
                                    selected = next_selected;
                                    watermarks = next_watermarks;
                                    pending_media = next_pending_media;
                                }
                            }
                            Ok(command) if command.get("type").and_then(Value::as_str) == Some("__protocol_error") => {
                                return Err(format!("collector command protocol failed: {}", command.get("message").and_then(Value::as_str).unwrap_or("unknown input error")));
                            }
                            Ok(command) => return Err(format!("unsupported collector command while awaiting batch acknowledgement: {command}")),
                            Err(mpsc::RecvTimeoutError::Timeout) => {}
                            Err(mpsc::RecvTimeoutError::Disconnected) => { should_stop = true; break; }
                        }
                    }
                    if should_stop { break; }
                }
                if should_stop { break; }
            }
            for (_hash, (path, _)) in &media {
                let _ = fs::remove_file(path);
            }
                let _ = fs::remove_dir(args.media_dir.join(&scan_id));
            last_scan = Instant::now();
        }
        thread::sleep(Duration::from_millis(250));
    }
    Ok(())
}

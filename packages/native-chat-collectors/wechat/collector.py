"""JSON-lines host for the vendored wechatauto-replica database reader.

The desktop process owns server upload and durable acknowledgements. This process
only discovers sessions and reads the selected message rows from WeChat's local DB.
"""
from __future__ import annotations

import hashlib
import json
import logging
import os
import queue
import re
import shutil
import sys
import threading
import time
import traceback
import tempfile
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

VENDOR_ROOT = Path(__file__).resolve().parent / "vendor"
sys.path.insert(0, str(VENDOR_ROOT))

from wechatauto.db import WeChatDB  # noqa: E402
from wechatauto.records import normalize_message_type_code  # noqa: E402
from wechatauto.media import (  # noqa: E402
    AmbiguousLocalFileError,
    LocalFileSizeMismatchError,
    MediaDownloader,
)

logging.basicConfig(stream=sys.stderr, level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
LOG = logging.getLogger("hyyd.wechat.collector")
COMMANDS: queue.Queue[dict[str, Any]] = queue.Queue()
STOP = threading.Event()
MEDIA_RECHECK_INTERVAL_SECONDS = 300


def emit(value: dict[str, Any]) -> None:
    payload = json.dumps(value, ensure_ascii=False, separators=(",", ":")).encode("utf-8") + b"\n"
    sys.stdout.buffer.write(payload)
    sys.stdout.buffer.flush()


def read_commands() -> None:
    try:
        for line in sys.stdin:
            try:
                value = json.loads(line)
            except json.JSONDecodeError as exc:
                emit({"event": "fatal", "stage": "protocol", "message": f"Invalid command JSON: {exc}"})
                STOP.set()
                return
            if not isinstance(value, dict):
                emit({"event": "fatal", "stage": "protocol", "message": "Collector command must be a JSON object"})
                STOP.set()
                return
            COMMANDS.put(value)
            if value.get("type") == "stop":
                STOP.set()
                return
        emit({"event": "fatal", "stage": "protocol", "message": "Collector command stream closed unexpectedly"})
        STOP.set()
    except Exception as exc:
        emit({"event": "fatal", "stage": "protocol", "message": f"Command reader failed: {exc}"})
        LOG.exception("Command reader failed")
        STOP.set()


def utc_time(value: Any) -> str:
    if isinstance(value, (int, float)):
        return datetime.fromtimestamp(value, timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")
    if isinstance(value, str):
        try:
            parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
            if parsed.tzinfo is None:
                parsed = parsed.replace(tzinfo=timezone.utc)
            return parsed.astimezone(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")
        except ValueError:
            pass
    raise ValueError(f"Unsupported source timestamp: {value!r}")


def normalized_kind(raw_code: Any, type_name: Any) -> str:
    try:
        code = int(normalize_message_type_code(raw_code, known_types=(1, 3, 34, 43, 47, 48, 49, 50, 10000, 11000)))
    except (TypeError, ValueError):
        code = -1
    return {
        1: "text", 3: "image", 34: "voice", 43: "video", 47: "emoji",
        48: "location", 49: "file", 50: "system", 10000: "system", 11000: "emoji"
    }.get(code, "unknown")


def source_id(message: dict[str, Any]) -> str:
    shard = message.get("shard")
    if not isinstance(shard, str) or not shard.strip():
        raise RuntimeError("WeChat message row is missing its shard identity")
    return f"{shard}:{message['local_id']}"


def local_attachment(path: str | None, source_attachment_id: str, kind: str, file_name: str | None = None, byte_size: int | None = None) -> dict[str, Any]:
    if path is None:
        attachment = {"sourceAttachmentId": source_attachment_id, "kind": kind, "fileName": file_name, "state": "not_downloaded"}
        if byte_size is not None:
            attachment["byteSize"] = byte_size
        return attachment
    local_path = Path(path)
    if not local_path.is_file():
        raise RuntimeError(f"Media reader returned a missing file for {source_attachment_id}")
    return {
        "sourceAttachmentId": source_attachment_id,
        "kind": kind,
        "fileName": file_name or local_path.name,
        "byteSize": local_path.stat().st_size,
        "state": "available",
        "localPath": str(local_path),
    }


def encode_message(db: WeChatDB, media_reader: MediaDownloader, account_id: str, username: str, msg: dict[str, Any], observed_at: str) -> list[dict[str, Any]]:
    sid = source_id(msg)
    message_media_dir = Path(media_reader.save_dir) / hashlib.sha256(sid.encode("utf-8")).hexdigest()
    raw_code = msg.get("local_type")
    kind = normalized_kind(raw_code, msg.get("type"))
    content = msg.get("content")
    if isinstance(content, bytes):
        content = db._friendly_content(content, db._msg_type_name(raw_code))
    elif not isinstance(content, str):
        content = str(content) if content is not None else None
    forward = None
    if kind == "file":
        forward = db.get_merged_forward(username, int(msg["local_id"]), shard=msg.get("shard"))
        if forward is None and content and ("<recorditem" in content.lower() or "<recordinfo" in content.lower()):
            raise RuntimeError(f"Merged forward parse failed: {sid}")
        if forward is not None:
            kind = "merged"
    sender_id = str(msg["sender_id"]) if msg.get("sender_id") is not None else None
    sender_username = str(msg.get("sender_username") or "")
    if kind == "system":
        direction = "system"
    elif sender_username:
        direction = "outgoing" if sender_username == account_id else "incoming"
    else:
        direction = "unknown"
    base = {
        "channel": "wechat", "accountId": account_id,
        "sourceConversationId": username, "sourceMessageId": sid,
        "direction": direction, "senderId": sender_id,
        "senderName": msg.get("sender_username") or None,
        "kind": kind, "sourceTypeCode": str(raw_code) if raw_code is not None else str(msg.get("type") or "unknown"),
        "text": content, "occurredAt": utc_time(msg.get("create_time")),
        "observedAt": observed_at, "sourceMetadata": {
            "sortSeq": msg.get("sort_seq"), "serverId": msg.get("server_id"),
            "shard": msg.get("shard"), "sourceTypeName": msg.get("type")
        }, "attachments": []
    }
    output = [base]
    if kind == "merged":
        if forward is None:
            raise RuntimeError(f"Merged forward parse failed: {sid}")
        for item in forward["items"]:
            item_index = merged_item_index(item)
            source_item_index = _int_or_none(item.get("sequence"))
            if item.get("sequence") is not None and (source_item_index is None or source_item_index < 0):
                raise RuntimeError(f"Merged-forward item {item_index} has an invalid sequence")
            if source_item_index is None:
                source_item_index = item_index
            child_kind = item.get("type") or "unknown"
            if child_kind not in {"text", "image", "file", "video", "location", "unknown"}:
                child_kind = "unknown"
            item_type = child_kind
            item_media = item.get("media") or {}
            attachment = []
            resolution_state = None
            resolution_detail = None
            item_text = item.get("text")
            raw_fields = item.get("raw_fields") or {}
            if item_type in {"image", "file", "video"}:
                message_media_dir.mkdir(parents=True, exist_ok=True)
                try:
                    if item_type == "image":
                        local_path = media_reader.download_merged_forward_image(username, item, save_dir=str(message_media_dir))
                    elif item_type == "video":
                        local_path = media_reader.download_merged_forward_video(username, item, save_dir=str(message_media_dir))
                    else:
                        local_path = find_merged_forward_file(db, media_reader, username, item, str(message_media_dir))
                except AmbiguousLocalFileError:
                    local_path = None
                    resolution_state = "ambiguous"
                except LocalFileSizeMismatchError:
                    local_path = None
                    resolution_state = "not_downloaded"
                    resolution_detail = "size_mismatch"
                attachment.append(local_attachment(
                    local_path,
                    f"{sid}:item:{item_index}",
                    item_type,
                    item.get("original_name"),
                ))
                attachment[0]["byteSize"] = attachment[0].get("byteSize") if attachment[0].get("byteSize") is not None else _int_or_none(item_media.get("datasize") or item_media.get("thumbsize"))
                if resolution_state:
                    attachment[0]["state"] = resolution_state
                if item_type == "image":
                    thumb_size = _int_or_none(item_media.get("thumbsize"))
                    full_size = _int_or_none(item_media.get("datasize"))
                    actual_size = Path(local_path).stat().st_size if local_path else None
                    matches_thumb = actual_size is not None and thumb_size is not None and actual_size == thumb_size
                    matches_full = actual_size is not None and full_size is not None and actual_size == full_size
                    if matches_thumb and not matches_full:
                        rendition, full_state = "thumbnail", "pending"
                    elif matches_full and not matches_thumb:
                        rendition, full_state = "non_thumbnail", "available"
                    elif local_path:
                        rendition, full_state = "unverified", "pending"
                    else:
                        rendition, full_state = "missing", "pending"
                    attachment[0]["sourceMetadata"] = {"rendition": rendition, "nonThumbnailState": full_state}
                if item_type == "file" and resolution_state:
                    attachment[0]["sourceMetadata"] = {"resolutionState": resolution_detail or resolution_state}
                if item_type == "video":
                    resource_id = raw_fields.get("fileid") or raw_fields.get("datafileid")
                    valid_resource_id = isinstance(resource_id, str) and re.fullmatch(r"[0-9a-fA-F]{32}", resource_id)
                    attachment[0]["sourceMetadata"] = {
                        "resourceId": resource_id,
                        "resolutionState": None if local_path else "local_record_video_not_matched" if not valid_resource_id else "resource_file_not_found",
                    }
            if item_type == "location":
                location_parts = [raw_fields.get("title"), raw_fields.get("desc"), raw_fields.get("link")]
                item_text = "\n".join(dict.fromkeys(value.strip() for value in location_parts if isinstance(value, str) and value.strip())) or item_text
            output.append({
                **base,
                "sourceMessageId": f"{sid}:item:{item_index}",
                "parentSourceMessageId": sid,
                "sourceItemIndex": source_item_index,
                "direction": "unknown",
                "senderId": item.get("sender_username"),
                "senderName": item.get("sender_name"),
                "kind": item_type,
                "sourceTypeCode": str(item.get("datatype") or "unknown"),
                "text": item_text,
                "occurredAt": utc_time(item.get("source_timestamp")) if item.get("source_timestamp") is not None else base["occurredAt"],
                "sourceMetadata": {"recordIndex": item.get("record_index"), "dataId": item.get("data_id"), "media": item_media, "details": {key: raw_fields[key] for key in ("title", "desc", "link", "appid", "duration", "fileid", "filesize", "filetype") if key in raw_fields}},
                "attachments": attachment
            })
    elif kind in {"image", "file", "video", "voice"}:
        message_media_dir.mkdir(parents=True, exist_ok=True)
        file_name = None
        file_metadata = None
        file_resolution_state = None
        if kind == "image":
            local_path = media_reader.download_image(username, int(msg["local_id"]), save_dir=str(message_media_dir), tier="best", shard=msg.get("shard"))
        elif kind == "file":
            source_row = media_reader._get_typed_message_row(username, int(msg["local_id"]), 49, shard=msg.get("shard"))
            if source_row is None:
                raise RuntimeError(f"File message row could not be re-read: {sid}")
            original_name, local_name = media_reader._file_names(source_row)
            file_name = original_name or local_name
            source_file_name, source_byte_size = media_reader._message_file_metadata(source_row)
            file_name = file_name or source_file_name
            file_metadata = {"originalName": original_name, "localName": local_name}
            try:
                local_path = media_reader.download_file(username, int(msg["local_id"]), save_dir=str(message_media_dir), shard=msg.get("shard"))
            except AmbiguousLocalFileError:
                local_path = None
                file_resolution_state = "ambiguous"
                file_metadata["resolutionState"] = "ambiguous"
            except LocalFileSizeMismatchError:
                local_path = None
                file_resolution_state = "not_downloaded"
                file_metadata["resolutionState"] = "size_mismatch"
            if local_path is None:
                LOG.warning(
                    "File attachment remains pending sourceMessage=%s serverIdPresent=%s packedInfoPresent=%s originalNamePresent=%s localNamePresent=%s",
                    sid,
                    bool(source_row.get("server_id")),
                    bool(source_row.get("packed_info")),
                    bool(original_name),
                    bool(local_name),
                )
        elif kind == "video":
            local_path = media_reader.download_video(username, int(msg["local_id"]), save_dir=str(message_media_dir), shard=msg.get("shard"))
        else:
            local_path = media_reader.download_voice(username, int(msg["local_id"]), save_dir=str(message_media_dir), shard=msg.get("shard"))
        attachment = local_attachment(local_path, f"{sid}:media", kind, file_name, source_byte_size if kind == "file" else None)
        if file_resolution_state:
            attachment["state"] = file_resolution_state
        if kind == "image":
            image_stem = Path(local_path).stem if local_path else ""
            is_thumbnail = image_stem.endswith(("_thumb", "_bubble"))
            is_confirmed_original = bool(local_path and Path(local_path).stem.endswith("_h"))
            is_confirmed_non_thumbnail = bool(image_stem.endswith("_non_thumbnail"))
            attachment["sourceMetadata"] = {
                "rendition": "thumbnail" if is_thumbnail else "non_thumbnail" if (is_confirmed_original or is_confirmed_non_thumbnail) else "unverified" if local_path else "missing",
                "nonThumbnailState": "available" if (is_confirmed_original or is_confirmed_non_thumbnail) else "pending",
            }
        if file_metadata is not None:
            attachment["sourceMetadata"] = file_metadata
        output[0]["attachments"] = [attachment]
    return output


def recheck_media_message(
    db: WeChatDB,
    media_reader: MediaDownloader,
    account_id: str,
    username: str,
    source_message_id: str,
) -> list[dict[str, Any]]:
    shard, separator, local_id_text = source_message_id.rpartition(":")
    if not separator or not shard or not local_id_text.isdigit():
        raise ValueError(f"Pending media message ID is invalid: {source_message_id}")
    row = db.get_message_row(username, int(local_id_text), shard=shard)
    if row is None:
        raise RuntimeError(f"Pending media message row is no longer available: {source_message_id}")
    observed_at = datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")
    rows = encode_message(db, media_reader, account_id, username, row, observed_at)
    return [
        message for message in rows
        if any(attachment.get("localPath") for attachment in message.get("attachments", []))
    ]


def _int_or_none(value: Any) -> int | None:
    try:
        return int(value)
    except (TypeError, ValueError):
        return None


def merged_item_index(item: dict[str, Any]) -> int:
    raw_index = item.get("record_index")
    if raw_index is None:
        raw_index = item.get("sequence")
    index = _int_or_none(raw_index)
    if index is None or index < 0:
        raise RuntimeError("Merged-forward item is missing a valid source index")
    return index


def find_merged_forward_file(db: WeChatDB, media_reader: MediaDownloader, username: str, item: dict[str, Any], save_dir: str) -> str | None:
    fields = item.get("raw_fields") or {}
    original_name = item.get("original_name")
    local_name = fields.get("localfilename") or fields.get("local_filename")
    size = _int_or_none(fields.get("datasize") or fields.get("filesize"))
    account_dir = Path(db.account_dir)
    file_cache = account_dir / "msg" / "file"
    source = media_reader.find_downloaded_file(str(file_cache), original_name, local_name, size)
    if source is None:
        # Merged-record files are stored under msg/attach/<chat>/.../Rec/<record>/F/<index>,
        # not msg/file. Their filename may be absent from the record XML, so resolve only
        # through the exact conversation and child index recorded by WeChat.
        source = media_reader.find_merged_forward_file_cache(username, item)
    if source is None:
        return None
    source_path = Path(source)
    destination = Path(save_dir) / f"merged_{merged_item_index(item)}_{source_path.name}"
    shutil.copyfile(source_path, destination)
    return str(destination)


def main() -> int:
    try:
        db = WeChatDB()
    except Exception as exc:
        emit({"event": "fatal", "message": str(exc)})
        return 1
    account_id = db.wxid
    sessions = db.get_sessions(limit=None)
    media_output = Path(tempfile.gettempdir()) / "hyyd-native-chat" / "wechat" / str(os.getpid())
    media_output.mkdir(parents=True, exist_ok=True)
    media_reader = MediaDownloader(db, save_dir=str(media_output))
    observed_at = datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")
    emit({
        "event": "ready", "channel": "wechat", "accountId": account_id,
        "sessions": [{
            "channel": "wechat", "accountId": account_id,
            "sourceConversationId": str(item["username"]),
            "title": db.get_nickname(str(item["username"])),
            "kind": "group" if str(item["username"]).endswith("@chatroom") else "single",
            "sourceMetadata": {"lastTime": item.get("last_time")}
        } for item in sessions]
    })
    threading.Thread(target=read_commands, name="wechat-command-reader", daemon=True).start()
    selected: dict[str, dict[str, Any]] = {}
    pending_media: dict[str, set[str]] = {}
    media_inflight: dict[str, str] = {}
    last_sessions_refresh = time.monotonic()
    media_last_checked: dict[tuple[str, str], float] = {}

    while not STOP.is_set():
        try:
            while True:
                command = COMMANDS.get_nowait()
                if command.get("type") == "subscribe":
                    raw = command.get("conversations")
                    if not isinstance(raw, list):
                        raise ValueError("subscribe.conversations must be an array")
                    next_selected: dict[str, dict[str, Any]] = {}
                    for item in raw:
                        if not isinstance(item, dict):
                            raise ValueError("conversation subscription must be an object")
                        username = str(item.get("sourceConversationId") or "").strip()
                        if not username:
                            raise ValueError("sourceConversationId is required")
                        cursor = item.get("cursor")
                        if isinstance(cursor, str) and cursor:
                            try:
                                cursor = json.loads(cursor)
                            except json.JSONDecodeError as exc:
                                raise ValueError(f"cursor for {username} is invalid JSON") from exc
                        if not isinstance(cursor, dict):
                            raise ValueError(f"cursor for {username} must be an object")
                        if not isinstance(cursor.get("sortSeq"), int) or cursor["sortSeq"] < 0:
                            raise ValueError(f"cursor for {username} has an invalid sortSeq")
                        if not isinstance(cursor.get("shard"), str) or not isinstance(cursor.get("localId"), int) or cursor["localId"] < 0:
                            raise ValueError(f"cursor for {username} has invalid shard/localId")
                        next_selected[username] = cursor
                        pending_ids = item.get("pendingMediaSourceMessageIds")
                        if not isinstance(pending_ids, list) or any(not isinstance(message_id, str) or not message_id for message_id in pending_ids):
                            raise ValueError(f"pending media message IDs for {username} must be an array of non-empty strings")
                        if pending_ids:
                            pending_media[username] = set(pending_ids)
                        else:
                            pending_media.pop(username, None)
                    selected = next_selected
                    pending_media = {name: ids for name, ids in pending_media.items() if name in selected}
                    for name, message_id in media_inflight.items():
                        if name in selected:
                            pending_media.setdefault(name, set()).add(message_id)
                    emit({"event": "subscribed", "conversationIds": list(selected)})
                elif command.get("type") == "ack":
                    # Acknowledgements advance only after the desktop confirms durable backend ingest.
                    conversation_id = str(command.get("sourceConversationId") or "")
                    try:
                        acknowledged = json.loads(str(command.get("cursor") or ""))
                    except json.JSONDecodeError:
                        acknowledged = None
                    if conversation_id not in selected or not isinstance(acknowledged, dict):
                        raise ValueError("ack references an unknown conversation or invalid cursor")
                    if not isinstance(acknowledged.get("sortSeq"), int) or acknowledged["sortSeq"] < 0:
                        raise ValueError("ack cursor has an invalid sortSeq")
                    if not isinstance(acknowledged.get("shard"), str) or not isinstance(acknowledged.get("localId"), int) or acknowledged["localId"] < 0:
                        raise ValueError("ack cursor has invalid shard/localId")
                    pending_ids = command.get("pendingMediaSourceMessageIds")
                    if not isinstance(pending_ids, list) or any(not isinstance(message_id, str) or not message_id for message_id in pending_ids):
                        raise ValueError("ack pending media message IDs must be an array of non-empty strings")
                    selected[conversation_id] = acknowledged
                    if pending_ids:
                        pending_media[conversation_id] = set(pending_ids)
                    else:
                        pending_media.pop(conversation_id, None)
                elif command.get("type") == "media_ack":
                    conversation_id = str(command.get("sourceConversationId") or "")
                    source_message_id = str(command.get("sourceMessageId") or "")
                    pending_ids = command.get("pendingAttachmentIds")
                    if not conversation_id or not source_message_id or not isinstance(pending_ids, list) or any(not isinstance(item, str) or not item for item in pending_ids):
                        raise ValueError("media_ack is missing a valid conversation, message, or attachment list")
                    if media_inflight.get(conversation_id) != source_message_id:
                        raise ValueError("media_ack does not match the pending media batch")
                    if pending_ids:
                        pending_media.setdefault(conversation_id, set()).add(source_message_id)
                    else:
                        pending_media.get(conversation_id, set()).discard(source_message_id)
                        media_last_checked.pop((conversation_id, source_message_id), None)
                        if conversation_id in pending_media and not pending_media[conversation_id]:
                            del pending_media[conversation_id]
                    del media_inflight[conversation_id]
                elif command.get("type") == "stop":
                    STOP.set()
                else:
                    raise ValueError(f"Unsupported collector command: {command.get('type')}")
        except queue.Empty:
            pass
        except Exception as exc:
            emit({"event": "fatal", "stage": "command", "message": str(exc)})
            STOP.set()

        now = time.monotonic()
        if now - last_sessions_refresh >= 60:
            try:
                latest = db.get_sessions(limit=None)
                emit({"event": "sessions", "sessions": [{
                    "channel": "wechat", "accountId": account_id,
                    "sourceConversationId": str(item["username"]),
                    "title": db.get_nickname(str(item["username"])),
                    "kind": "group" if str(item["username"]).endswith("@chatroom") else "single",
                    "sourceMetadata": {"lastTime": item.get("last_time")}
                } for item in latest]})
                last_sessions_refresh = now
            except Exception as exc:
                emit({"event": "error", "stage": "session_refresh", "message": str(exc)})

        for username, cursor in list(selected.items()):
            if STOP.is_set():
                break
            try:
                rows = db.get_new_messages_after(username, cursor=cursor, limit=500)
                if not rows:
                    continue
                # 500 rows are a page boundary only; every subsequent page is read before this sync completes.
                while rows and not STOP.is_set():
                    last_row = rows[-1]
                    highest = int(last_row["sort_seq"])
                    shard = last_row.get("shard")
                    if not isinstance(shard, str) or not shard:
                        raise RuntimeError("WeChat message row is missing its shard identity")
                    next_cursor = {
                        "sortSeq": highest,
                        "shard": shard,
                        "localId": int(last_row["local_id"]),
                    }
                    cursor_token = json.dumps(next_cursor, separators=(",", ":"))
                    seen_at = datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")
                    messages = []
                    for row in rows:
                        messages.extend(encode_message(db, media_reader, account_id, username, row, seen_at))
                    messages.sort(key=lambda message: (
                        message["occurredAt"],
                        message.get("sourceItemIndex") if message.get("sourceItemIndex") is not None else -1,
                        message["sourceMessageId"],
                    ))
                    emit({
                        "event": "message_batch", "channel": "wechat", "accountId": account_id,
                        "sourceConversationId": username, "sortSeq": highest, "cursorAfter": cursor_token,
                        "messages": messages
                    })
                    while not STOP.is_set():
                        try:
                            command = COMMANDS.get(timeout=1)
                        except queue.Empty:
                            continue
                        if command.get("type") == "ack":
                            if str(command.get("sourceConversationId")) != username:
                                raise ValueError("ack references a different conversation while a batch is in flight")
                            acknowledged = str(command.get("cursor") or "")
                            if acknowledged != cursor_token:
                                raise ValueError("ack cursor does not match the in-flight message batch")
                            selected[username] = next_cursor
                            cursor = next_cursor
                            break
                        elif command.get("type") == "subscribe":
                            # Do not replace the active cursor while a batch is awaiting durable acknowledgement.
                            pending = command.get("conversations")
                            if not isinstance(pending, list):
                                raise ValueError("subscribe.conversations must be an array")
                            replacement: dict[str, dict[str, Any]] = {}
                            for item in pending:
                                if not isinstance(item, dict):
                                    raise ValueError("conversation subscription must be an object")
                                selected_username = str(item.get("sourceConversationId") or "").strip()
                                if not selected_username:
                                    raise ValueError("sourceConversationId is required")
                                token = item.get("cursor")
                                if isinstance(token, str) and token:
                                    token = json.loads(token)
                                if not isinstance(token, dict):
                                    raise ValueError(f"cursor for {selected_username} must be an object")
                                if not isinstance(token.get("sortSeq"), int) or token["sortSeq"] < 0:
                                    raise ValueError(f"cursor for {selected_username} has an invalid sortSeq")
                                if not isinstance(token.get("shard"), str) or not isinstance(token.get("localId"), int) or token["localId"] < 0:
                                    raise ValueError(f"cursor for {selected_username} has invalid shard/localId")
                                replacement[selected_username] = token
                                pending_ids = item.get("pendingMediaSourceMessageIds")
                                if not isinstance(pending_ids, list) or any(not isinstance(message_id, str) or not message_id for message_id in pending_ids):
                                    raise ValueError(f"pending media message IDs for {selected_username} must be an array of non-empty strings")
                                if pending_ids:
                                    pending_media[selected_username] = set(pending_ids)
                                else:
                                    pending_media.pop(selected_username, None)
                            # Keep the in-flight conversation subscribed until its durable ACK arrives.
                            replacement.setdefault(username, cursor)
                            selected = replacement
                            pending_media = {name: ids for name, ids in pending_media.items() if name in selected}
                            for name, message_id in media_inflight.items():
                                if name in selected:
                                    pending_media.setdefault(name, set()).add(message_id)
                        elif command.get("type") == "reject" and str(command.get("sourceConversationId")) == username:
                            # A rule mismatch is an explicit server decision. Drop the
                            # held batch without advancing the durable source cursor.
                            selected.pop(username, None)
                            break
                        elif command.get("type") == "stop":
                            STOP.set()
                        else:
                            raise ValueError(f"Unsupported collector command while awaiting batch acknowledgement: {command.get('type')}")
                    if STOP.is_set():
                        break
                    if username not in selected:
                        break
                    rows = db.get_new_messages_after(username, cursor=cursor, limit=500)
            except Exception as exc:
                emit({"event": "error", "stage": "message_poll", "sourceConversationId": username, "message": str(exc)})
                LOG.error("Message read failed for %s: %s", username, traceback.format_exc())

        now = time.monotonic()
        for username, source_message_ids in list(pending_media.items()):
            if STOP.is_set() or username not in selected or username in media_inflight:
                continue
            for source_message_id in sorted(source_message_ids):
                check_key = (username, source_message_id)
                if now - media_last_checked.get(check_key, float("-inf")) < MEDIA_RECHECK_INTERVAL_SECONDS:
                    continue
                media_last_checked[check_key] = now
                try:
                    updated_messages = recheck_media_message(
                        db, media_reader, account_id, username, source_message_id
                    )
                    if not updated_messages:
                        continue
                    emit({
                        "event": "media_batch", "channel": "wechat", "accountId": account_id,
                        "sourceConversationId": username, "mediaSourceMessageId": source_message_id,
                        "messages": updated_messages
                    })
                    media_inflight[username] = source_message_id
                    break
                except Exception as exc:
                    emit({"event": "error", "stage": "media_recheck", "sourceConversationId": username, "message": str(exc)})
                    LOG.error("Media recheck failed for %s: %s", username, traceback.format_exc())
        STOP.wait(1)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

# -*- coding: utf-8 -*-
"""解析微信聊天记录卡片及其内部消息。"""

from __future__ import annotations

import re
import xml.etree.ElementTree as ET
from typing import Any, Optional


_MAX_RECORD_XML_BYTES = 8 * 1024 * 1024
_DATATYPE_NAMES = {
    "1": "text",
    "2": "image",
    # Confirmed from the user's opened-forward sample: 4 carries video fields,
    # while 5 carries location title/description/link fields.
    "4": "video",
    "5": "location",
    # Observed on a merged-forward child whose size and fullmd5 matched the
    # downloaded local file exactly. Keep this mapping narrow until more
    # datatype values are evidenced.
    "8": "file",
}


def parse_merged_forward(content: Any, parent: Optional[dict] = None) -> Optional[dict]:
    """解析一条合并转发消息，返回父卡片和有序子消息；非此类消息返回 None。

    微信把 recorditem XML 作为外层 appmsg XML 元素的文本再次嵌入，因此要先解析
    外层，再解析 recorditem.text。未知 datatype 不猜类型，但保留原始字段供调用方适配。
    """
    if isinstance(content, bytes):
        try:
            content = content.decode("utf-8")
        except UnicodeDecodeError:
            return None
    if not isinstance(content, str) or not content.strip():
        return None
    if len(content.encode("utf-8", "replace")) > _MAX_RECORD_XML_BYTES:
        raise ValueError("merged forward XML exceeds the supported parse size")

    try:
        outer = ET.fromstring(content)
    except (ET.ParseError, ValueError):
        return None

    record = outer.find(".//recorditem")
    if record is None:
        return None
    embedded = (record.text or "").strip()
    if embedded:
        if len(embedded.encode("utf-8", "replace")) > _MAX_RECORD_XML_BYTES:
            raise ValueError("embedded merged forward XML exceeds the supported parse size")
        try:
            record_root = ET.fromstring(embedded)
        except (ET.ParseError, ValueError):
            # 兼容 recorditem 本身直接带子元素的 XML 形式。
            record_root = record
    else:
        record_root = record

    if record_root.tag != "recordinfo":
        found = record_root.find(".//recordinfo")
        if found is not None:
            record_root = found
    datalist = record_root.find("./datalist")
    if datalist is None:
        return None

    items = []
    for index, element in enumerate(datalist.findall("./dataitem")):
        fields = _element_fields(element)
        datatype = element.get("datatype") or ""
        source_epoch = _source_epoch(fields)
        media_fields = {
            key: value for key, value in fields.items()
            if key.lower() in {
                "cdnthumburl", "cdnthumbkey", "thumbfullmd5", "thumbsize",
                "cdndataurl", "cdndatakey", "fullmd5", "datasize", "filename",
                "file_name", "fileext", "mime", "mime_type", "datafileid",
                "fileid", "duration", "filesize", "filetype",
                "title", "desc", "link", "appid", "localfilename",
            }
        }
        original_name = _first(fields, "filename", "file_name", "fileName", "name")
        item = {
            "record_index": index,
            "data_id": element.get("dataid"),
            "datatype": datatype,
            "type": _DATATYPE_NAMES.get(datatype, "unknown"),
            "sender_name": _first(fields, "sourcename", "sendername"),
            "sender_username": _first(fields, "hashusername", "sourceusername"),
            "source_time": _first(fields, "sourcetime"),
            "source_create_time": _first(fields, "srcMsgCreateTime"),
            "source_timestamp": source_epoch,
            "text": _first(fields, "datadesc", "content"),
            "original_name": original_name,
            "media": media_fields,
            "raw_fields": fields,
        }
        if parent:
            item["parent_local_id"] = parent.get("local_id")
            item["parent_shard"] = parent.get("shard")
            item["parent_create_time"] = parent.get("create_time")
        items.append(item)

    # 每项都有来源时间时按来源时间排序；有缺失时保留微信原始 XML 顺序，避免推测。
    if items and all(item["source_timestamp"] is not None for item in items):
        items.sort(key=lambda item: (item["source_timestamp"], item["record_index"]))
    for seq, item in enumerate(items):
        item["sequence"] = seq

    record_fields = _element_fields(record_root)
    return {
        "parent": dict(parent or {}),
        "title": _first(record_fields, "title") or _outer_text(outer, "appmsg/title"),
        "description": _first(record_fields, "desc") or _outer_text(outer, "appmsg/des"),
        "items": items,
        "item_count_declared": _int_or_none(datalist.get("count")),
        "item_count_parsed": len(items),
    }


def normalize_message_type_code(value: Any, known_types=()) -> Any:
    """将微信 4.x 消息资源包装类型还原为已知基础类型码。"""
    try:
        code = int(value)
    except (TypeError, ValueError):
        return value
    if code <= 0xFFFF:
        return code
    base = code & 0xFFFFFFFF
    if base in known_types:
        return base
    low = base & 0xFF
    if low in known_types:
        return low
    return code


def _element_fields(element: ET.Element) -> dict[str, str]:
    fields: dict[str, str] = {}
    for child in list(element):
        if list(child):
            for nested in child.iter():
                if nested is child or list(nested):
                    continue
                text = (nested.text or "").strip()
                if text:
                    fields[nested.tag] = text
        else:
            text = (child.text or "").strip()
            if text:
                fields[child.tag] = text
    return fields


def _first(fields: dict[str, str], *names: str) -> Optional[str]:
    for name in names:
        value = fields.get(name)
        if value:
            return value
    return None


def _source_epoch(fields: dict[str, str]) -> Optional[int]:
    raw = _first(fields, "srcMsgCreateTime", "sourcetime")
    if not raw:
        return None
    if re.fullmatch(r"\d{10,13}", raw):
        value = int(raw)
        return value // 1000 if value >= 100_000_000_000 else value
    return None


def _int_or_none(value: Optional[str]) -> Optional[int]:
    try:
        return int(value) if value is not None else None
    except (TypeError, ValueError):
        return None


def _outer_text(root: ET.Element, path: str) -> Optional[str]:
    element = root.find(path)
    return (element.text or "").strip() if element is not None and element.text else None

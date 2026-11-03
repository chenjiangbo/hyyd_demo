import ast
import hashlib
import logging
import sys
import unittest
from pathlib import Path
from types import SimpleNamespace

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "vendor"))
from wechatauto.records import diagnose_merged_forward, normalize_message_type_code, parse_pat_message

source = Path(__file__).resolve().parents[1] / "collector.py"
tree = ast.parse(source.read_text(encoding="utf-8"))
functions = [node for node in tree.body if isinstance(node, ast.FunctionDef) and node.name in {"normalized_kind", "source_id", "encode_message"}]
module = ast.Module(body=[ast.ImportFrom(module="__future__", names=[ast.alias(name="annotations")], level=0), *functions], type_ignores=[])
ast.fix_missing_locations(module)
env = {"hashlib": hashlib, "Path": Path, "normalize_message_type_code": normalize_message_type_code,
       "parse_pat_message": parse_pat_message, "diagnose_merged_forward": diagnose_merged_forward,
       "utc_time": lambda value: "2026-11-02T00:00:00Z", "LOG": logging.getLogger(__name__)}
exec(compile(module, str(source), "exec"), env)


class MessageSpecialCasesTest(unittest.TestCase):
    def message(self, content):
        return {"local_id": 7, "shard": "message.db", "local_type": 49, "content": content,
                "sender_id": 1, "sender_username": "alice", "create_time": 1}

    def test_failed_forward_is_skipped_but_other_messages_continue(self):
        events = []
        env["emit"] = events.append
        db = SimpleNamespace(get_merged_forward=lambda *args, **kwargs: None, get_nickname=lambda _: '测试会话',
                             nickname_map=lambda: {"alice": "小王"})
        media = SimpleNamespace(save_dir="/tmp")
        bad = self.message("<msg><recorditem>broken</recorditem></msg>")
        self.assertEqual(env["encode_message"](db, media, "me", "chat", bad, "now", None), [])
        self.assertEqual(events[0]["rawContent"], bad["content"])
        self.assertEqual(events[0]["title"], '测试会话')
        pat = self.message('<msg><appmsg><title>小王 拍了拍我</title><type>62</type><patinfo/></appmsg></msg>')
        result = env["encode_message"](db, media, "me", "chat", pat, "now", None)
        self.assertEqual(result[0]["kind"], "system")
        self.assertEqual(result[0]["senderName"], "小王")
        self.assertEqual(result[0]["sourceMetadata"]["senderUsername"], "alice")
        self.assertEqual(result[0]["text"], "小王 拍了拍我")
        self.assertEqual(result[0]["attachments"], [])
        self.assertEqual(result[0]["sourceMetadata"]["rawContent"], pat["content"])


if __name__ == "__main__":
    unittest.main()

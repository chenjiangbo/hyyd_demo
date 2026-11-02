"""Check latest-cursor selection against the per-conversation SQLite schema."""
import ast
import sqlite3
from pathlib import Path
import unittest


SOURCE = Path(__file__).resolve().parents[1] / 'vendor' / 'wechatauto' / 'db.py'
tree = ast.parse(SOURCE.read_text(encoding='utf-8'))
database_class = next(node for node in tree.body if isinstance(node, ast.ClassDef) and node.name == 'WeChatDB')
methods = [node for node in database_class.body if isinstance(node, ast.FunctionDef) and node.name in {'_shard_rows', 'get_latest_message_cursor'}]
module = ast.Module(body=[ast.ImportFrom(module='__future__', names=[ast.alias(name='annotations')], level=0),
                          ast.ClassDef(name='CursorReader', bases=[], keywords=[], body=methods, decorator_list=[])], type_ignores=[])
ast.fix_missing_locations(module)
namespace = {'sqlite3': sqlite3}
exec(compile(module, str(SOURCE), 'exec'), namespace)
CursorReader = namespace['CursorReader']


class LatestCursorTest(unittest.TestCase):
    def test_latest_across_conversation_shards_without_username_column(self):
        reader = CursorReader()
        connections = []
        for shard, rows in [('a', [(1, 10), (2, 20)]), ('b', [(1, 20), (2, 15)])]:
            conn = sqlite3.connect(':memory:')
            conn.row_factory = sqlite3.Row
            conn.execute('CREATE TABLE messages (local_id INTEGER, local_type INTEGER, real_sender_id INTEGER, create_time INTEGER, message_content TEXT, source TEXT, packed_info_data BLOB, compress_content BLOB, server_id INTEGER, sort_seq INTEGER)')
            conn.executemany('INSERT INTO messages (local_id, sort_seq) VALUES (?, ?)', rows)
            connections.append((conn, 'messages', shard))
        reader._shard_label = lambda conn: next(shard for item, _, shard in connections if item is conn)
        reader._run_msg_query = lambda user, build: build([(conn, table) for conn, table, _ in connections])
        try:
            self.assertEqual(reader.get_latest_message_cursor('conversation'), {'sortSeq': 20, 'shard': 'b', 'localId': 1})
        finally:
            for conn, _, _ in connections:
                conn.close()


if __name__ == '__main__':
    unittest.main()

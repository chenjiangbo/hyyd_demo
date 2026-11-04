import ast
import logging
import copy
import queue
import threading
import time
import sqlite3
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import MagicMock, patch, mock_open


def load_reader():
    source = Path(__file__).resolve().parents[1] / 'vendor' / 'wechatauto' / 'db.py'
    tree = ast.parse(source.read_text(encoding='utf8'))
    cls = next(n for n in tree.body if isinstance(n, ast.ClassDef) and n.name == 'WeChatDB')
    names = {'_read_key_page_for_scan', '_refresh_db_files', '_msg_conns', 'retry_pending_key_reads'}
    methods = [n for n in cls.body if isinstance(n, ast.FunctionDef) and n.name in names]
    module = ast.Module(body=[ast.ImportFrom(module='__future__', names=[ast.alias(name='annotations')], level=0),
                             ast.ClassDef(name='Reader', bases=[], keywords=[], body=methods, decorator_list=[])], type_ignores=[])
    import os, re, sys
    clock = MagicMock()
    clock.monotonic.return_value = 100
    namespace = {'PAGE_SZ': 4096, 'wxlog': MagicMock(spec=logging.Logger), 'time': clock,
                 'os': os, 're': re, 'sys': sys, 'sqlite3': sqlite3, 'copy': copy, 'queue': queue, 'threading': threading, '_is_malformed': lambda exc: False}
    exec(compile(ast.fix_missing_locations(module), str(source), 'exec'), namespace)
    return namespace['Reader'](), namespace


class DatabaseKeyReadRetryTests(unittest.TestCase):
    def test_startup_waits_for_session_database_recovery(self):
        source = Path(__file__).resolve().parents[1] / 'collector.py'
        tree = ast.parse(source.read_text(encoding='utf8'))
        method = next(n for n in tree.body if isinstance(n, ast.FunctionDef) and n.name == 'wait_for_initial_sessions')
        reporter = MagicMock()
        namespace = {'RepeatedErrorReporter': lambda: reporter}
        module = ast.Module(body=[ast.ImportFrom(module='__future__', names=[ast.alias(name='annotations')], level=0), method], type_ignores=[])
        exec(compile(ast.fix_missing_locations(module), str(source), 'exec'), namespace)
        db = MagicMock()
        db.get_sessions.side_effect = [OSError('locked'), [{'username': 'chat'}]]
        stop = MagicMock()
        stop.is_set.return_value = False
        self.assertEqual(namespace['wait_for_initial_sessions'](db, stop), [{'username': 'chat'}])
        self.assertEqual(db.retry_pending_key_reads.call_count, 2)
        reporter.report.assert_called_once()
        stop.wait.assert_called_once_with(5)

    def test_locked_file_does_not_prevent_reading_other_file(self):
        reader, namespace = load_reader()
        reader._pending_key_reads = {}
        unreadable = set()
        good = mock_open(read_data=b'h' * 4096)
        with patch('builtins.open', side_effect=[PermissionError('locked'), good.return_value]) as opened:
            self.assertIsNone(reader._read_key_page_for_scan('locked', 'message_0.db', unreadable))
            self.assertIsNone(reader._read_key_page_for_scan('locked', 'message_0.db', unreadable))
            self.assertEqual(reader._read_key_page_for_scan('available', 'message_1.db', unreadable), b'h' * 4096)
        self.assertEqual(opened.call_count, 2)
        self.assertIn('message_0.db', reader._pending_key_reads)
        namespace['wxlog'].warning.assert_called_once()

    def test_incomplete_header_is_tracked_for_retry(self):
        reader, _ = load_reader()
        reader._pending_key_reads = {}
        with patch('builtins.open', mock_open(read_data=b'partial')):
            self.assertIsNone(reader._read_key_page_for_scan('path', 'message_0.db', set()))
        self.assertIn('message_0.db', reader._pending_key_reads)

    def test_retry_occurs_without_directory_changes(self):
        reader, namespace = load_reader()
        reader._pending_key_reads = {'message/message_0.db': 'locked'}
        reader._next_key_read_retry = 0
        reader._key_read_retry_result = queue.Queue(maxsize=1)
        reader._key_read_retry_running = False
        reader.account = 'account'
        reader.account_dir = '/account'
        reader._db_files = [('message/message_0.db', '/account/message_0.db', 1)]
        reader._keys = {}
        reader.extract_keys = MagicMock(return_value={'message/message_0.db': b'key'})
        reader._save_keys = MagicMock()
        reader._key_works = MagicMock(return_value=True)
        with patch.object(namespace['os'].path, 'join', return_value='/message'), patch.object(namespace['os'], 'listdir', return_value=['message_0.db']):
            reader._refresh_db_files()
            for _ in range(100):
                reader._refresh_db_files()
                if not reader._key_read_retry_running:
                    break
                time.sleep(0.001)
        reader.extract_keys.assert_called_once()
        self.assertEqual(reader._keys['message/message_0.db'], b'key')

    def test_missing_message_shard_closes_opened_connections_and_fails(self):
        reader, _ = load_reader()
        first = MagicMock()
        reader._message_dbs = lambda: ['message_0.db', 'message_1.db']
        reader._open = MagicMock(side_effect=[first, RuntimeError('missing key')])
        with self.assertRaisesRegex(RuntimeError, 'missing key'):
            reader._msg_conns('chat')
        first.close.assert_called_once()


if __name__ == '__main__':
    unittest.main()

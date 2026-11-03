import sys
import threading
import time
import unittest
import ast
import json
import os
import tempfile
import glob
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from async_image_key import AsyncImageKeyResolver, ImageKeyPending


class AsyncImageKeyTests(unittest.TestCase):
    def test_image_key_probe_ignores_non_v2_files(self):
        from cryptography.hazmat.primitives.ciphers import Cipher, algorithms, modes
        source = Path(__file__).resolve().parents[1] / 'vendor' / 'wechatauto' / 'media.py'
        tree = ast.parse(source.read_text(encoding='utf8'))
        media = next(n for n in tree.body if isinstance(n, ast.ClassDef) and n.name == 'MediaDownloader')
        methods = [n for n in media.body if isinstance(n, ast.FunctionDef) and n.name in ('_probe_ct', '_validate_key')]
        jpeg_like = next(n for n in tree.body if isinstance(n, ast.FunctionDef) and n.name == '_jpeg_like')
        module = ast.Module(body=[ast.ImportFrom(module='__future__', names=[ast.alias(name='annotations')], level=0), jpeg_like,
                                 ast.ClassDef(name='Reader', bases=[], keywords=[], body=methods, decorator_list=[])], type_ignores=[])
        namespace = {'os': os, 'glob': glob, 'V2_MAGIC': b'\x07\x08\x56\x32\x08\x07'}
        exec(compile(ast.fix_missing_locations(module), str(source), 'exec'), namespace)
        key = b'1234567890123456'
        encrypted = Cipher(algorithms.AES(key), modes.ECB()).encryptor().update(b'\xff\xd8\xff' + b'\0' * 13)
        with tempfile.TemporaryDirectory() as directory:
            image_dir = Path(directory) / 'msg' / 'attach' / 'chat' / '2026-11' / 'Img'
            image_dir.mkdir(parents=True)
            (image_dir / 'old.dat').write_bytes(b'old-format' + b'\0' * 50)
            (image_dir / 'new.dat').write_bytes(namespace['V2_MAGIC'] + b'\0' * 9 + encrypted)
            reader = namespace['Reader']()
            reader._key_probe = None
            reader.db = type('DB', (), {'account_dir': directory})()
            self.assertEqual(reader._probe_ct(), encrypted)
            self.assertTrue(reader._validate_key(key.decode()))
            self.assertFalse(reader._validate_key('abcdef1234567890'))

    def test_scan_does_not_block_and_is_shared(self):
        release = threading.Event()
        calls = []
        def scan():
            calls.append(1)
            release.wait(2)
            return '1234567890123456'
        resolver = AsyncImageKeyResolver(scan)
        started = time.monotonic()
        with self.assertRaises(ImageKeyPending):
            resolver.resolve()
        with self.assertRaises(ImageKeyPending):
            resolver.resolve()
        self.assertLess(time.monotonic() - started, 0.5)
        self.assertEqual(len(calls), 1)
        release.set()
        for _ in range(100):
            try:
                key = resolver.resolve()
                break
            except ImageKeyPending:
                time.sleep(0.01)
        else:
            self.fail('key scan never finished')
        self.assertEqual(key, '1234567890123456')
        self.assertEqual(len(calls), 1)

    def test_failure_is_reported_only_after_scan_finishes(self):
        resolver = AsyncImageKeyResolver(lambda: None, retry_interval=300)
        with self.assertRaises(ImageKeyPending):
            resolver.resolve()
        for _ in range(100):
            try:
                result = resolver.resolve()
                break
            except ImageKeyPending:
                time.sleep(0.01)
        else:
            self.fail('key scan never finished')
        self.assertIsNone(result)
        self.assertEqual(resolver.failure_generation, 1)
        self.assertIsNone(resolver.resolve())
        self.assertEqual(resolver.failure_generation, 1)

    def test_retry_counter_counts_each_completed_scan_once(self):
        source = (Path(__file__).resolve().parents[1] / 'collector.py').read_text(encoding='utf8')
        node = next(n for n in ast.parse(source).body if isinstance(n, ast.ClassDef) and n.name == 'MediaRetryState')
        namespace = {'Path': Path, 'json': json, 'os': os}
        exec(compile(ast.fix_missing_locations(ast.Module(body=[node], type_ignores=[])), 'collector.py', 'exec'), namespace)
        with tempfile.TemporaryDirectory() as directory:
            state = namespace['MediaRetryState'](Path(directory) / 'retry.json')
            self.assertEqual(state.aes_failure('image-a', 1), 1)
            self.assertEqual(state.aes_failure('image-a', 1), 1)
            self.assertEqual(state.aes_failure('image-b', 1), 1)
            self.assertEqual(state.aes_failure('image-a', 2), 2)
            self.assertEqual(state.aes_failure('image-a', 3), 3)
            self.assertEqual(namespace['MediaRetryState'](Path(directory) / 'retry.json').counts['image-a'], 3)


if __name__ == '__main__':
    unittest.main()

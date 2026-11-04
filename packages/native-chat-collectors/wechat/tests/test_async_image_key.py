import sys
import threading
import time
import unittest
import ast
import json
import os
import tempfile
import glob
import struct
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from async_image_key import AsyncImageKeyResolver, ImageKeyPending, ImageProbeMismatch


class AsyncImageKeyTests(unittest.TestCase):
    def test_incomplete_image_does_not_start_key_scan(self):
        sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'vendor'))
        from wechatauto.media import MediaDownloader, V2_MAGIC
        reader = object.__new__(MediaDownloader)
        reader._resolve_aes_key = lambda probe: self.fail('key scan must not start for an incomplete image')
        data = V2_MAGIC + struct.pack('<LL', 32, 0) + b'\0' + b'x' * 16
        with self.assertRaises(ImageProbeMismatch):
            reader._decrypt_v2(data, 'incomplete.dat', None, 0)

    def test_invalid_image_does_not_invalidate_key_or_consume_global_failure(self):
        finished = threading.Event()
        def scan(probe):
            if probe == b'valid':
                return 'key'
            finished.set()
            return None
        resolver = AsyncImageKeyResolver(scan, validate=lambda key, probe: probe == b'valid')
        with self.assertRaises(ImageKeyPending):
            resolver.resolve(b'valid')
        for _ in range(100):
            try:
                if resolver.resolve(b'valid') == 'key':
                    break
            except ImageKeyPending:
                time.sleep(0.001)
        else:
            self.fail('initial key was not obtained')
        with self.assertRaises(ImageKeyPending):
            resolver.resolve(b'bad-image')
        self.assertTrue(finished.wait(1))
        for _ in range(100):
            try:
                resolver.resolve(b'bad-image')
            except ImageProbeMismatch:
                break
            except ImageKeyPending:
                time.sleep(0.001)
        else:
            self.fail('bad image was not reported')
        self.assertEqual(resolver.resolve(b'valid'), 'key')
        self.assertEqual(resolver.failure_generation, 0)

    def test_decrypt_uses_current_image_probe_even_when_another_is_cached(self):
        from cryptography.hazmat.primitives.ciphers import Cipher, algorithms, modes
        source = Path(__file__).resolve().parents[1] / 'vendor' / 'wechatauto' / 'media.py'
        tree = ast.parse(source.read_text(encoding='utf8'))
        media = next(n for n in tree.body if isinstance(n, ast.ClassDef) and n.name == 'MediaDownloader')
        method = next(n for n in media.body if isinstance(n, ast.FunctionDef) and n.name == '_decrypt_v2')
        module = ast.Module(body=[ast.ImportFrom(module='__future__', names=[ast.alias(name='annotations')], level=0),
                                 ast.ClassDef(name='Reader', bases=[], keywords=[], body=[method], decorator_list=[])], type_ignores=[])
        namespace = {'struct': struct, 'aligned_aes_block_size': lambda n: n + (16 - n % 16),
                     'ImageAesKeyUnavailableError': RuntimeError}
        exec(compile(ast.fix_missing_locations(module), str(source), 'exec'), namespace)
        key = b'1234567890123456'
        plain = b'\xff\xd8\xff' + b'\r' * 13
        encrypted = Cipher(algorithms.AES(key), modes.ECB()).encryptor().update(plain)
        data = b'\x07\x08\x56\x32\x08\x07' + struct.pack('<LL', 3, 0) + b'\0' + encrypted
        seen = []
        reader = namespace['Reader']()
        reader._key_probe = b'wrong cached key sample!'
        reader._resolve_aes_key = lambda probe: seen.append(probe) or key.decode()
        self.assertEqual(reader._decrypt_v2(data, 'image.dat', None, 0, strip_footer=False), b'\xff\xd8\xff')
        self.assertEqual(seen, [encrypted])

    def test_background_scan_receives_image_probe(self):
        done = threading.Event()
        seen = []
        def scan(probe):
            seen.append(probe)
            done.set()
            return '1234567890123456'
        resolver = AsyncImageKeyResolver(scan)
        with self.assertRaises(ImageKeyPending):
            resolver.resolve(b'current-image')
        self.assertTrue(done.wait(1))
        self.assertEqual(seen, [b'current-image'])

    def test_new_valid_key_replaces_old_key_for_later_images(self):
        resolver = AsyncImageKeyResolver(lambda probe: 'old' if probe == b'old' else 'new',
                                         validate=lambda key, probe: key.encode() == probe)
        with self.assertRaises(ImageKeyPending):
            resolver.resolve(b'old')
        for _ in range(100):
            try:
                if resolver.resolve(b'old') == 'old':
                    break
            except ImageKeyPending:
                time.sleep(0.001)
        else:
            self.fail('old key unavailable')
        with self.assertRaises(ImageKeyPending):
            resolver.resolve(b'new')
        for _ in range(100):
            try:
                if resolver.resolve(b'new') == 'new':
                    break
            except ImageKeyPending:
                time.sleep(0.001)
        else:
            self.fail('new key unavailable')
        self.assertEqual(resolver.failure_generation, 0)

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

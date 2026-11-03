"""Resolve the shared WeChat image key without blocking message collection."""
from __future__ import annotations

import logging
import threading
import time
from typing import Callable, Optional

LOG = logging.getLogger('hyyd.wechat.collector')


class ImageKeyPending(Exception):
    """A shared background key scan is still running."""


class AsyncImageKeyResolver:
    def __init__(self, resolve: Callable[[], Optional[str]], retry_interval: float = 300) -> None:
        self._resolve = resolve
        self._retry_interval = retry_interval
        self._lock = threading.Lock()
        self._status = 'idle'
        self._key: Optional[str] = None
        self._failure_generation = 0
        self._retry_after = 0.0

    @property
    def failure_generation(self) -> int:
        with self._lock:
            return self._failure_generation

    def _scan(self) -> None:
        try:
            key = self._resolve()
        except Exception:
            LOG.exception('后台获取微信图片密钥失败')
            key = None
        with self._lock:
            if key:
                self._key = key
                self._status = 'ready'
                LOG.warning('微信图片密钥已获取，可继续补取图片')
            else:
                self._status = 'failed'
                self._failure_generation += 1
                self._retry_after = time.monotonic() + self._retry_interval
                LOG.warning('微信图片密钥获取失败，待下次重试，失败次数=%s', self._failure_generation)

    def resolve(self) -> Optional[str]:
        with self._lock:
            if self._status == 'ready':
                return self._key
            if self._status == 'failed':
                if time.monotonic() >= self._retry_after:
                    self._status = 'running'
                    threading.Thread(target=self._scan, name='wechat-image-key', daemon=True).start()
                return None
            if self._status == 'idle':
                self._status = 'running'
                threading.Thread(target=self._scan, name='wechat-image-key', daemon=True).start()
            raise ImageKeyPending('微信图片密钥正在后台获取')

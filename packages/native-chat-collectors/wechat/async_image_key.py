"""Resolve the shared WeChat image key without blocking message collection."""
from __future__ import annotations

import logging
import threading
import time
from typing import Callable, Optional

LOG = logging.getLogger('hyyd.wechat.collector')


class ImageKeyPending(Exception):
    """A shared background key scan is still running."""


class ImageProbeMismatch(Exception):
    """The current image cannot be validated with the available key."""


class AsyncImageKeyResolver:
    def __init__(self, resolve: Callable[..., Optional[str]], retry_interval: float = 300,
                 validate: Optional[Callable[[str, bytes], bool]] = None) -> None:
        self._resolve = resolve
        self._validate = validate
        self._retry_interval = retry_interval
        self._lock = threading.Lock()
        self._status = 'idle'
        self._key: Optional[str] = None
        self._failure_generation = 0
        self._retry_after = 0.0
        self._probe_retry_after: dict[bytes, float] = {}

    @property
    def failure_generation(self) -> int:
        with self._lock:
            return self._failure_generation

    def _scan(self, probe: Optional[bytes]) -> None:
        try:
            key = self._resolve(probe) if probe is not None else self._resolve()
        except Exception:
            LOG.exception('后台获取微信图片密钥失败')
            key = None
        with self._lock:
            if key:
                self._key = key
                self._status = 'ready'
                self._probe_retry_after.clear()
                LOG.warning('微信图片密钥已获取，可继续补取图片')
            else:
                self._status = 'ready' if self._key else 'failed'
                if not self._key:
                    self._failure_generation += 1
                    self._retry_after = time.monotonic() + self._retry_interval
                    LOG.warning('微信图片密钥获取失败，待下次重试，失败次数=%s', self._failure_generation)
                else:
                    if probe is not None:
                        now = time.monotonic()
                        self._probe_retry_after = {item: until for item, until in self._probe_retry_after.items() if until > now}
                        self._probe_retry_after[probe] = now + self._retry_interval
                    LOG.warning('当前图片密钥验证未通过，保留已获取的密钥并等待重试')

    def resolve(self, probe: Optional[bytes] = None) -> Optional[str]:
        with self._lock:
            if self._key and (probe is None or self._validate is None or self._validate(self._key, probe)):
                return self._key
            if self._key:
                if self._status != 'running' and time.monotonic() >= self._probe_retry_after.get(probe, 0):
                    self._status = 'running'
                    threading.Thread(target=self._scan, args=(probe,), name='wechat-image-key', daemon=True).start()
                    raise ImageKeyPending('正在核实当前图片的密钥')
                if self._status == 'running':
                    raise ImageKeyPending('正在核实当前图片的密钥')
                raise ImageProbeMismatch('当前图片无法使用已获取的密钥验证，等待图片文件更新后重试')
            if self._status == 'failed':
                if time.monotonic() >= self._retry_after:
                    self._status = 'running'
                    threading.Thread(target=self._scan, args=(probe,), name='wechat-image-key', daemon=True).start()
                return None
            if self._status == 'idle':
                self._status = 'running'
                threading.Thread(target=self._scan, args=(probe,), name='wechat-image-key', daemon=True).start()
            raise ImageKeyPending('微信图片密钥正在后台获取')

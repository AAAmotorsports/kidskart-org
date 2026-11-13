"""通過データの入力元。

- Simulator   : 実機なしで動作確認するための疑似データ
- RawCapture  : デコーダーの生データをそのままファイルに記録 (プロトコル解析用)

TranX3 の実データ形式は未確認。RawCapture で記録したログを解析してから、
`Tranx3Source` を追加する予定。
"""
from __future__ import annotations

import random
import threading
import time
from typing import Callable


class Simulator:
    """登録済み発信器がランダムなラップタイムで周回する疑似デコーダー。"""

    def __init__(self, tps: list[str], on_passing: Callable[[str], None],
                 lap_s: float = 8.0, speedup: float = 1.0):
        self.tps = tps
        self.on_passing = on_passing
        self.lap_s = lap_s
        self.speedup = speedup
        self._stop = threading.Event()
        self._thread: threading.Thread | None = None

    def start(self) -> None:
        self._stop.clear()
        self._thread = threading.Thread(target=self._run, daemon=True)
        self._thread.start()

    def stop(self) -> None:
        self._stop.set()

    @property
    def running(self) -> bool:
        return bool(self._thread and self._thread.is_alive() and not self._stop.is_set())

    def _run(self) -> None:
        rng = random.Random()
        pace = {tp: self.lap_s * rng.uniform(0.9, 1.15) for tp in self.tps}
        nxt = {tp: time.monotonic() + rng.uniform(0.2, 1.0) * pace[tp] / self.speedup
               for tp in self.tps}
        while not self._stop.is_set():
            now = time.monotonic()
            for tp in self.tps:
                if now >= nxt[tp]:
                    self.on_passing(tp)
                    lap = pace[tp] * rng.uniform(0.97, 1.03) / self.speedup
                    nxt[tp] = now + lap
            self._stop.wait(0.05)


def open_stream(port: str, baud: int = 9600, timeout: float = 0.5):
    """'COM3' / '/dev/ttyUSB0' ならシリアル、'192.168.0.10:12345' なら TCP を開く。

    返り値は read(n) -> bytes と close() を持つオブジェクト。
    """
    import re
    import socket

    m = re.fullmatch(r"([\w.\-]+):(\d{1,5})", port)
    if m and not port.upper().startswith("COM"):
        sock = socket.create_connection((m.group(1), int(m.group(2))), timeout=5)
        sock.settimeout(timeout)

        class _Tcp:
            def read(self, n: int = 4096) -> bytes:
                try:
                    return sock.recv(n)
                except socket.timeout:
                    return b""

            def close(self) -> None:
                sock.close()

        return _Tcp()
    try:
        import serial  # pyserial
    except ImportError as e:  # pragma: no cover
        raise SystemExit("pyserial が必要です: pip install pyserial") from e
    return serial.Serial(port, baud, timeout=timeout)

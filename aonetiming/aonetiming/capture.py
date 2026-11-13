"""通信記録ツール: デコーダーが送ってくる生データをそのままファイルに保存する。

使い方 (Windows のコマンドプロンプト):
    AoneTimingCapture.exe COM3              # シリアル 9600bps
    AoneTimingCapture.exe COM3 --baud 19200
    AoneTimingCapture.exe 192.168.0.10:12345   # LAN (TCP)

Ctrl+C で終了。同じフォルダに capture-日時.log (1行=1受信ブロック: 時刻 + 16進 + 文字) ができる。
このファイルを開発側に渡すと、TranX3 の通信形式を解析できる。
"""
from __future__ import annotations

import argparse
import sys
import time

from .sources import open_stream


def _printable(b: bytes) -> str:
    return "".join(chr(c) if 32 <= c < 127 else "." for c in b)


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description="デコーダー生データ記録ツール")
    ap.add_argument("port", help="COM3 または 192.168.0.10:ポート番号")
    ap.add_argument("--baud", type=int, default=9600)
    ap.add_argument("--out", help="出力ファイル (省略時は capture-日時.log)")
    a = ap.parse_args(argv)

    out = a.out or time.strftime("capture-%Y%m%d-%H%M%S.log")
    print(f"接続中: {a.port}  → 記録先: {out}  (Ctrl+C で終了)")
    stream = open_stream(a.port, a.baud)
    total = 0
    try:
        with open(out, "w", encoding="utf-8") as f:
            f.write(f"# AoneTiming capture port={a.port} baud={a.baud}\n")
            while True:
                data = stream.read(4096)
                if not data:
                    continue
                total += len(data)
                line = f"{time.time():.3f}\t{data.hex(' ')}\t{_printable(data)}\n"
                f.write(line)
                f.flush()
                print(f"\r受信 {total} バイト", end="", flush=True)
    except KeyboardInterrupt:
        print(f"\n終了しました。合計 {total} バイト → {out}")
    finally:
        stream.close()
    return 0


if __name__ == "__main__":
    sys.exit(main())

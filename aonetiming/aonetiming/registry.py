"""ゼッケンと発信器(トランスポンダー)の登録。CSV 入出力つき。"""
from __future__ import annotations

import csv
import io
import re

FIELDS = ["bib", "tp", "name", "team", "cls"]
HEADERS_JA = ["ゼッケン", "発信器", "選手名", "チーム名", "クラス"]


def _digits(s: str) -> str:
    return re.sub(r"\D", "", str(s or ""))


class Registry:
    def __init__(self, entries: list[dict] | None = None):
        self.entries: list[dict] = []
        if entries:
            self.set_entries(entries)

    def set_entries(self, entries: list[dict]) -> None:
        out, seen = [], set()
        for e in entries:
            tp = _digits(e.get("tp", ""))
            if not tp or tp in seen:
                continue  # 発信器が空 / 重複は捨てる
            seen.add(tp)
            out.append({
                "bib": str(e.get("bib", "")).strip(),
                "tp": tp,
                "name": str(e.get("name", "")).strip(),
                "team": str(e.get("team", "")).strip(),
                "cls": str(e.get("cls", "")).strip(),
            })
        self.entries = out

    def by_tp(self, tp: str) -> dict | None:
        tp = _digits(tp)
        for e in self.entries:
            if e["tp"] == tp:
                return e
        return None

    def to_csv(self) -> str:
        buf = io.StringIO()
        w = csv.writer(buf)
        w.writerow(HEADERS_JA)
        for e in self.entries:
            w.writerow([e[f] for f in FIELDS])
        return buf.getvalue()

    @staticmethod
    def parse_csv(text: str) -> list[dict]:
        """ヘッダーあり/なしどちらも可。列順: ゼッケン,発信器,選手名,チーム名,クラス"""
        rows = list(csv.reader(io.StringIO(text.lstrip("﻿"))))
        out = []
        for i, r in enumerate(rows):
            if not r or not any(c.strip() for c in r):
                continue
            if i == 0 and not _digits(r[1] if len(r) > 1 else ""):
                continue  # ヘッダー行
            r = (r + [""] * 5)[:5]
            out.append(dict(zip(FIELDS, r)))
        return out

    @staticmethod
    def decode_bytes(raw: bytes) -> str:
        for enc in ("utf-8-sig", "cp932"):
            try:
                return raw.decode(enc)
            except UnicodeDecodeError:
                continue
        return raw.decode("utf-8", errors="replace")

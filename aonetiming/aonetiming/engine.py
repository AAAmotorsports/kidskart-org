"""計測エンジン: 通過データ(passing) から周回・ベスト・順位を求める。

時刻はすべて整数ミリ秒。デコーダー時計でも PC 時計でもよいが、
1 つのセッション内では同じ時計を使うこと。
"""
from __future__ import annotations

import time
from typing import Optional

KINDS = ("tt", "race")  # tt = タイムトライアル, race = レース(予選/決勝)


def fmt_ms(ms: Optional[int], with_min: bool = True) -> str:
    """ミリ秒 -> "1:23.456" (1分未満でも分を出す)。None は空文字。"""
    if ms is None:
        return ""
    sign = "-" if ms < 0 else ""
    ms = abs(int(ms))
    m, rem = divmod(ms, 60000)
    s, milli = divmod(rem, 1000)
    if with_min:
        return f"{sign}{m}:{s:02d}.{milli:03d}"
    return f"{sign}{m * 60 + s}.{milli:03d}"


class Session:
    def __init__(self, kind: str = "tt", title: str = "", class_name: str = "",
                 min_lap_ms: int = 0):
        if kind not in KINDS:
            raise ValueError(f"kind must be one of {KINDS}")
        self.id = time.strftime("%Y%m%d-%H%M%S")
        self.kind = kind
        self.title = title
        self.class_name = class_name
        self.min_lap_ms = int(min_lap_ms)
        self.state = "ready"          # ready -> running -> stopped
        self.start_ms: Optional[int] = None
        self.passings: list[dict] = []  # {seq, tp, t, ok}
        self.invalid: set[str] = set()   # "tp:lapNo" 無効化(ベスト抹消など)
        self.penalty_ms: dict[str, int] = {}
        self.extra: list[str] = []       # 未走行ドライバー追加 (tp)

    # ---- 計測の操作 ----
    def start(self, now_ms: int) -> None:
        if self.state != "ready":
            raise ValueError("すでに開始しています")
        self.state = "running"
        self.start_ms = int(now_ms)

    def stop(self) -> None:
        if self.state == "running":
            self.state = "stopped"

    def add_passing(self, tp: str, t_ms: int) -> Optional[dict]:
        """通過を追加。計測中以外は無視。最小ラップ未満は ok=False で記録のみ。"""
        if self.state != "running":
            return None
        tp = str(tp)
        t_ms = int(t_ms)
        last = self._last_ok(tp)
        ok = True
        if last is not None and t_ms - last < self.min_lap_ms:
            ok = False
        elif last is None and self.kind == "race" and self.start_ms is not None \
                and t_ms - self.start_ms < self.min_lap_ms:
            ok = False
        p = {"seq": len(self.passings) + 1, "tp": tp, "t": t_ms, "ok": ok}
        self.passings.append(p)
        return p

    def _last_ok(self, tp: str) -> Optional[int]:
        for p in reversed(self.passings):
            if p["tp"] == tp and p["ok"]:
                return p["t"]
        return None

    # ---- 修正 ----
    def set_lap_invalid(self, tp: str, lap_no: int, invalid: bool = True) -> None:
        key = f"{tp}:{int(lap_no)}"
        if invalid:
            self.invalid.add(key)
        else:
            self.invalid.discard(key)

    def invalidate_best(self, tp: str) -> Optional[int]:
        """現在のベストラップを無効にして、その周回番号を返す。"""
        best = None
        for lap in self.laps(tp):
            if lap["invalid"]:
                continue
            if best is None or lap["ms"] < best["ms"]:
                best = lap
        if best is None:
            return None
        self.set_lap_invalid(tp, best["no"], True)
        return best["no"]

    def add_penalty(self, tp: str, add_ms: int) -> int:
        tp = str(tp)
        self.penalty_ms[tp] = self.penalty_ms.get(tp, 0) + int(add_ms)
        return self.penalty_ms[tp]

    def add_extra(self, tp: str) -> None:
        tp = str(tp)
        if tp not in self.extra:
            self.extra.append(tp)

    def remove_driver(self, tp: str) -> None:
        tp = str(tp)
        self.passings = [p for p in self.passings if p["tp"] != tp]
        for i, p in enumerate(self.passings, 1):
            p["seq"] = i
        self.invalid = {k for k in self.invalid if not k.startswith(tp + ":")}
        self.penalty_ms.pop(tp, None)
        self.extra = [e for e in self.extra if e != tp]

    # ---- 集計 ----
    def transponders(self) -> list[str]:
        seen: list[str] = []
        for p in self.passings:
            if p["tp"] not in seen:
                seen.append(p["tp"])
        for e in self.extra:
            if e not in seen:
                seen.append(e)
        return seen

    def laps(self, tp: str) -> list[dict]:
        """周回リスト [{no, ms, end, invalid}]。

        レース: 計測開始時刻からの最初の通過が 1 周目。
        タイムトライアル: 最初の通過は基準点(周回数に入れず)、次の通過から 1 周目。
        """
        times = sorted(p["t"] for p in self.passings if p["tp"] == tp and p["ok"])
        if self.kind == "race" and self.start_ms is not None:
            base = self.start_ms
        elif times:
            base, times = times[0], times[1:]
        else:
            return []
        out = []
        prev = base
        for i, t in enumerate(times, 1):
            out.append({"no": i, "ms": t - prev, "end": t,
                        "invalid": f"{tp}:{i}" in self.invalid})
            prev = t
        return out

    def stats(self, tp: str) -> dict:
        laps = self.laps(tp)
        valid = [l for l in laps if not l["invalid"]]
        best = min(valid, key=lambda l: l["ms"]) if valid else None
        pen = self.penalty_ms.get(tp, 0)
        total = None
        if laps and self.start_ms is not None and self.kind == "race":
            total = laps[-1]["end"] - self.start_ms + pen
        elif laps:
            total = sum(l["ms"] for l in laps) + pen
        return {
            "tp": tp,
            "laps": len(laps),
            "best_ms": best["ms"] if best else None,
            "best_lap": best["no"] if best else None,
            "last_ms": laps[-1]["ms"] if laps else None,
            "total_ms": total,
            "penalty_ms": pen,
        }

    def ranking(self) -> list[dict]:
        rows = [self.stats(tp) for tp in self.transponders()]
        if self.kind == "tt":
            key = lambda r: (r["best_ms"] is None, r["best_ms"] or 0)
        else:
            key = lambda r: (-r["laps"], r["total_ms"] if r["total_ms"] is not None else 0)
        rows.sort(key=key)
        lead = rows[0] if rows else None
        for pos, r in enumerate(rows, 1):
            r["pos"] = pos
            r["gap_ms"] = None
            r["gap_laps"] = 0
            if lead is None or r is lead:
                continue
            if self.kind == "tt":
                if r["best_ms"] is not None and lead["best_ms"] is not None:
                    r["gap_ms"] = r["best_ms"] - lead["best_ms"]
            else:
                r["gap_laps"] = lead["laps"] - r["laps"]
                if r["gap_laps"] == 0 and r["total_ms"] is not None \
                        and lead["total_ms"] is not None:
                    r["gap_ms"] = r["total_ms"] - lead["total_ms"]
        return rows

    # ---- 保存 ----
    def to_dict(self) -> dict:
        return {
            "id": self.id, "kind": self.kind, "title": self.title,
            "class_name": self.class_name, "min_lap_ms": self.min_lap_ms,
            "state": self.state, "start_ms": self.start_ms,
            "passings": self.passings, "invalid": sorted(self.invalid),
            "penalty_ms": self.penalty_ms, "extra": self.extra,
        }

    @classmethod
    def from_dict(cls, d: dict) -> "Session":
        s = cls(d.get("kind", "tt"), d.get("title", ""), d.get("class_name", ""),
                d.get("min_lap_ms", 0))
        s.id = d.get("id", s.id)
        s.state = d.get("state", "ready")
        s.start_ms = d.get("start_ms")
        s.passings = list(d.get("passings", []))
        s.invalid = set(d.get("invalid", []))
        s.penalty_ms = dict(d.get("penalty_ms", {}))
        s.extra = list(d.get("extra", []))
        return s

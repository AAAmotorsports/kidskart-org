"""アプリ本体: 登録・セッション・保存・入力元をまとめる(スレッドセーフ)。"""
from __future__ import annotations

import csv
import io
import threading
import time
from pathlib import Path

from .engine import Session, fmt_ms
from .registry import Registry
from .sources import Simulator
from .store import Store

DEFAULT_CLASSES = ["スプリント", "90分耐久", "MicroMAX", "MiniMAX", "MAX Lights",
                   "ジュニアMAX", "公式練習"]


class App:
    def __init__(self, data_dir: Path | None = None):
        self.lock = threading.RLock()
        self.store = Store(data_dir)
        self.registry = self.store.load_registry()
        self.settings = {"min_lap_s": 0, "classes": list(DEFAULT_CLASSES)}
        cur, st = self.store.load_current()
        self.settings.update(st)
        self.session: Session = cur or Session("tt", "", "", self._min_lap_ms())
        self.sim: Simulator | None = None
        self._t0 = time.monotonic()

    # ---- 時計 ----
    def now_ms(self) -> int:
        return int((time.monotonic() - self._t0) * 1000) + 1_000_000

    def _min_lap_ms(self) -> int:
        return int(float(self.settings.get("min_lap_s", 0)) * 1000)

    def _persist(self) -> None:
        self.store.save_current(self.session, self.settings)

    # ---- 計測 ----
    def new_session(self, kind: str, title: str = "", class_name: str = "") -> None:
        with self.lock:
            self.stop_sim()
            self.session = Session(kind, title, class_name, self._min_lap_ms())
            self._persist()

    def start(self) -> None:
        with self.lock:
            self.session.start(self.now_ms())
            self._persist()

    def stop(self) -> None:
        with self.lock:
            self.session.stop()
            self._persist()

    def reset(self) -> None:
        """計測やり直し: 同じ設定で最初から。"""
        with self.lock:
            s = self.session
            self.new_session(s.kind, s.title, s.class_name)

    def passing(self, tp: str, t_ms: int | None = None):
        with self.lock:
            p = self.session.add_passing(tp, self.now_ms() if t_ms is None else t_ms)
            if p:
                self._persist()
            return p

    # ---- 修正 ----
    def edit(self, op: str, tp: str = "", **kw) -> dict:
        with self.lock:
            s = self.session
            res: dict = {}
            if op == "invalidate_best":
                res["lap"] = s.invalidate_best(tp)
            elif op == "invalidate_lap":
                s.set_lap_invalid(tp, int(kw["lap"]), True)
            elif op == "restore_lap":
                s.set_lap_invalid(tp, int(kw["lap"]), False)
            elif op == "penalty":
                res["penalty_ms"] = s.add_penalty(tp, int(float(kw["seconds"]) * 1000))
            elif op == "add_extra":
                s.add_extra(tp)
            elif op == "remove_driver":
                s.remove_driver(tp)
            else:
                raise ValueError(f"unknown op: {op}")
            self._persist()
            return res

    # ---- 設定・登録 ----
    def update_settings(self, d: dict) -> None:
        with self.lock:
            if "min_lap_s" in d:
                self.settings["min_lap_s"] = max(0.0, float(d["min_lap_s"]))
                self.session.min_lap_ms = self._min_lap_ms()
            if "classes" in d:
                self.settings["classes"] = [str(c) for c in d["classes"] if str(c).strip()]
            self._persist()

    def set_registry(self, entries: list[dict]) -> None:
        with self.lock:
            self.registry.set_entries(entries)
            self.store.save_registry(self.registry)

    # ---- シミュレーター(動作確認用) ----
    def start_sim(self, speedup: float = 4.0) -> None:
        with self.lock:
            self.stop_sim()
            tps = [e["tp"] for e in self.registry.entries][:20]
            if not tps:
                raise ValueError("先に発信器を登録してください")
            self.sim = Simulator(tps, lambda tp: self.passing(tp), speedup=speedup)
            self.sim.start()

    def stop_sim(self) -> None:
        if self.sim:
            self.sim.stop()
            self.sim = None

    # ---- 保存 ----
    def save_result(self) -> str:
        with self.lock:
            return self.store.save_result(self.session, self.registry)

    def load_result(self, rid: str) -> None:
        with self.lock:
            self.stop_sim()
            s, reg = self.store.load_result(rid)
            self.session = s
            if reg:
                self.registry.set_entries(reg)
            self._persist()

    # ---- 表示用 ----
    def _driver(self, tp: str) -> dict:
        e = self.registry.by_tp(tp) or {}
        return {"bib": e.get("bib") or "?", "name": e.get("name", ""),
                "team": e.get("team", ""), "cls": e.get("cls", ""), "registered": bool(e)}

    def state(self) -> dict:
        with self.lock:
            s = self.session
            rows = []
            for r in s.ranking():
                r = dict(r)
                r.update(self._driver(r["tp"]))
                r["laps_detail"] = [dict(l) for l in s.laps(r["tp"])]
                rows.append(r)
            recent = []
            for p in reversed(s.passings[-30:]):
                d = self._driver(p["tp"])
                laps = s.laps(p["tp"])
                lap = next((l for l in laps if l["end"] == p["t"]), None)
                recent.append({"seq": p["seq"], "tp": p["tp"], "bib": d["bib"], "ok": p["ok"],
                               "lap_no": lap["no"] if lap else None,
                               "lap_ms": lap["ms"] if lap else None})
            return {
                "session": {"id": s.id, "kind": s.kind, "title": s.title,
                            "class_name": s.class_name, "state": s.state,
                            "elapsed_ms": (self.now_ms() - s.start_ms)
                            if s.state == "running" and s.start_ms is not None else None},
                "ranking": rows, "recent": recent,
                "registry": self.registry.entries,
                "settings": self.settings,
                "sim": bool(self.sim and self.sim.running),
                "results": self.store.list_results(),
                "total_passings": len(s.passings),
            }

    def export_csv(self) -> str:
        with self.lock:
            s = self.session
            buf = io.StringIO()
            w = csv.writer(buf)
            w.writerow([s.title, s.class_name, "タイムトライアル" if s.kind == "tt" else "レース"])
            w.writerow(["順位", "ゼッケン", "選手名", "チーム", "周回", "ベスト", "ベスト周",
                        "合計", "ペナルティ(秒)", "差"])
            for r in s.ranking():
                d = self._driver(r["tp"])
                gap = ""
                if r["gap_laps"]:
                    gap = f"+{r['gap_laps']}周"
                elif r["gap_ms"] is not None:
                    gap = "+" + fmt_ms(r["gap_ms"], with_min=False)
                w.writerow([r["pos"], d["bib"], d["name"], d["team"], r["laps"],
                            fmt_ms(r["best_ms"]), r["best_lap"] or "", fmt_ms(r["total_ms"]),
                            r["penalty_ms"] / 1000 if r["penalty_ms"] else "", gap])
            return "﻿" + buf.getvalue()  # BOM つき: Excel でそのまま開ける

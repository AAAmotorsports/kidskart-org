"""データの保存場所と読み書き。実行ファイルと同じフォルダの AoneTimingData/ を使う。"""
from __future__ import annotations

import json
import os
import sys
from pathlib import Path

from .engine import Session
from .registry import Registry


def default_data_dir() -> Path:
    env = os.environ.get("AONETIMING_DATA")
    if env:
        return Path(env)
    base = Path(sys.executable).parent if getattr(sys, "frozen", False) else Path.cwd()
    return base / "AoneTimingData"


def _atomic_write(path: Path, text: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(text, encoding="utf-8")
    os.replace(tmp, path)


class Store:
    def __init__(self, root: Path | None = None):
        self.root = Path(root) if root else default_data_dir()
        self.sessions_dir = self.root / "sessions"

    # 登録
    def load_registry(self) -> Registry:
        p = self.root / "registry.csv"
        if not p.exists():
            return Registry()
        return Registry(Registry.parse_csv(Registry.decode_bytes(p.read_bytes())))

    def save_registry(self, reg: Registry) -> None:
        _atomic_write(self.root / "registry.csv", reg.to_csv())

    # 進行中セッション (クラッシュ対策。通過のたびに書く)
    def save_current(self, s: Session, settings: dict) -> None:
        _atomic_write(self.root / "current.json",
                      json.dumps({"session": s.to_dict(), "settings": settings},
                                 ensure_ascii=False))

    def load_current(self) -> tuple[Session | None, dict]:
        p = self.root / "current.json"
        if not p.exists():
            return None, {}
        try:
            d = json.loads(p.read_text(encoding="utf-8"))
            return Session.from_dict(d["session"]), d.get("settings", {})
        except (ValueError, KeyError):
            return None, {}

    # 結果の保存
    def save_result(self, s: Session, registry: Registry) -> str:
        snap = {"session": s.to_dict(), "registry": registry.entries}
        rid = s.id
        _atomic_write(self.sessions_dir / f"{rid}.json",
                      json.dumps(snap, ensure_ascii=False, indent=1))
        return rid

    def list_results(self) -> list[dict]:
        out = []
        if self.sessions_dir.exists():
            for p in sorted(self.sessions_dir.glob("*.json"), reverse=True):
                try:
                    d = json.loads(p.read_text(encoding="utf-8"))["session"]
                    out.append({"id": d["id"], "title": d.get("title", ""),
                                "kind": d.get("kind"), "class_name": d.get("class_name", "")})
                except (ValueError, KeyError):
                    continue
        return out

    def load_result(self, rid: str) -> tuple[Session, list[dict]]:
        if not rid.replace("-", "").isalnum():
            raise ValueError("bad id")
        d = json.loads((self.sessions_dir / f"{rid}.json").read_text(encoding="utf-8"))
        return Session.from_dict(d["session"]), d.get("registry", [])

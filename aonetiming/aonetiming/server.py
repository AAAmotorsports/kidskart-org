"""ローカル HTTP サーバー(標準ライブラリのみ)。ブラウザで http://localhost:8765 を開いて使う。"""
from __future__ import annotations

import json
import mimetypes
import threading
import webbrowser
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import unquote, urlparse

from .app import App

WEB = Path(__file__).parent / "web"


def make_handler(app: App):
    class H(BaseHTTPRequestHandler):
        server_version = "AoneTiming"

        def log_message(self, *a):  # 静かに
            pass

        def _send(self, code: int, body: bytes, ctype: str, extra: dict | None = None):
            self.send_response(code)
            self.send_header("Content-Type", ctype)
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Cache-Control", "no-store")
            for k, v in (extra or {}).items():
                self.send_header(k, v)
            self.end_headers()
            self.wfile.write(body)

        def _json(self, obj, code: int = 200):
            self._send(code, json.dumps(obj, ensure_ascii=False).encode(),
                       "application/json; charset=utf-8")

        def _body(self) -> dict:
            n = int(self.headers.get("Content-Length") or 0)
            if not n:
                return {}
            raw = self.rfile.read(n)
            if self.headers.get("Content-Type", "").startswith("application/json"):
                return json.loads(raw.decode("utf-8"))
            return {"_raw": raw}

        def do_GET(self):
            path = unquote(urlparse(self.path).path)
            if path == "/api/state":
                return self._json(app.state())
            if path == "/api/registry.csv":
                return self._send(200, ("﻿" + app.registry.to_csv()).encode("utf-8"),
                                  "text/csv; charset=utf-8",
                                  {"Content-Disposition": 'attachment; filename="registry.csv"'})
            if path == "/api/result.csv":
                return self._send(200, app.export_csv().encode("utf-8"),
                                  "text/csv; charset=utf-8",
                                  {"Content-Disposition": 'attachment; filename="result.csv"'})
            rel = "index.html" if path in ("/", "") else path.lstrip("/")
            f = (WEB / rel).resolve()
            if WEB.resolve() not in f.parents or not f.is_file():
                return self._send(404, b"not found", "text/plain")
            ctype = mimetypes.guess_type(f.name)[0] or "application/octet-stream"
            if ctype.startswith("text/") or ctype.endswith("javascript"):
                ctype += "; charset=utf-8"
            self._send(200, f.read_bytes(), ctype)

        def do_POST(self):
            path = unquote(urlparse(self.path).path)
            try:
                b = self._body()
                if path == "/api/session/new":
                    app.new_session(b["kind"], b.get("title", ""), b.get("class_name", ""))
                elif path == "/api/session/start":
                    app.start()
                elif path == "/api/session/stop":
                    app.stop()
                elif path == "/api/session/reset":
                    app.reset()
                elif path == "/api/passing":
                    app.passing(str(b["tp"]))
                elif path == "/api/edit":
                    return self._json({"ok": True, **app.edit(b.pop("op"), b.pop("tp", ""), **b)})
                elif path == "/api/settings":
                    app.update_settings(b)
                elif path == "/api/registry":
                    app.set_registry(b["entries"])
                elif path == "/api/registry/import":
                    from .registry import Registry
                    text = Registry.decode_bytes(b["_raw"])
                    app.set_registry(Registry.parse_csv(text))
                elif path == "/api/result/save":
                    return self._json({"ok": True, "id": app.save_result()})
                elif path == "/api/result/load":
                    app.load_result(b["id"])
                elif path == "/api/sim/start":
                    app.start_sim(float(b.get("speedup", 4)))
                elif path == "/api/sim/stop":
                    app.stop_sim()
                else:
                    return self._json({"ok": False, "error": "not found"}, 404)
                self._json({"ok": True})
            except (KeyError, ValueError, FileNotFoundError) as e:
                self._json({"ok": False, "error": str(e)}, 400)

    return H


def serve(app: App, host: str = "127.0.0.1", port: int = 8765, open_browser: bool = True):
    httpd = ThreadingHTTPServer((host, port), make_handler(app))
    url = f"http://localhost:{port}"
    print(f"AoneTiming 起動: {url}   (終了: このウィンドウで Ctrl+C)")
    if open_browser:
        threading.Timer(0.8, lambda: webbrowser.open(url)).start()
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        httpd.server_close()
    return httpd

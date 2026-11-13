import json
import tempfile
import threading
import unittest
import urllib.request
from http.server import ThreadingHTTPServer
from pathlib import Path

from aonetiming.app import App
from aonetiming.server import make_handler


class ServerTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.app = App(Path(self.tmp.name))
        self.httpd = ThreadingHTTPServer(("127.0.0.1", 0), make_handler(self.app))
        threading.Thread(target=self.httpd.serve_forever, daemon=True).start()
        self.base = f"http://127.0.0.1:{self.httpd.server_address[1]}"

    def tearDown(self):
        self.httpd.shutdown()
        self.httpd.server_close()
        self.tmp.cleanup()

    def post(self, path, body=None):
        req = urllib.request.Request(self.base + path, json.dumps(body or {}).encode(),
                                     {"Content-Type": "application/json"})
        try:
            return json.load(urllib.request.urlopen(req))
        except urllib.error.HTTPError as e:
            return json.load(e)

    def get(self, path):
        return urllib.request.urlopen(self.base + path).read()

    def state(self):
        return json.loads(self.get("/api/state"))

    def test_full_flow_and_persistence(self):
        self.post("/api/registry", {"entries": [
            {"bib": "7", "tp": "14029666", "name": "山田"}, {"bib": "8", "tp": "12232551"}]})
        self.post("/api/session/new", {"kind": "tt", "title": "テスト"})
        self.post("/api/session/start")
        self.post("/api/passing", {"tp": "14029666"})
        st = self.state()
        self.assertEqual(st["ranking"][0]["bib"], "7")
        self.assertEqual(st["session"]["state"], "running")
        # 再起動しても進行中データが残る
        app2 = App(Path(self.tmp.name))
        self.assertEqual(app2.session.title, "テスト")
        self.assertEqual(len(app2.session.passings), 1)
        self.assertEqual(len(app2.registry.entries), 2)

    def test_save_and_load_result_and_csv(self):
        self.post("/api/registry", {"entries": [{"bib": "7", "tp": "1"}]})
        self.post("/api/session/new", {"kind": "race", "title": "決勝"})
        self.post("/api/session/start")
        self.post("/api/passing", {"tp": "1"})
        rid = self.post("/api/result/save")["id"]
        self.post("/api/session/new", {"kind": "tt"})
        self.assertEqual(self.state()["ranking"], [])
        self.assertEqual(self.post("/api/result/load", {"id": rid})["ok"], True)
        self.assertEqual(len(self.state()["ranking"]), 1)
        self.assertIn("決勝", self.get("/api/result.csv").decode("utf-8"))
        self.assertFalse(self.post("/api/result/load", {"id": "../x"})["ok"])

    def test_edit_ops(self):
        self.post("/api/session/new", {"kind": "race"})
        self.post("/api/session/start")
        for _ in range(2):
            self.post("/api/passing", {"tp": "5"})
        self.assertTrue(self.post("/api/edit", {"op": "penalty", "tp": "5", "seconds": 5})["ok"])
        self.assertEqual(self.state()["ranking"][0]["penalty_ms"], 5000)
        self.assertFalse(self.post("/api/edit", {"op": "nope"})["ok"])

    def test_static_and_traversal(self):
        self.assertIn(b"AoneTiming", self.get("/"))
        with self.assertRaises(urllib.error.HTTPError):
            self.get("/../app.py")


if __name__ == "__main__":
    unittest.main()

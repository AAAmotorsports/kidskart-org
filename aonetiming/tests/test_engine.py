import unittest

from aonetiming.engine import Session, fmt_ms
from aonetiming.registry import Registry


class FmtTest(unittest.TestCase):
    def test_fmt(self):
        self.assertEqual(fmt_ms(83456), "1:23.456")
        self.assertEqual(fmt_ms(5000, with_min=False), "5.000")
        self.assertEqual(fmt_ms(None), "")


class TimeTrialTest(unittest.TestCase):
    def make(self):
        s = Session("tt")
        s.start(0)
        # A: 基準 1000, 周回 +60s, +58s, +61s   B: 基準 2000, 周回 +59s
        for tp, t in [("A", 1000), ("B", 2000), ("A", 61000), ("B", 61000),
                      ("A", 119000), ("A", 180000)]:
            s.add_passing(tp, t)
        return s

    def test_first_passing_is_baseline(self):
        s = self.make()
        self.assertEqual([l["ms"] for l in s.laps("A")], [60000, 58000, 61000])
        self.assertEqual([l["ms"] for l in s.laps("B")], [59000])

    def test_ranking_by_best(self):
        r = self.make().ranking()
        self.assertEqual([x["tp"] for x in r], ["A", "B"])  # A best 58.0 < B 59.0
        self.assertEqual(r[0]["best_ms"], 58000)
        self.assertEqual(r[1]["gap_ms"], 1000)

    def test_invalidate_best_moves_to_next(self):
        s = self.make()
        s.invalidate_best("A")
        self.assertEqual(s.stats("A")["best_ms"], 60000)
        r = s.ranking()
        self.assertEqual([x["tp"] for x in r], ["B", "A"])

    def test_no_laps_ranked_last(self):
        s = self.make()
        s.add_extra("Z")
        self.assertEqual(s.ranking()[-1]["tp"], "Z")


class RaceTest(unittest.TestCase):
    def make(self):
        s = Session("race")
        s.start(10_000)  # 計測開始ボタン。ここは 1 周目の始まりではない
        # 各自の最初の通過が基準点。 A: 周回 60,60  B: 65,65  C: 80
        for tp, ts in {"A": [80_000, 140_000, 200_000],
                       "B": [75_000, 140_000, 205_000],
                       "C": [90_000, 170_000]}.items():
            for t in ts:
                s.add_passing(tp, t)
        return s

    def test_first_passing_after_start_is_baseline(self):
        s = self.make()
        self.assertEqual([l["ms"] for l in s.laps("A")], [60000, 60000])
        self.assertEqual(s.stats("A")["laps"], 2)

    def test_order_laps_then_total(self):
        r = self.make().ranking()
        self.assertEqual([x["tp"] for x in r], ["A", "B", "C"])
        self.assertEqual(r[0]["total_ms"], 120_000)
        self.assertEqual(r[1]["gap_ms"], 10_000)
        self.assertEqual(r[2]["gap_laps"], 1)

    def test_penalty_changes_order(self):
        s = self.make()
        s.add_penalty("A", 5000)
        s.add_penalty("A", 6000)
        r = s.ranking()
        self.assertEqual([x["tp"] for x in r], ["B", "A", "C"])
        self.assertEqual(s.stats("A")["total_ms"], 131_000)

    def test_invalid_lap_still_counts_as_lap(self):
        s = self.make()
        s.set_lap_invalid("B", 1)
        self.assertEqual(s.stats("B")["laps"], 2)
        self.assertEqual(s.stats("B")["best_ms"], 65000)

    def test_remove_driver(self):
        s = self.make()
        s.add_penalty("A", 5000)
        s.remove_driver("A")
        self.assertEqual([x["tp"] for x in s.ranking()], ["B", "C"])


class MinLapAndStateTest(unittest.TestCase):
    def test_ignored_before_start_and_after_stop(self):
        s = Session("tt")
        self.assertIsNone(s.add_passing("A", 1))
        s.start(0)
        s.add_passing("A", 1000)
        s.stop()
        self.assertIsNone(s.add_passing("A", 70000))

    def test_min_lap_rejects_double_read(self):
        s = Session("tt", min_lap_ms=20000)
        s.start(0)
        s.add_passing("A", 1000)
        p = s.add_passing("A", 1500)       # 二重検知
        self.assertFalse(p["ok"])
        s.add_passing("A", 61000)
        self.assertEqual([l["ms"] for l in s.laps("A")], [60000])

    def test_roundtrip(self):
        s = Session("race", "決勝", "MiniMAX")
        s.start(0)
        s.add_passing("A", 5000)
        s.add_penalty("A", 5000)
        s.set_lap_invalid("A", 1)
        s2 = Session.from_dict(s.to_dict())
        self.assertEqual(s2.to_dict(), s.to_dict())


class RegistryTest(unittest.TestCase):
    def test_csv_roundtrip_and_header(self):
        r = Registry([{"bib": "1", "tp": "14029666", "name": "山田", "team": "T", "cls": "MiniMAX"},
                      {"bib": "2", "tp": "12232551"}])
        r2 = Registry(Registry.parse_csv(r.to_csv()))
        self.assertEqual(r2.entries, r.entries)

    def test_cp932_and_dupes(self):
        raw = "1,14029666,山田,,\n2,14029666,重複,,\n3,,空,,\n".encode("cp932")
        reg = Registry(Registry.parse_csv(Registry.decode_bytes(raw)))
        self.assertEqual(len(reg.entries), 1)
        self.assertEqual(reg.by_tp("14029666")["name"], "山田")


if __name__ == "__main__":
    unittest.main()

"""Unit tests for the recorder's pure parts: carry_forward and claude_reading (no network)."""
import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import recorder  # noqa: E402

NOW = 1_800_000_000


def rec(idx, seen=None, w=None, f=None, src="headers", **extra):
    return {"id": idx, "p": "codex", "on": True, "w": w, "f": f, "seen": seen, "src": src, **extra}


class CarryTests(unittest.TestCase):
    def test_carries_last_reading_after_restart(self):
        week = {"used": 48.0, "reset": NOW + 86400}
        five = {"used": 30.0, "reset": NOW - 60}          # reset since: must not be carried
        samples = [{"t": NOW - 600, "a": [rec("a", NOW - 900, week, five, plan="pro")]},
                   {"t": NOW - 300, "a": [rec("a")]}]     # first sample after the restart
        out = recorder.carry_forward([rec("a")], samples, NOW)[0]
        self.assertEqual((out["src"], out["seen"], out["w"], out["f"], out["plan"]),
                         ("carry", NOW - 900, week, None, "pro"))

    def test_leaves_fresh_and_stale_readings_alone(self):
        week = {"used": 10.0, "reset": NOW + 86400}
        samples = [{"t": NOW - 7 * 3600, "a": [rec("a", NOW - 7 * 3600, week)]}]
        self.assertIsNone(recorder.carry_forward([rec("a")], samples, NOW)[0]["w"])
        fresh = rec("a", NOW - 10, {"used": 1.0, "reset": None})
        self.assertEqual(recorder.carry_forward([fresh], samples, NOW)[0]["src"], "headers")
        self.assertEqual(recorder.carry_forward([rec("b")], samples, NOW)[0]["src"], "headers")

    def test_carries_the_fable_window_only_when_it_is_still_open(self):
        week = {"used": 48.0, "reset": NOW + 86400}
        fable = {"used": 20.0, "reset": NOW + 86400}
        samples = [{"t": NOW - 600, "a": [rec("a", NOW - 900, week, wf=fable)]}]
        self.assertEqual(recorder.carry_forward([rec("a")], samples, NOW)[0]["wf"], fable)
        # Reset since, or never recorded: the key stays out rather than becoming null.
        stale = [{"t": NOW - 600, "a": [rec("a", NOW - 900, week, wf={"used": 9.0, "reset": NOW - 1})]}]
        self.assertNotIn("wf", recorder.carry_forward([rec("a")], stale, NOW)[0])
        plain = [{"t": NOW - 600, "a": [rec("a", NOW - 900, week)]}]
        self.assertNotIn("wf", recorder.carry_forward([rec("a")], plain, NOW)[0])


def headers(weekly=None, five=None, fable=None, reset=NOW + 86400):
    sig = {}
    for name, used in (("7d", weekly), ("5h", five), ("7d_oi", fable)):
        if used is not None:
            sig[f"Anthropic-Ratelimit-Unified-{name}-Utilization"] = str(used)
            sig[f"Anthropic-Ratelimit-Unified-{name}-Reset"] = str(reset)
    return sig


def snapshot(observed, *windows):
    return {"observed_at": observed, "windows": [
        {"kind": kind, "utilization": used, "resets_at": NOW + 3600, **({"scope": scope} if scope else {})}
        for kind, used, scope in windows]}


class ClaudeReadingTests(unittest.TestCase):
    def test_headers_alone_give_weekly_five_hour_and_fable(self):
        weekly, five, fable, seen, src = recorder.claude_reading(
            headers(weekly=0.77, five=0.1, fable=0.55), NOW - 60, None)
        self.assertEqual(weekly, {"used": 77.0, "reset": NOW + 86400})
        self.assertEqual(five, {"used": 10.0, "reset": NOW + 86400})
        self.assertEqual(fable, {"used": 55.0, "reset": NOW + 86400})
        self.assertEqual((seen, src), (NOW - 60, "headers"))
        self.assertEqual(recorder.claude_reading({}, None, None), (None, None, None, None, "headers"))

    def test_a_fresher_snapshot_replaces_the_windows_it_reports(self):
        snap = snapshot(NOW - 30, ("seven_day", 0.78, None), ("weekly_scoped", 0.2, "Opus"),
                        ("weekly_scoped", 0.56, "Fable"))
        weekly, five, fable, seen, src = recorder.claude_reading(
            headers(weekly=0.77, five=0.1, fable=0.55), NOW - 60, snap)
        self.assertEqual(weekly, {"used": 78.0, "reset": NOW + 3600})
        self.assertEqual(five["used"], 10.0)             # not in the snapshot: headers stay
        self.assertEqual(fable, {"used": 56.0, "reset": NOW + 3600})  # Fable, not the Opus scope
        self.assertEqual((seen, src), (NOW - 30, "usage"))

    def test_fable_falls_back_to_whichever_source_has_it(self):
        fable_only = snapshot(NOW - 600, ("weekly_scoped", 0.3, "fable 5"))
        # Headers are newer and win, but carry no Fable window: the snapshot's is kept.
        weekly, _, fable, seen, src = recorder.claude_reading(headers(weekly=0.5), NOW - 60, fable_only)
        self.assertEqual((weekly["used"], fable["used"], seen, src), (50.0, 30.0, NOW - 60, "headers"))
        # The snapshot is newer but has no Fable window: the header's is kept.
        no_fable = snapshot(NOW - 30, ("seven_day", 0.6, None))
        weekly, _, fable, seen, src = recorder.claude_reading(
            headers(weekly=0.5, fable=0.04), NOW - 60, no_fable)
        self.assertEqual((weekly["used"], fable["used"], seen, src), (60.0, 4.0, NOW - 30, "usage"))
        # A snapshot without a timestamp never outranks dated headers.
        undated = snapshot(None, ("seven_day", 0.9, None))
        self.assertEqual(recorder.claude_reading(headers(weekly=0.5), NOW - 60, undated)[0]["used"], 50.0)


if __name__ == "__main__":
    unittest.main()

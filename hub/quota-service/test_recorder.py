"""Unit tests for recorder.carry_forward (no network)."""
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


if __name__ == "__main__":
    unittest.main()

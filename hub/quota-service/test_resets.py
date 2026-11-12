"""Unit tests for resets.py. Stdlib only, no network: a fake hub and clock."""
import base64
import json
import os
import stat
import sys
import tempfile
import threading
import unittest
import urllib.error
import urllib.request
from datetime import datetime, timezone

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import resets  # noqa: E402

KEY = "test-management-key-0123456789"
ORG = "0f0e0d0c-0b0a-4908-8706-050403020100"
T0 = 1_800_000_000
CLAUDE = "aaaa000000000001"
CODEX = "cccc000000000002"
ACCOUNT_ID = "acct-secret-chatgpt-id"


def iso(t):
    return datetime.fromtimestamp(t, timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.%fZ")


def jwt(payload):
    seg = base64.urlsafe_b64encode(json.dumps(payload).encode()).decode().rstrip("=")
    return f"e30.{seg}.sig"


class Clock:
    def __init__(self, t=T0):
        self.t = t

    def __call__(self):
        return self.t


class FakeHub:
    """Stands in for resets.Hub; records every call."""

    def __init__(self, clock):
        self.clock = clock
        self.calls = []
        self.claude_limited = False
        self.codex_used = 0
        self.observed = clock.t
        self.cedar = {CLAUDE: {"eligible": True, "at_limit": False, "grants": []}}
        self.status_code = {}
        self.credits = {CODEX: []}
        self.claim_reply = (200, {"result": "reset"})
        self.consume_reply = (200, {"code": "reset"})
        self.on_claim = None
        self.cooldown_ok = True
        self.profile_code = 200
        self.honor_credit_id = True

    def key(self):
        return KEY

    def get(self, path):
        self.calls.append(("GET", path))
        if path == "/v8/management/credentials":
            obs = iso(self.observed)
            return {"files": [
                {"provider": "claude", "auth_index": CLAUDE, "email": "a@example.com",
                 "quota": {"observed_at": obs, "signals": {
                     "Anthropic-Ratelimit-Unified-7d-Utilization":
                         "1.0" if self.claude_limited else "0.5",
                     "Anthropic-Ratelimit-Unified-7d-Reset": str(self.clock.t + 86400)}}},
                {"provider": "codex", "auth_index": CODEX, "email": "b@example.com",
                 "id_token": jwt({"chatgpt_account_id": ACCOUNT_ID}),
                 "quota": {"observed_at": obs, "signals": {
                     "X-Codex-Primary-Used-Percent": str(self.codex_used),
                     "X-Codex-Primary-Window-Minutes": "10080",
                     "X-Codex-Primary-Reset-At": str(self.clock.t + 86400)}}},
                {"provider": "claude", "auth_index": "dddd", "disabled": True},
            ]}
        if path.startswith("/v0/management/plugins/claude-seat-pacer"):
            return {"auths": []}
        raise AssertionError(path)

    def post(self, path, body):
        self.calls.append(("POST", path, body))
        assert path == "/v8/management/routing/cooldown/reset"
        return {"status": "ok" if self.cooldown_ok else "error", "auth_index": body["auth_index"]}

    def api_call(self, idx, method, url, header, data=None, timeout=20):
        self.calls.append(("API", idx, method, url, dict(header), data))
        if url == resets.CLAUDE_STATUS_URL:
            code = self.status_code.get(idx, 200)
            return code, ({"cedar_ember": self.cedar[idx]} if code == 200 else {"error": "x"})
        if url == resets.CLAUDE_PROFILE_URL:
            if self.profile_code != 200:
                return self.profile_code, {"error": "x"}
            return 200, {"organization": {"uuid": ORG.upper()}, "account": {"email": "x@y"}}
        if url.endswith("/reset_rate_limits"):
            if self.on_claim:
                self.on_claim(json.loads(data))
            reply = self.claim_reply
            if isinstance(reply, Exception):
                raise reply
            return reply
        if url == resets.CODEX_CREDITS_URL:
            code = self.status_code.get(idx, 200)
            return code, {"available_count": len(self.credits[idx]), "credits": [
                {"id": c["id"], "reset_type": "codex_rate_limits", "status": "available",
                 "granted_at": iso(T0 - 86400), "expires_at": iso(c["expires"])}
                for c in self.credits[idx]]}
        if url == resets.CODEX_CONSUME_URL:
            reply = self.consume_reply
            if isinstance(reply, Exception):
                raise reply
            if reply[0] == 200 and reply[1].get("code") == "reset" and self.credits[idx]:
                named = json.loads(data).get("credit_id") if self.honor_credit_id else None
                listed = [c["id"] for c in self.credits[idx]]
                self.credits[idx].pop(listed.index(named) if named in listed else 0)
            return reply
        raise AssertionError(url)

    def api(self, suffix):
        return [c for c in self.calls if c[0] == "API" and c[3].endswith(suffix)]

    def profiles(self):
        return self.api("/api/oauth/profile")

    def claims(self):
        return self.api("/reset_rate_limits")

    def consumes(self):
        return self.api("/consume")


def grant(gid="spring_2026", expires=T0 + 3 * 3600, left=1, total=1, **extra):
    g = {"id": gid, "label": "Spring reset", "resets_total": total, "resets_left": left,
         "starts_at": iso(T0 - 86400), "ends_at": iso(expires), "clears": ["seven_day"],
         "paused": False, "usable_now": True, "use_requires_limit": True}
    g.update(extra)
    return g


class Base(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.dir = self.tmp.name
        self.clock = Clock()
        self.hub = FakeHub(self.clock)
        self.ids = iter(f"req-{n:04d}" for n in range(1000))
        self.svc = self.make()

    def tearDown(self):
        self.tmp.cleanup()

    LEAD = 600          # these tests run inside the final stretch: one attempt a minute
    ARMED = True

    def make(self):
        return resets.Service(
            self.hub, clock=self.clock, state_file=os.path.join(self.dir, "state.json"),
            public_file=os.path.join(self.dir, "public", "resets.json"),
            log_file=os.path.join(self.dir, "resets.log"), new_id=lambda: next(self.ids),
            echo=False, lead=self.LEAD, armed=self.ARMED)

    def run_until(self, t, step=30):
        while self.clock.t < t:
            self.clock.t = min(t, self.clock.t + step)
            self.svc.tick()

    def gstate(self, gid, account=CLAUDE):
        return self.svc.grant_state(f"{account}/{gid}", self.clock.t)

    def public(self):
        with open(os.path.join(self.dir, "public", "resets.json")) as fh:
            return json.load(fh)


class ParsingTests(unittest.TestCase):
    def test_claude_status_defaults_and_sanitising(self):
        g = grant(label="Bonus\x00\n  reset " + "x" * 200)
        del g["usable_now"], g["use_requires_limit"], g["paused"]
        status = resets.parse_claude_status({"eligible": True, "grants": [g],
                                             "ineligible_reason": "weird", "next_grant_id": "nope"})
        self.assertEqual(status["ineligible_reason"], "unknown")
        self.assertIsNone(status["next_grant_id"])
        self.assertFalse(status["at_limit"])
        parsed = status["grants"][0]
        self.assertFalse(parsed["usable"])
        self.assertTrue(parsed["requires_limit"])
        self.assertEqual(parsed["clears"], ["seven_day"])
        self.assertTrue(parsed["label"].startswith("Bonus reset x"))
        self.assertEqual(len(parsed["label"]), 120)
        self.assertEqual(parsed["expires"], T0 + 3 * 3600)

    def test_claude_status_rejects_whole_block(self):
        bad = [
            [grant(), grant()],                       # duplicate id
            [grant(gid="Bad-ID")],                    # uppercase
            [grant(gid="ok\n")],                      # trailing newline must not match
            [grant(left=2, total=1)],
            [grant(ends_at="not a date")],
            [grant(usable_now="yes")],
            [grant(clears="seven_day")],
        ]
        for grants in bad:
            self.assertIsNone(resets.parse_claude_status({"eligible": True, "grants": grants}))
        self.assertIsNone(resets.parse_claude_status({"eligible": "true"}))
        self.assertIsNone(resets.parse_claude_status({"eligible": True, "at_limit": 1}))
        self.assertIsNone(resets.parse_claude_status(None))

    def test_blocker(self):
        status = resets.parse_claude_status({"eligible": True, "at_limit": False,
                                             "grants": [grant()]})
        self.assertEqual(resets.claude_blocker(status, "spring_2026", T0), "not_limited")
        status["at_limit"] = True
        self.assertIsNone(resets.claude_blocker(status, "spring_2026", T0))
        self.assertEqual(resets.claude_blocker(status, "other", T0), "unknown_grant")
        self.assertEqual(resets.claude_blocker(status, "spring_2026", T0 + 4 * 3600),
                         "grant_expired")
        status["cooldown_until"] = T0 + 60
        self.assertEqual(resets.claude_blocker(status, "spring_2026", T0), "cooldown")
        status["grants"][0]["starts"] = T0 + 10
        self.assertEqual(resets.claude_blocker(status, "spring_2026", T0), "not_started")
        status["eligible"] = False
        self.assertEqual(resets.claude_blocker(status, "spring_2026", T0), "ineligible")

    def test_codex_credits(self):
        payload = {"available_count": 2, "credits": [
            {"id": "RateLimitResetCredit_abc", "reset_type": "codex_rate_limits",
             "status": "available", "granted_at": iso(T0), "expires_at": iso(T0 + 100)},
            {"id": "x", "reset_type": "other", "status": "available", "expires_at": iso(T0)},
            {"id": "y", "reset_type": "codex_rate_limits", "status": "used",
             "expires_at": iso(T0)},
            {"reset_type": "codex_rate_limits", "status": "available", "expires_at": iso(T0)},
        ]}
        out = resets.parse_codex_credits(json.dumps(payload))
        self.assertEqual(out["available_count"], 2)
        self.assertEqual([c["id"] for c in out["credits"]][0], "RateLimitResetCredit_abc")
        self.assertTrue(out["credits"][1]["id"].startswith("codex-"))
        self.assertEqual(out["credits"][0]["expires"], T0 + 100)
        self.assertIsNone(resets.parse_codex_credits({"unrelated": 1}))
        self.assertIsNone(resets.parse_codex_credits("not json"))

    def test_codex_account_id_and_epoch(self):
        self.assertEqual(resets.codex_account_id({"id_token": jwt({"chatgpt_account_id": "a1"})}),
                         "a1")
        self.assertEqual(resets.codex_account_id({"metadata": {"chatgpt_account_id": "m"}}), "m")
        self.assertIsNone(resets.codex_account_id({}))
        self.assertEqual(resets.epoch("2026-10-31T15:00:15.00038693Z"), 1793458815)
        self.assertIsNone(resets.epoch("0001-01-01T00:00:00Z"))
        self.assertEqual(resets.epoch("1793458815"), 1793458815)

    def test_limit_signals(self):
        sig = {"Anthropic-Ratelimit-Unified-7d-Utilization": "1.0",
               "Anthropic-Ratelimit-Unified-7d-Reset": str(T0 + 10)}
        self.assertTrue(resets.claude_limited(sig, None, T0))
        self.assertFalse(resets.claude_limited(sig, None, T0 + 20))   # window already reset
        self.assertTrue(resets.claude_limited({"Anthropic-Ratelimit-Unified-Status": "rejected"},
                                              None, T0))
        self.assertFalse(resets.claude_limited({"Anthropic-Ratelimit-Unified-Overage-Status":
                                                "rejected"}, None, T0))
        pacer = {"windows": [{"kind": "five_hour", "utilization": 1, "resets_at": iso(T0 + 60)}]}
        self.assertTrue(resets.claude_limited({}, pacer, T0))
        self.assertIsNone(resets.claude_limited({}, None, T0))
        self.assertTrue(resets.codex_limited({"X-Codex-Primary-Used-Percent": "100",
                                              "X-Codex-Primary-Window-Minutes": "10080"}, T0))
        self.assertFalse(resets.codex_limited({"X-Codex-Secondary-Used-Percent": "100",
                                               "X-Codex-Secondary-Window-Minutes": "0"}, T0))


class ClaudePolicyTests(Base):
    def test_expiry_waits_then_keeps_trying_while_not_limited(self):
        expires = T0 + 3 * 3600
        self.hub.cedar[CLAUDE]["grants"] = [grant(expires=expires)]
        self.svc.tick()
        key = f"{CLAUDE}/spring_2026"
        self.assertEqual(self.svc.next_action(key, self.clock.t), expires - 600)
        self.run_until(expires - 601)
        self.assertEqual(self.hub.claims(), [])
        self.assertEqual(self.gstate("spring_2026"), "pending")
        self.run_until(expires + 30)
        self.assertEqual(self.hub.claims(), [])           # never claimed while not limited
        results = [e["result"] for e in self.svc.state["log"]]
        self.assertGreaterEqual(results.count("not_limited"), 8)
        self.assertEqual(results[0], "expired")
        self.assertEqual(self.gstate("spring_2026"), "expired")

    def test_pre_action_read(self):
        expires = T0 + 3 * 3600
        self.hub.cedar[CLAUDE]["grants"] = [grant(expires=expires)]
        self.svc.tick()
        reads = lambda: len(self.hub.api(resets.CLAUDE_STATUS_URL[-30:]))  # noqa: E731
        first = reads()
        action = expires - 600
        self.run_until(action - 1200 - 31)
        mid = reads()
        self.run_until(action - 1200 + 30)
        self.assertEqual(reads(), mid + 1)
        self.assertGreater(mid, first)                    # hourly reads happened too

    def test_at_limit_claims_with_exact_shape(self):
        expires = T0 + 3600
        self.hub.cedar[CLAUDE].update(at_limit=True, grants=[grant(expires=expires)])
        self.svc.tick()
        # The fake never decrements resets_left: an upstream lag must not cause a re-claim.
        self.run_until(expires - 600)
        claims = self.hub.claims()
        self.assertEqual(len(claims), 1)
        _, idx, method, url, header, data = claims[0]
        self.assertEqual((idx, method), (CLAUDE, "POST"))
        self.assertEqual(url, f"https://api.anthropic.com/api/organizations/{ORG}/reset_rate_limits")
        self.assertEqual(header, resets.CLAUDE_HEADERS)
        self.assertEqual(json.loads(data), {"program": "cedar_ember", "grant_id": "spring_2026",
                                            "request_id": "req-0000"})
        self.assertIn(("POST", "/v8/management/routing/cooldown/reset",
                       {"auth_index": CLAUDE}), self.hub.calls)
        self.assertEqual(self.gstate("spring_2026"), "spent")
        last = self.svc.state["grants"][f"{CLAUDE}/spring_2026"]["last"]
        self.assertEqual((last["trigger"], last["result"]), ("expiry", "reset"))
        self.run_until(expires + 60)
        self.assertEqual(len(self.hub.claims()), 1)

    def test_multi_reset_grant_spends_one_per_attempt(self):
        self.hub.cedar[CLAUDE].update(at_limit=True, grants=[grant(left=2, total=2)])
        self.svc.tick()
        key = f"{CLAUDE}/spring_2026"
        self.assertEqual(self.svc.manual_spend(key), "reset")
        g = self.svc.state["grants"][key]
        self.assertEqual((g["left"], g["final"]), (1, None))
        self.assertEqual(self.gstate("spring_2026"), "pending")

    def test_unknown_outcome_reuses_request_id_across_restart(self):
        expires = T0 + 3600
        self.hub.cedar[CLAUDE].update(at_limit=True, grants=[grant(expires=expires)])
        self.hub.claim_reply = resets.HubError("hub_timeout", True)
        journalled = []

        def on_claim(body):  # the journal must be on disk before the claim leaves
            with open(os.path.join(self.dir, "state.json")) as fh:
                saved = json.load(fh)
            journalled.append(saved["journal"][f"{CLAUDE}/spring_2026"]["rid"])
            self.assertEqual(journalled[-1], body["request_id"])

        self.hub.on_claim = on_claim
        self.svc.tick()
        self.run_until(expires - 600)
        self.assertEqual(self.gstate("spring_2026"), "unknown")
        self.svc = self.make()                            # service restart
        self.run_until(expires - 600 + 60)
        rids = [json.loads(c[5])["request_id"] for c in self.hub.claims()]
        self.assertEqual(rids, ["req-0000", "req-0000"])
        self.hub.claim_reply = (200, {"result": "already_used"})
        self.run_until(expires - 600 + 120)
        self.assertEqual([json.loads(c[5])["request_id"] for c in self.hub.claims()][-1],
                         "req-0000")
        self.assertEqual(self.gstate("spring_2026"), "spent")
        self.assertEqual(journalled, ["req-0000"] * 3)

    def test_unknown_after_window_needs_fresh_read_and_new_id(self):
        self.hub.cedar[CLAUDE].update(at_limit=True, grants=[grant(expires=T0 + 7200)])
        self.hub.claim_reply = (502, "bad gateway")
        self.svc.tick()
        key = f"{CLAUDE}/spring_2026"
        self.assertEqual(self.svc.manual_spend(key), "unknown")
        self.clock.t += 601
        self.hub.claim_reply = (200, {"result": "not_limited"})
        self.assertEqual(self.svc.manual_spend(key), "not_limited")
        rids = [json.loads(c[5])["request_id"] for c in self.hub.claims()]
        self.assertEqual(rids, ["req-0000", "req-0001"])

    def test_refusal_codes_settle_without_spending(self):
        self.hub.cedar[CLAUDE].update(at_limit=True, grants=[grant(expires=T0 + 7200)])
        self.svc.tick()
        key = f"{CLAUDE}/spring_2026"
        for status, body, code in ((429, {}, "rate_limited"), (401, {}, "auth_error"),
                                   (200, {"result": "cooldown"}, "cooldown")):
            self.hub.claim_reply = (status, body)
            self.assertEqual(self.svc.manual_spend(key), code)
            self.assertEqual(self.gstate("spring_2026"), "pending")
        self.assertFalse([c for c in self.hub.calls if c[0] == "POST"])

    def test_limit_policy(self):
        self.hub.cedar[CLAUDE]["grants"] = [grant(expires=T0 + 86400)]
        self.svc.tick()
        key = f"{CLAUDE}/spring_2026"
        self.svc.set_policy(key, "limit")
        self.run_until(T0 + 600)
        self.assertEqual(self.hub.claims(), [])
        self.hub.claude_limited = True
        self.hub.observed = self.clock.t
        self.run_until(self.clock.t + 30)                 # limited, but preflight disagrees
        self.assertEqual(self.svc.state["grants"][key]["last"]["result"], "not_limited")
        attempts = len(self.svc.state["log"])
        self.run_until(self.clock.t + 500)
        self.assertEqual(len(self.svc.state["log"]), attempts)   # <= one attempt per 10 min
        self.hub.cedar[CLAUDE]["at_limit"] = True
        self.run_until(self.clock.t + 120)
        self.assertEqual(len(self.hub.claims()), 1)
        self.assertEqual(self.gstate("spring_2026"), "spent")
        last = self.svc.state["grants"][key]["last"]
        self.assertEqual((last["trigger"], last["result"]), ("limit", "reset"))

    def test_off_and_default_policy(self):
        self.hub.cedar[CLAUDE].update(at_limit=True, grants=[grant(expires=T0 + 3600)])
        self.svc.tick()
        self.svc.set_default_policy("off")
        self.assertEqual(self.gstate("spring_2026"), "off")
        self.run_until(T0 + 3600 - 300)
        self.assertEqual(self.hub.claims(), [])
        key = f"{CLAUDE}/spring_2026"
        self.svc.set_policy(key, "expiry")
        self.run_until(self.clock.t + 30)
        self.assertEqual(len(self.hub.claims()), 1)

    def test_manual_spend_not_limited(self):
        self.hub.cedar[CLAUDE]["grants"] = [grant()]
        self.svc.tick()
        self.assertEqual(self.svc.manual_spend(f"{CLAUDE}/spring_2026"), "not_limited")
        self.assertEqual(self.hub.claims(), [])

    def test_read_429_backs_off_and_keeps_data(self):
        self.hub.cedar[CLAUDE]["grants"] = [grant(expires=T0 + 86400)]
        self.svc.tick()
        self.hub.status_code[CLAUDE] = 429
        self.clock.t += 3601 + resets.READ_STAGGER
        self.svc.tick()
        acct = self.svc.state["accounts"][CLAUDE]
        self.assertEqual(acct["error"], "rate_limited")
        self.assertEqual(acct["next_check"], self.clock.t + 7200)
        reads = len(self.hub.api("skip_spend=1"))
        self.run_until(self.clock.t + 7000, step=300)
        self.assertEqual(len(self.hub.api("skip_spend=1")), reads)
        self.assertEqual(self.gstate("spring_2026"), "pending")
        self.assertEqual([g["id"] for g in self.public()["grants"] if g["p"] == "claude"],
                         ["spring_2026"])
        self.hub.status_code[CLAUDE] = 200
        self.run_until(self.clock.t + 300)
        self.assertIsNone(self.svc.state["accounts"][CLAUDE]["error"])

    def test_spent_grants_kept_seven_days(self):
        self.hub.cedar[CLAUDE].update(at_limit=True, grants=[grant(expires=T0 + 86400)])
        self.svc.tick()
        self.svc.manual_spend(f"{CLAUDE}/spring_2026")
        self.hub.cedar[CLAUDE]["grants"] = []
        self.clock.t += 6 * 86400
        self.svc.tick()
        self.assertIn("spring_2026", [g["id"] for g in self.public()["grants"]])
        self.clock.t += 2 * 86400
        self.svc.tick()
        self.assertNotIn("spring_2026", [g["id"] for g in self.public()["grants"]])


class CodexTests(Base):
    def test_consume_and_verify(self):
        expires = T0 + 7200
        self.hub.credits[CODEX] = [{"id": "RateLimitResetCredit_1", "expires": expires}]
        self.svc.tick()
        self.run_until(T0 + 120)
        self.assertEqual(self.gstate("RateLimitResetCredit_1", CODEX), "pending")
        self.run_until(expires - 600)
        consumes = self.hub.consumes()
        self.assertEqual(len(consumes), 1)
        _, idx, method, url, header, data = consumes[0]
        # The consume names its credit, so upstream cannot use a different one.
        self.assertEqual(json.loads(data), {"redeem_request_id": "req-0000",
                                            "credit_id": "RateLimitResetCredit_1"})
        self.assertEqual(header, {**resets.CODEX_HEADERS, "Chatgpt-Account-Id": ACCOUNT_ID})
        reads = self.hub.api("rate-limit-reset-credits")
        self.assertEqual(reads[-1][4]["OpenAI-Beta"], "codex-1")
        self.assertIn(("POST", "/v8/management/routing/cooldown/reset", {"auth_index": CODEX}),
                      self.hub.calls)
        self.assertEqual(self.gstate("RateLimitResetCredit_1", CODEX), "spent")
        last = self.svc.state["grants"][f"{CODEX}/RateLimitResetCredit_1"]["last"]
        self.assertEqual(last["result"], "reset")
        self.assertIn("verified", last["detail"])
        self.run_until(expires + 60)
        self.assertEqual(len(self.hub.consumes()), 1)

    def test_unknown_consume_reuses_redeem_id(self):
        self.hub.credits[CODEX] = [{"id": "RateLimitResetCredit_1", "expires": T0 + 7200}]
        self.hub.consume_reply = resets.HubError("hub_timeout", True)
        self.run_until(T0 + 60)
        key = f"{CODEX}/RateLimitResetCredit_1"
        self.assertEqual(self.svc.manual_spend(key), "unknown")
        self.hub.consume_reply = (200, {"code": "already_redeemed"})
        self.hub.credits[CODEX] = []
        self.clock.t += 60
        self.assertEqual(self.svc.manual_spend(key), "already_redeemed")
        ids = [json.loads(c[5])["redeem_request_id"] for c in self.hub.consumes()]
        self.assertEqual(ids, ["req-0000", "req-0000"])
        self.assertEqual(self.gstate("RateLimitResetCredit_1", CODEX), "spent")

    def test_wrong_credit_stops_further_consumes(self):
        # An upstream that ignores the credit named and uses the first one listed.
        self.hub.honor_credit_id = False
        self.hub.credits[CODEX] = [{"id": "late", "expires": T0 + 86400},
                                   {"id": "soon", "expires": T0 + 3600}]
        self.run_until(T0 + 60)
        self.run_until(T0 + 3600 - 400)
        self.assertEqual(len(self.hub.consumes()), 1)
        self.assertEqual(self.gstate("soon", CODEX), "failed")
        self.assertEqual(self.gstate("late", CODEX), "spent")
        last = self.svc.state["grants"][f"{CODEX}/soon"]["last"]
        self.assertEqual(last["result"], "wrong_credit")

    def test_limit_policy_spends_once_on_stale_signals(self):
        self.hub.credits[CODEX] = [{"id": "c1", "expires": T0 + 86400},
                                   {"id": "c2", "expires": T0 + 86400}]
        self.run_until(T0 + 60)
        self.svc.set_default_policy("limit")
        self.hub.codex_used = 100
        self.hub.observed = self.clock.t + 1
        self.run_until(self.clock.t + 30)
        self.assertEqual(len(self.hub.consumes()), 1)
        self.run_until(self.clock.t + 1800)               # signals unchanged since the spend
        self.assertEqual(len(self.hub.consumes()), 1)
        self.hub.observed = self.clock.t                  # fresh traffic, still limited
        self.run_until(self.clock.t + 30)
        self.assertEqual(len(self.hub.consumes()), 2)

    def test_off_credit_blocks_consume(self):
        # A named consume is not relied on to protect a credit the user switched off.
        self.hub.credits[CODEX] = [{"id": "kept", "expires": T0 + 86400},
                                   {"id": "soon", "expires": T0 + 3600}]
        self.run_until(T0 + 60)
        self.svc.set_policy(f"{CODEX}/kept", "off")
        self.run_until(T0 + 3600 - 300)
        self.assertEqual(self.hub.consumes(), [])
        self.assertEqual(self.svc.state["grants"][f"{CODEX}/soon"]["last"]["result"],
                         "off_credit")
        self.assertEqual(self.svc.manual_spend(f"{CODEX}/soon"), "off_credit")
        self.assertEqual(self.hub.consumes(), [])

    def test_unknown_consume_holds_the_account(self):
        # The consume lands upstream but the reply is lost; the other credit must not
        # get its own request id against the same limit observation.
        self.hub.credits[CODEX] = [{"id": "c1", "expires": T0 + 86400},
                                   {"id": "c2", "expires": T0 + 86400}]
        self.run_until(T0 + 60)
        self.svc.set_default_policy("limit")
        real = self.hub.api_call

        def lossy(idx, method, url, header, data=None, timeout=20):
            if url == resets.CODEX_CONSUME_URL:
                self.hub.calls.append(("API", idx, method, url, dict(header), data))
                if self.hub.credits[idx]:
                    self.hub.credits[idx].pop(0)
                raise resets.HubError("hub_timeout", True)
            return real(idx, method, url, header, data, timeout)

        self.hub.api_call = lossy
        self.hub.codex_used = 100
        self.hub.observed = self.clock.t + 1
        self.run_until(self.clock.t + 900)
        ids = {json.loads(c[5])["redeem_request_id"] for c in self.hub.consumes()}
        self.assertEqual(ids, {"req-0000"})
        self.assertEqual(self.gstate("c2", CODEX), "pending")

    def test_spend_accounting_reaches_disk_before_cooldown_clear(self):
        expires = T0 + 7200
        self.hub.cedar[CLAUDE].update(at_limit=True, grants=[grant(expires=expires)])
        self.svc.tick()

        def crash(path, body):
            raise RuntimeError("process killed")

        self.hub.post = crash
        with self.assertRaises(RuntimeError):
            self.svc.manual_spend(f"{CLAUDE}/spring_2026")
        with open(os.path.join(self.dir, "state.json")) as fh:
            saved = json.load(fh)
        g = saved["grants"][f"{CLAUDE}/spring_2026"]
        self.assertEqual((g["left"], g["final"]), (0, "spent"))
        self.assertEqual(saved["accounts"][CLAUDE]["last_spend"], self.clock.t)
        # Restart against a lagging read that still lists the reset: no second claim.
        del self.hub.post
        self.svc = self.make()
        self.run_until(expires)
        self.assertEqual(len(self.hub.claims()), 1)


class FileTests(Base):
    def test_public_json_shape_and_no_secrets(self):
        self.hub.cedar[CLAUDE].update(at_limit=True, grants=[grant(expires=T0 + 3600)])
        self.hub.credits[CODEX] = [{"id": "c1", "expires": T0 + 86400}]
        self.svc.tick()
        self.svc.manual_spend(f"{CLAUDE}/spring_2026")
        path = os.path.join(self.dir, "public", "resets.json")
        with open(path) as fh:
            text = fh.read()
        for secret in (KEY, ORG, ORG.upper(), "req-0000", ACCOUNT_ID, "example.com", "$TOKEN$"):
            self.assertNotIn(secret, text)
        view = json.loads(text)
        self.assertEqual(set(view), {"version", "updated", "service", "accounts", "grants", "log"})
        self.assertEqual(set(view["service"]), {"started", "lead_seconds", "default_policy",
                                                "armed"})
        self.assertEqual({a["id"] for a in view["accounts"]}, {CLAUDE, CODEX})
        for a in view["accounts"]:
            self.assertEqual(set(a), {"id", "p", "checked", "next_check", "error", "eligible",
                                      "at_limit", "limited", "cooldown_until"})
        for g in view["grants"]:
            self.assertEqual(set(g), {"id", "account", "p", "label", "clears", "starts",
                                      "expires", "left", "total", "usable", "requires_limit",
                                      "policy", "policy_set", "next_action", "state", "blocker",
                                      "last"})
        # The HTTP status is the only thing added about the upstream reply.
        self.assertEqual(set(view["log"][0]), {"t", "grant", "account", "p", "trigger", "result",
                                               "detail", "http"})
        self.assertEqual(stat.S_IMODE(os.stat(path).st_mode), 0o644)
        state = os.path.join(self.dir, "state.json")
        self.assertEqual(stat.S_IMODE(os.stat(state).st_mode), 0o600)
        with open(state) as fh:
            self.assertIn(ORG, fh.read())                 # org cache stays private
        with open(os.path.join(self.dir, "resets.log")) as fh:
            log_text = fh.read()
        self.assertNotIn(ORG, log_text)
        self.assertNotIn("req-0000", log_text)

    def test_atomic_write_keeps_old_file_on_failure(self):
        path = os.path.join(self.dir, "x.json")
        resets.atomic_write(path, "old", 0o600)
        real = os.replace
        os.replace = lambda *a: (_ for _ in ()).throw(OSError("boom"))
        try:
            with self.assertRaises(OSError):
                resets.atomic_write(path, "new", 0o600)
        finally:
            os.replace = real
        with open(path) as fh:
            self.assertEqual(fh.read(), "old")
        self.assertEqual(os.listdir(self.dir).count("x.json"), 1)
        self.assertFalse([n for n in os.listdir(self.dir) if n.startswith(".x.json")])


class HttpTests(Base):
    def setUp(self):
        super().setUp()
        self.hub.cedar[CLAUDE]["grants"] = [grant()]
        self.svc.tick()
        self.server = resets.make_server(self.svc, "127.0.0.1", 0)
        self.port = self.server.server_address[1]
        threading.Thread(target=self.server.serve_forever, daemon=True).start()

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()
        super().tearDown()

    def call(self, method, path, body=None, headers=None):
        data = None if body is None else json.dumps(body).encode()
        req = urllib.request.Request(f"http://127.0.0.1:{self.port}{path}", data=data,
                                     method=method, headers=headers or {})
        try:
            with urllib.request.urlopen(req, timeout=10) as resp:
                return resp.status, json.load(resp)
        except urllib.error.HTTPError as err:
            with err:
                return err.code, json.load(err)

    def auth(self):
        return {"Authorization": "Bearer " + KEY, "Content-Type": "application/json"}

    def test_auth_required(self):
        self.assertEqual(self.call("GET", "/state")[0], 401)
        self.assertEqual(self.call("GET", "/state", headers={"Authorization": "Bearer nope"})[0],
                         401)
        self.assertEqual(self.call("POST", "/policy", {"default_policy": "off"},
                                   {"Authorization": "Bearer " + KEY[:-1]})[0], 401)
        self.assertEqual(self.svc.state["default_policy"], "expiry")
        status, view = self.call("GET", "/quota-resets/state", headers=self.auth())
        self.assertEqual((status, view["version"]), (200, 1))
        status, _ = self.call("GET", "/state", headers={"X-Quota-Resets-Key": KEY})
        self.assertEqual(status, 200)

    def test_policy_spend_refresh(self):
        status, view = self.call("POST", "/policy", {"grant": "spring_2026", "policy": "limit"},
                                 self.auth())
        g = view["grants"][0]
        self.assertEqual((status, g["policy"], g["policy_set"]), (200, "limit", True))
        status, view = self.call("POST", "/quota-resets/policy",
                                 {"grant": "spring_2026", "policy": "default"}, self.auth())
        self.assertEqual((view["grants"][0]["policy"], view["grants"][0]["policy_set"]),
                         ("expiry", False))
        status, view = self.call("POST", "/policy", {"default_policy": "off"}, self.auth())
        self.assertEqual(view["service"]["default_policy"], "off")
        self.assertEqual(self.call("POST", "/policy", {"grant": "nope", "policy": "off"},
                                   self.auth())[0], 404)
        self.assertEqual(self.call("POST", "/policy", {"grant": "spring_2026", "policy": "x"},
                                   self.auth())[0], 400)
        status, body = self.call("POST", "/spend", {"grant": "spring_2026"}, self.auth())
        self.assertEqual((status, body["result"]), (200, "not_limited"))
        self.assertEqual(self.hub.claims(), [])
        status, _ = self.call("POST", "/refresh", {}, self.auth())
        self.assertEqual(status, 200)
        status, body = self.call("POST", "/refresh", {}, self.auth())
        self.assertEqual(status, 429)
        self.assertGreater(body["retry_after"], 0)


class ClassifyTests(unittest.TestCase):
    """Only a reply that leaves the outcome open may be called unknown."""

    def test_claim_replies(self):
        cases = [
            ((200, {"result": "reset"}), ("reset", None)),
            ((200, {"result": "unavailable", "reason": "not_next_grant"}),
             ("unavailable", "not_next_grant")),
            ((200, {"result": "not_limited", "reason": "Free text is dropped"}),
             ("not_limited", None)),
            ((200, {"result": "brand_new_result"}), ("unknown", "brand_new_result")),
            ((200, "<html>"), ("unknown", None)),
            ((429, {}), ("rate_limited", None)),
            ((401, {}), ("auth_error", None)),
            ((403, {}), ("auth_error", None)),
            ((400, {"result": "reset"}), ("refused", None)),   # a 4xx never spent anything
            ((404, None), ("refused", None)),
            ((409, {}), ("unknown", None)),                    # may still be in progress
            ((502, "bad gateway"), ("unknown", None)),
            ((302, {}), ("unknown", None)),
        ]
        for (status, body), expected in cases:
            self.assertEqual(resets.classify_claim(status, body), expected, (status, body))

    def test_consume_replies(self):
        cases = [
            ((200, {"code": "reset"}), ("reset", None)),
            ((200, {"code": "already_redeemed"}), ("already_redeemed", None)),
            # Definite answers that used to be filed under "unknown".
            ((200, {"code": "nothing_to_reset"}), ("nothing_to_reset", None)),
            ((200, {"code": "no_credit"}), ("no_credit", None)),
            ((409, {"code": "nothing_to_reset"}), ("unknown", "nothing_to_reset")),
            ((422, {"code": "no_credit"}), ("no_credit", None)),
            ((200, {"code": "something_new"}), ("unknown", "something_new")),
            ((200, {}), ("unknown", None)),
            ((400, {"code": "invalid_request"}), ("refused", "invalid_request")),
            ((400, {"detail": "Unknown field credit_id"}), ("refused", None)),
            ((429, {"code": "reset"}), ("rate_limited", None)),
            ((403, {}), ("auth_error", None)),
            ((500, {"code": "reset"}), ("unknown", "reset")),
        ]
        for (status, body), expected in cases:
            self.assertEqual(resets.classify_consume(status, body), expected, (status, body))

    def test_describe_names_the_status_and_code(self):
        self.assertEqual(resets.describe("reset"), "reset spent")
        self.assertEqual(resets.describe("reset", 200), "reset spent")
        self.assertEqual(resets.describe("unknown", 502),
                         "no definite answer; retrying with the same request id (HTTP 502)")
        self.assertEqual(resets.describe("refused", 400, "invalid_request"),
                         "upstream refused the request; nothing spent (HTTP 400, invalid_request)")
        self.assertEqual(resets.describe("unavailable", 200, "not_next_grant"),
                         "reset unavailable (not_next_grant)")
        self.assertEqual(resets.describe("nothing_to_reset", 200),
                         "nothing to reset at this usage; credit kept")

    def test_lead_default_and_override(self):
        self.assertEqual(resets.LEAD_SECONDS, 3600)
        env = dict(os.environ)
        try:
            for raw, expected in (("7200", 7200), ("5", 60), ("999999", 86400), ("soon", 3600)):
                os.environ["QUOTA_RESETS_LEAD_TEST"] = raw
                self.assertEqual(
                    resets._env_seconds("QUOTA_RESETS_LEAD_TEST", 3600, 60, 86400), expected)
            del os.environ["QUOTA_RESETS_LEAD_TEST"]
            self.assertEqual(resets._env_seconds("QUOTA_RESETS_LEAD_TEST", 3600, 60, 86400), 3600)
        finally:
            os.environ.clear()
            os.environ.update(env)


class WindowTests(Base):
    """The default lead: an hour of room, paced attempts, a minute apart at the end."""
    LEAD = None

    def attempts(self):
        return sorted(e["t"] for e in self.svc.state["log"] if e["result"] != "expired")

    def test_spends_an_hour_before_expiry(self):
        expires = T0 + 4 * 3600
        self.hub.cedar[CLAUDE]["grants"] = [grant(expires=expires, use_requires_limit=False)]
        self.svc.tick()
        key = f"{CLAUDE}/spring_2026"
        self.assertEqual(self.svc.next_action(key, self.clock.t), expires - 3600)
        self.assertEqual(self.public()["service"]["lead_seconds"], 3600)
        self.run_until(expires - 3601)
        self.assertEqual(self.hub.claims(), [])
        self.run_until(expires - 3600)
        self.assertEqual(len(self.hub.claims()), 1)
        self.assertEqual(self.gstate("spring_2026"), "spent")
        self.run_until(expires + 60)
        self.assertEqual(len(self.hub.claims()), 1)

    def test_refusals_are_retried_every_ten_minutes_then_every_minute(self):
        expires = T0 + 4 * 3600
        self.hub.cedar[CLAUDE]["grants"] = [grant(expires=expires)]     # needs the limit
        self.svc.tick()
        self.run_until(expires + 30)
        times = [t - expires for t in self.attempts()]
        self.assertEqual(times[:6], [-3600, -3000, -2400, -1800, -1200, -600])
        self.assertEqual(times[6:], list(range(-540, 0, 60)))
        self.assertEqual(self.hub.claims(), [])              # preflight says not limited
        self.assertEqual(self.gstate("spring_2026"), "expired")

    def test_a_refusal_that_clears_is_spent_at_the_next_attempt(self):
        expires = T0 + 4 * 3600
        self.hub.cedar[CLAUDE]["grants"] = [grant(expires=expires)]
        self.svc.tick()
        self.run_until(expires - 3600)
        self.assertEqual(self.svc.state["grants"][f"{CLAUDE}/spring_2026"]["last"]["result"],
                         "not_limited")
        self.hub.cedar[CLAUDE]["at_limit"] = True            # 25 minutes in, the account fills up
        self.run_until(expires - 2400)
        self.assertEqual(len(self.hub.claims()), 1)
        self.assertEqual(self.gstate("spring_2026"), "spent")

    def test_an_attempt_that_sent_nothing_is_retried_within_a_minute(self):
        expires = T0 + 4 * 3600
        self.hub.cedar[CLAUDE].update(at_limit=True, grants=[grant(expires=expires)])
        self.svc.tick()
        self.svc.state["orgs"].clear()                       # as if never learned
        self.hub.profile_code = 500
        self.run_until(expires - 3600)
        last = self.svc.state["grants"][f"{CLAUDE}/spring_2026"]["last"]
        self.assertEqual(last["result"], "preflight_failed")
        self.hub.profile_code = 200
        self.run_until(expires - 3600 + 60)
        self.assertEqual(len(self.hub.claims()), 1)


class DiagnosisTests(Base):
    """What the scheduler could not tell apart before: refusals, failures, lost replies."""

    def setUp(self):
        super().setUp()
        self.hub.credits[CODEX] = [{"id": "c1", "expires": T0 + 86400},
                                   {"id": "c2", "expires": T0 + 2 * 86400}]
        self.run_until(T0 + 60)
        self.key = f"{CODEX}/c1"

    def last(self, key=None):
        return self.svc.state["grants"][key or self.key]["last"]

    def test_nothing_to_reset_is_a_refusal_not_an_unknown(self):
        # The 7 November case: usage too low for a reset to do anything.
        self.hub.consume_reply = (200, {"code": "nothing_to_reset"})
        self.assertEqual(self.svc.manual_spend(self.key), "nothing_to_reset")
        last = self.last()
        self.assertEqual((last["result"], last["http"]), ("nothing_to_reset", 200))
        self.assertEqual(last["detail"], "nothing to reset at this usage; credit kept")
        # The credit is still there and nothing is left hanging.
        self.assertEqual(self.gstate("c1", CODEX), "pending")
        self.assertEqual(self.svc.state["journal"][self.key]["outcome"], "nothing_to_reset")
        self.assertNotIn("last_spend", self.svc.state["accounts"][CODEX])
        # So the other credit on the account is not held back...
        self.hub.consume_reply = (200, {"code": "reset"})
        self.assertEqual(self.svc.manual_spend(f"{CODEX}/c2"), "reset")
        # ...and a later attempt at this one goes out under a new request id.
        self.clock.t += resets.RETRY_WINDOW + 1
        self.assertEqual(self.svc.manual_spend(self.key), "reset")
        ids = [json.loads(c[5])["redeem_request_id"] for c in self.hub.consumes()]
        self.assertEqual(len(set(ids)), 3)

    def test_expiry_window_keeps_trying_until_there_is_something_to_reset(self):
        self.hub.consume_reply = (200, {"code": "nothing_to_reset"})
        expires = T0 + 86400
        self.run_until(expires - 300)
        results = [e["result"] for e in self.svc.state["log"]]
        self.assertEqual(set(results), {"nothing_to_reset"})
        self.assertGreaterEqual(len(results), 5)
        self.assertEqual(self.gstate("c1", CODEX), "pending")
        self.hub.consume_reply = (200, {"code": "reset"})       # usage has built up
        self.run_until(expires - 240)
        self.assertEqual(self.gstate("c1", CODEX), "spent")
        self.assertEqual(self.last()["result"], "reset")

    def test_no_credit_is_recorded_as_such(self):
        self.hub.consume_reply = (200, {"code": "no_credit"})
        self.assertEqual(self.svc.manual_spend(self.key), "no_credit")
        self.assertEqual(self.last()["detail"], "no reset credit available")
        self.assertEqual(self.gstate("c1", CODEX), "pending")

    def test_a_lost_reply_is_unknown_and_says_which_status(self):
        self.hub.consume_reply = (502, "bad gateway")
        self.assertEqual(self.svc.manual_spend(self.key), "unknown")
        last = self.last()
        self.assertEqual(last["http"], 502)
        self.assertIn("HTTP 502", last["detail"])
        self.assertEqual(self.gstate("c1", CODEX), "unknown")
        log = self.public()["log"][0]
        self.assertEqual((log["result"], log["http"]), ("unknown", 502))

    def test_a_request_upstream_rejects_falls_back_to_the_unnamed_form(self):
        self.hub.consume_reply = (400, {"code": "invalid_request", "message": "secret text"})
        self.assertEqual(self.svc.manual_spend(self.key), "refused")
        last = self.last()
        self.assertEqual((last["http"], last["upstream"]), (400, "invalid_request"))
        self.assertIn("next attempt lets Codex pick the credit", last["detail"])
        self.assertNotIn("secret text", json.dumps(self.public()))
        self.assertEqual(self.gstate("c1", CODEX), "pending")
        self.hub.consume_reply = (200, {"code": "reset"})
        self.assertEqual(self.svc.manual_spend(self.key), "reset")
        bodies = [json.loads(c[5]) for c in self.hub.consumes()]
        self.assertEqual(bodies[0]["credit_id"], "c1")
        self.assertNotIn("credit_id", bodies[1])

    def test_a_retry_repeats_the_same_request(self):
        self.hub.consume_reply = resets.HubError("hub_timeout", True)
        self.assertEqual(self.svc.manual_spend(self.key), "unknown")
        self.clock.t += 60
        self.assertEqual(self.svc.manual_spend(self.key), "unknown")
        bodies = [json.loads(c[5]) for c in self.hub.consumes()]
        self.assertEqual(bodies[0], bodies[1])
        self.assertEqual(bodies[0], {"redeem_request_id": "req-0000", "credit_id": "c1"})

    def test_stand_in_ids_are_never_sent_as_a_credit_id(self):
        parsed = resets.parse_codex_credits({"credits": [
            {"id": "real_1", "reset_type": "codex_rate_limits", "status": "available",
             "expires_at": iso(T0 + 10)},
            {"reset_type": "codex_rate_limits", "status": "available", "expires_at": iso(T0 + 20)},
            {"id": "real_1", "reset_type": "codex_rate_limits", "status": "available",
             "expires_at": iso(T0 + 30)},
        ]})
        self.assertEqual([c["pin"] for c in parsed["credits"]], [True, False, False])

    def test_claude_reply_keeps_its_reason_and_status(self):
        self.hub.cedar[CLAUDE].update(at_limit=True, grants=[grant(expires=T0 + 86400)])
        self.svc.read_account(CLAUDE, self.clock.t)
        key = f"{CLAUDE}/spring_2026"
        self.hub.claim_reply = (200, {"result": "unavailable", "reason": "not_next_grant"})
        self.assertEqual(self.svc.manual_spend(key), "unavailable")
        last = self.last(key)
        self.assertEqual((last["http"], last["upstream"]), (200, "not_next_grant"))
        self.assertEqual(last["detail"], "reset unavailable (not_next_grant)")
        self.hub.claim_reply = (400, {"error": {"message": "bad"}})
        self.clock.t += 61
        self.assertEqual(self.svc.manual_spend(key), "refused")
        self.assertEqual(self.last(key)["http"], 400)
        self.assertEqual(self.gstate("spring_2026"), "pending")   # refused, not left hanging


class PreflightTests(Base):
    """A spend must not hinge on a status read that happens to fail at that moment."""

    def setUp(self):
        super().setUp()
        self.expires = T0 + 6 * 3600
        self.hub.cedar[CLAUDE].update(
            at_limit=True, grants=[grant(expires=self.expires, use_requires_limit=False)])
        self.svc.tick()
        self.key = f"{CLAUDE}/spring_2026"

    def test_the_organization_is_learned_long_before_a_claim(self):
        self.assertEqual(self.svc.state["orgs"], {CLAUDE: ORG})
        self.assertEqual(len(self.hub.profiles()), 1)
        self.run_until(T0 + 600)
        self.assertEqual(len(self.hub.profiles()), 1)        # once is enough
        self.assertIsNone(self.public()["grants"][0]["blocker"])
        # So a profile endpoint that is down at claim time does not matter.
        self.hub.profile_code = 500
        self.run_until(self.expires - 600)
        self.assertEqual(len(self.hub.claims()), 1)
        self.assertEqual(self.gstate("spring_2026"), "spent")

    def test_a_failed_organization_lookup_is_retried_at_a_slow_pace(self):
        self.svc.state["orgs"].clear()
        self.hub.profile_code = 500
        before = len(self.hub.profiles())
        self.run_until(T0 + resets.ORG_RETRY - 30)
        self.assertEqual(len(self.hub.profiles()), before + 1)
        self.assertEqual(self.public()["grants"][0]["blocker"], "no_org")
        self.hub.profile_code = 200
        self.run_until(T0 + resets.ORG_RETRY + 60)
        self.assertEqual(self.svc.state["orgs"], {CLAUDE: ORG})
        self.assertIsNone(self.public()["grants"][0]["blocker"])

    def test_claim_goes_out_on_the_last_reading_when_the_read_is_rate_limited(self):
        self.run_until(self.expires - 3600)                  # hourly reads keep it fresh
        self.hub.status_code[CLAUDE] = 429
        self.run_until(self.expires - 600)
        self.assertEqual(len(self.hub.claims()), 1)
        last = self.svc.state["grants"][self.key]["last"]
        self.assertEqual(last["result"], "reset")
        self.assertIn("status read failed (rate_limited), last reading used", last["detail"])
        self.assertEqual(self.gstate("spring_2026"), "spent")

    def test_a_reading_that_is_too_old_is_not_trusted(self):
        self.hub.status_code[CLAUDE] = 429
        self.clock.t = self.expires - 600 - 30
        self.svc.state["accounts"][CLAUDE]["ok_at"] = self.clock.t - resets.STATUS_MAX_AGE - 60
        self.run_until(self.expires - 600)
        self.assertEqual(self.hub.claims(), [])
        last = self.svc.state["grants"][self.key]["last"]
        self.assertEqual(last["result"], "preflight_failed")
        self.assertEqual(self.public()["grants"][0]["blocker"], "stale")

    def test_the_last_reading_still_refuses_what_upstream_would(self):
        self.hub.cedar[CLAUDE]["grants"] = [grant(expires=self.expires, usable_now=False)]
        self.clock.t += 3600 + resets.READ_STAGGER + 1
        self.svc.tick()                                       # read: no longer usable
        self.assertEqual(self.public()["grants"][0]["blocker"], "not_usable")
        self.hub.status_code[CLAUDE] = 429
        self.assertEqual(self.svc.manual_spend(self.key), "not_usable")
        self.assertEqual(self.hub.claims(), [])

    def test_hub_traffic_can_show_the_limit_the_last_reading_missed(self):
        self.hub.cedar[CLAUDE].update(at_limit=False, grants=[grant(expires=self.expires)])
        self.clock.t += 3600 + resets.READ_STAGGER + 1
        self.svc.tick()                                       # needs the limit; not there yet
        self.hub.status_code[CLAUDE] = 429
        self.assertEqual(self.svc.manual_spend(self.key), "not_limited")
        self.hub.claude_limited = True                       # headers through the hub say limited
        self.hub.observed = self.clock.t
        self.clock.t += 61
        self.assertEqual(self.svc.manual_spend(self.key), "reset")

    def test_codex_named_credit_goes_out_on_the_last_reading(self):
        self.hub.credits[CODEX] = [{"id": "c1", "expires": self.expires}]
        self.clock.t += 3600 + resets.READ_STAGGER + 1
        self.svc.tick()
        self.hub.status_code[CODEX] = 429
        self.assertEqual(self.svc.manual_spend(f"{CODEX}/c1"), "reset")
        last = self.svc.state["grants"][f"{CODEX}/c1"]["last"]
        self.assertIn("credit read failed (rate_limited), last reading used", last["detail"])
        # Without upstream's own id the consume could take any credit: no reading, no spend.
        self.svc.state["grants"][f"{CODEX}/c1"].update(final=None, pin=False, left=1)
        self.clock.t += resets.RETRY_WINDOW + 1
        self.assertEqual(self.svc.manual_spend(f"{CODEX}/c1"), "preflight_failed")
        self.assertEqual(len(self.hub.consumes()), 1)

    def test_a_lost_claim_gets_a_new_id_without_a_read_only_when_it_cannot_spend_twice(self):
        self.hub.claim_reply = (502, "bad gateway")
        self.assertEqual(self.svc.manual_spend(self.key), "unknown")
        self.hub.status_code[CLAUDE] = 429                    # and now reads fail too
        self.clock.t += resets.RETRY_WINDOW + 1
        self.hub.claim_reply = (200, {"result": "already_used"})
        self.assertEqual(self.svc.manual_spend(self.key), "already_used")
        rids = [json.loads(c[5])["request_id"] for c in self.hub.claims()]
        self.assertEqual(rids, ["req-0000", "req-0001"])
        self.assertEqual(self.gstate("spring_2026"), "spent")

    def test_a_lost_claim_on_a_multi_reset_grant_still_waits_for_a_read(self):
        self.hub.cedar[CLAUDE]["grants"] = [grant(expires=self.expires, left=2, total=2,
                                                  use_requires_limit=False)]
        self.clock.t += 3600 + resets.READ_STAGGER + 1
        self.svc.tick()
        self.hub.claim_reply = (502, "bad gateway")
        self.assertEqual(self.svc.manual_spend(self.key), "unknown")
        self.hub.status_code[CLAUDE] = 429
        self.clock.t += resets.RETRY_WINDOW + 1
        self.hub.claim_reply = (200, {"result": "reset"})
        # A new id here could spend the second reset while the first one also landed.
        self.assertEqual(self.svc.manual_spend(self.key), "unknown")
        self.assertEqual(len(self.hub.claims()), 1)


class DisarmedTests(Base):
    """QUOTA_RESETS_DRY_RUN and --check: every step runs, and no spend is ever sent."""
    ARMED = False

    def test_nothing_is_ever_sent(self):
        expires = T0 + 2 * 3600
        self.hub.cedar[CLAUDE].update(at_limit=True, grants=[grant(expires=expires)])
        self.hub.credits[CODEX] = [{"id": "c1", "expires": expires}]
        self.run_until(T0 + 60)                               # both accounts read
        self.assertFalse(self.public()["service"]["armed"])
        self.assertEqual(self.svc.manual_spend(f"{CLAUDE}/spring_2026"), "dry_run")
        self.assertEqual(self.svc.would_send, {
            "method": "POST",
            "url": "https://api.anthropic.com/api/organizations/<organization>/reset_rate_limits",
            "fields": ["grant_id", "program", "request_id"]})
        self.assertEqual(self.svc.manual_spend(f"{CODEX}/c1"), "dry_run")
        self.assertEqual(self.svc.would_send["fields"], ["credit_id", "redeem_request_id"])
        self.run_until(expires + 60)                          # the whole window, and past it
        self.assertEqual(self.hub.claims(), [])
        self.assertEqual(self.hub.consumes(), [])
        self.assertFalse([c for c in self.hub.calls if c[0] == "POST"])   # no cooldown clears
        results = {e["result"] for e in self.svc.state["log"]}
        self.assertEqual(results, {"dry_run", "expired"})
        self.assertEqual(self.gstate("spring_2026"), "expired")

    def test_rehearsal_reports_readiness_and_reads_each_account_once(self):
        import io
        expires = T0 + 5 * 86400
        self.hub.cedar[CLAUDE].update(grants=[
            grant(gid="full", expires=expires, use_requires_limit=False),
            grant(gid="fable", expires=expires + 86400, use_requires_limit=False,
                  clears=["seven_day_overage_included"]),
            grant(gid="held", expires=expires, usable_now=False, use_requires_limit=False)])
        self.hub.credits[CODEX] = [{"id": "c1", "expires": expires}]
        self.run_until(T0 + 60)                               # both accounts read
        self.clock.t += resets.CHECK_REUSE + 1                # readings no longer recent
        reads = len(self.hub.api("skip_spend=1"))
        out = io.StringIO()
        failed = resets.rehearse(self.svc, out)
        report = out.getvalue()
        self.assertEqual(failed, 1)
        self.assertEqual(len(self.hub.api("skip_spend=1")), reads + 1)   # three grants, one read
        self.assertEqual(len(self.hub.api("rate-limit-reset-credits")), 2)   # then and now
        self.assertEqual(report.count("READY from"), 3)
        self.assertIn("NOT READY: not_usable: grant not usable now", report)
        self.assertIn("3 of 4 pending resets reach the spend request; nothing was sent", report)
        self.assertIn("would send POST https://api.anthropic.com/api/organizations/"
                      "<organization>/reset_rate_limits with grant_id, program, request_id",
                      report)
        self.assertIn("with credit_id, redeem_request_id", report)
        self.assertNotIn(ORG, report)
        self.assertEqual(self.hub.claims() + self.hub.consumes(), [])

    def test_rehearsal_uses_the_last_reading_for_an_account_in_backoff(self):
        import io
        self.hub.cedar[CLAUDE].update(grants=[grant(expires=T0 + 5 * 86400,
                                                    use_requires_limit=False)])
        self.svc.tick()
        self.hub.status_code[CLAUDE] = 429
        self.clock.t += 3600 + resets.READ_STAGGER + 1
        self.svc.tick()                                       # the read fails: backoff starts
        reads = len(self.hub.api("skip_spend=1"))
        out = io.StringIO()
        self.assertEqual(resets.rehearse(self.svc, out), 0)
        self.assertEqual(len(self.hub.api("skip_spend=1")), reads)       # left alone
        self.assertIn("READY from", out.getvalue())
        self.assertIn("last reading (read failed: rate_limited)", out.getvalue())

    def test_rehearsal_refuses_an_armed_service(self):
        self.svc.armed = True
        with self.assertRaises(ValueError):
            resets.rehearse(self.svc)


if __name__ == "__main__":
    unittest.main()

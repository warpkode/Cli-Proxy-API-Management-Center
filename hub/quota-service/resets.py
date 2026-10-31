#!/usr/bin/env python3
"""Spend Claude reset grants and Codex rate-limit reset credits before they expire.

Long-running service for the CLIProxyAPI hub on this host (systemd user unit
quota-resets.service). Every upstream call goes through the hub's
/v8/management/requests/api-call, so this process never sees OAuth tokens.

- Scheduler (~30 s tick): reads each account's grants/credits about hourly
  (staggered), again ~20 min before a planned action, and as a preflight
  right before every spend. Per-grant policy: `expiry` (spend LEAD seconds
  before it expires), `limit` (spend once the account is limited), `off`.
- Every spend is journalled to the private state file before it is sent, so a
  restart retries an unknown outcome with the same request id (idempotent
  upstream within 10 minutes) instead of minting a second spend.
- Public view: ~/quota-history/public/resets.json (no org ids, request ids,
  tokens or emails). Private state: ~/quota-history/resets-state.json (0600).
- HTTP API on 127.0.0.1:8319 (management key required): GET /state,
  POST /policy, POST /spend, POST /refresh; optional /quota-resets prefix.

`resets.py --plan` prints the planned actions without spending anything.
Standard library only.
"""
import argparse
import base64
import hashlib
import hmac
import json
import os
import re
import sys
import tempfile
import threading
import time
import urllib.error
import urllib.request
import uuid
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

HUB = os.environ.get("QUOTA_RESETS_HUB", "http://127.0.0.1:8317")
KEY_FILE = os.path.expanduser("~/.config/cliproxyapi/management-key")
DATA_DIR = os.path.expanduser(os.environ.get("QUOTA_RESETS_DIR", "~/quota-history"))
STATE_FILE = os.path.join(DATA_DIR, "resets-state.json")
LOG_FILE = os.path.join(DATA_DIR, "resets.log")
PUBLIC_FILE = os.path.join(DATA_DIR, "public", "resets.json")
LISTEN_HOST, LISTEN_PORT = "127.0.0.1", 8319

LEAD_SECONDS = 600            # expiry policy spends at expires - LEAD
TICK_SECONDS = 30
READ_INTERVAL = 3600          # routine read per account
READ_STAGGER = 300            # spread of routine reads across accounts
READ_RETRY = 900              # next read after a non-429 read failure
PRE_ACTION_READ = 1200        # extra read this long before a planned action
BACKOFF_SECONDS = 7200        # after an upstream 429
BACKOFF_PREFLIGHT_GAP = 300   # preflight reads during a backoff, at most this often
RETRY_WINDOW = 600            # same request id is idempotent upstream for this long
RETRY_GAP = 60                # retry spacing for an unknown outcome
EXPIRY_ATTEMPT_GAP = 60       # attempt spacing inside the expiry window
LIMIT_ATTEMPT_GAP = 600       # at most one limit-triggered attempt per grant per 10 min
REFRESH_GAP = 120
KEEP_DONE = 7 * 86400         # spent/expired grants stay visible this long
PUBLIC_LOG = 50
STATE_LOG = 200
LOG_ROTATE_BYTES = 1_000_000
HUB_AUTH_PAUSE = 1800         # stop calling the hub after repeated 401s (IP ban guard)
POLICIES = ("expiry", "limit", "off")
TRIGGERS = ("expiry", "limit", "manual")

# Mirrors src/utils/quota/constants.ts and src/services/api/claudeResetGrants.ts.
CLAUDE_HEADERS = {
    "User-Agent": "claude-cli/2.1.280 (external, cli)",
    "Authorization": "Bearer $TOKEN$",
    "Content-Type": "application/json",
    "anthropic-beta": "oauth-2025-04-20",
}
CODEX_HEADERS = {
    "Authorization": "Bearer $TOKEN$",
    "Content-Type": "application/json",
    "User-Agent": "codex-tui/0.149.1 (Mac OS 26.5.2; arm64) iTerm.app/3.6.11 (codex-tui; 0.149.1)",
}
CODEX_READ_HEADERS = {"Accept": "application/json", "OpenAI-Beta": "codex-1",
                      "Originator": "Codex Desktop"}
ANTHROPIC = "https://api.anthropic.com"
CLAUDE_STATUS_URL = ANTHROPIC + "/api/oauth/usage?cedar_ember=1&skip_spend=1"
CLAUDE_PROFILE_URL = ANTHROPIC + "/api/oauth/profile"
CLAUDE_PROGRAM = "cedar_ember"
CLAUDE_READ_TIMEOUT = 12
CLAUDE_CLAIM_TIMEOUT = 25
CODEX_CREDITS_URL = "https://chatgpt.com/backend-api/wham/rate-limit-reset-credits"
CODEX_CONSUME_URL = "https://chatgpt.com/backend-api/wham/rate-limit-reset-credits/consume"
CODEX_TIMEOUT = 20

GRANT_ID_RE = re.compile(r"[a-z0-9_-]{1,40}")
REQUEST_ID_RE = re.compile(r"[A-Za-z0-9_-]{1,64}")
ORG_RE = re.compile(r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}", re.I)
CODEX_ID_RE = re.compile(r"[A-Za-z0-9_.:-]{1,80}")
RESET_WINDOWS = ("five_hour", "seven_day", "seven_day_overage_included")
CLAUDE_RESULTS = ("reset", "already_used", "not_limited", "cooldown", "ineligible", "unavailable")
CODEX_SUCCESS = ("reset", "already_redeemed")
SPENT_CODES = ("reset", "already_used", "already_redeemed")
KNOWN_INELIGIBLE = {"config_off", "tier", "seat", "mobile", "surface", "cli_version", "no_grant",
                    "tenure", "other_experiment", "unavailable", "unknown"}

# Fixed public texts; upstream messages are never republished.
DETAILS = {
    "reset": "reset spent",
    "already_used": "reset already applied",
    "already_redeemed": "credit already redeemed",
    "not_limited": "account not at its limit",
    "cooldown": "account in reset cooldown",
    "ineligible": "account not eligible",
    "unavailable": "reset unavailable",
    "rate_limited": "upstream rate limited",
    "auth_error": "upstream rejected credentials",
    "unknown": "no definite answer; retrying with the same request id",
    "hub_unavailable": "hub unavailable; nothing sent",
    "preflight_failed": "preflight read failed; nothing sent",
    "paused": "grant paused",
    "not_usable": "grant not usable now",
    "exhausted": "no resets left",
    "unknown_grant": "grant no longer offered",
    "account_busy": "another spend on this account is still settling; nothing sent",
    "off_credit": "another credit on this account is set to off and upstream picks the credit; "
                  "nothing sent",
    "not_started": "grant not started",
    "grant_expired": "grant expired",
    "not_pending": "grant already settled",
    "no_credit": "no reset credit available",
    "expired": "expired unspent",
    "wrong_credit": "upstream used a different credit",
    "busy": "another action is running",
}


# ---------------------------------------------------------------------------
# Parsing (pure functions)

def epoch(value):
    """ISO-8601 string or number → epoch seconds; None for empty/invalid/zero dates."""
    if value is None or value == "" or isinstance(value, bool):
        return None
    if isinstance(value, (int, float)):
        return int(value) if value > 0 else None
    text = str(value).strip()
    if re.fullmatch(r"\d+(\.\d+)?", text):
        n = int(float(text))
        return n if n > 0 else None
    try:
        dt = datetime.fromisoformat(text.replace("Z", "+00:00"))
    except ValueError:
        return None
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    n = int(dt.timestamp())
    return n if n > 0 else None


def num(value):
    if isinstance(value, bool):
        return None
    try:
        n = float(value)
    except (TypeError, ValueError):
        return None
    return n if n == n else None


def safe_label(value):
    if not isinstance(value, str):
        return ""
    text = re.sub(r"[\x00-\x1f\x7f-\x9f]", " ", value)
    return re.sub(r"\s+", " ", text).strip()[:120]


def _opt_ts(value):
    """Optional ISO timestamp: (ok, epoch|None). Unparsable rejects the block."""
    if value is None:
        return True, None
    if not isinstance(value, str):
        return False, None
    t = epoch(value)
    if t is None:
        try:
            datetime.fromisoformat(value.replace("Z", "+00:00"))
        except ValueError:
            return False, None
    return True, t


def _opt_bool(value, fallback):
    if value is None:
        return True, fallback
    return (True, value) if isinstance(value, bool) else (False, None)


def _is_count(value):
    return isinstance(value, int) and not isinstance(value, bool) and value >= 0


def parse_claude_grant(value):
    if not isinstance(value, dict):
        return None
    gid, total, left = value.get("id"), value.get("resets_total"), value.get("resets_left")
    if not isinstance(gid, str) or not GRANT_ID_RE.fullmatch(gid):
        return None
    if not _is_count(total) or not _is_count(left) or left > total:
        return None
    ok_s, starts = _opt_ts(value.get("starts_at"))
    ok_e, ends = _opt_ts(value.get("ends_at"))
    clears = value.get("clears")
    if clears is None:
        clears = []
    elif isinstance(clears, list):
        clears = [w for w in RESET_WINDOWS if w in clears]
    else:
        return None
    ok_p, paused = _opt_bool(value.get("paused"), False)
    # Missing usability flags default to the refusing side.
    ok_u, usable = _opt_bool(value.get("usable_now"), False)
    ok_r, requires = _opt_bool(value.get("use_requires_limit"), True)
    if not (ok_s and ok_e and ok_p and ok_u and ok_r):
        return None
    return {"id": gid, "label": safe_label(value.get("label")), "total": total, "left": left,
            "starts": starts, "expires": ends, "clears": clears, "paused": paused,
            "usable": usable, "requires_limit": requires}


def parse_claude_status(block):
    """The cedar_ember block, or None when missing or malformed (all-or-nothing)."""
    if not isinstance(block, dict) or not isinstance(block.get("eligible"), bool):
        return None
    raw = block.get("grants")
    raw = [] if raw is None else raw
    if not isinstance(raw, list):
        return None
    grants, seen = [], set()
    for item in raw:
        g = parse_claude_grant(item)
        if not g or g["id"] in seen:
            return None
        seen.add(g["id"])
        grants.append(g)
    reason = block.get("ineligible_reason")
    if reason is not None and not isinstance(reason, str):
        return None
    ok_a, at_limit = _opt_bool(block.get("at_limit"), False)
    ok_w, weekly = _opt_ts(block.get("weekly_resets_at"))
    ok_c, cooldown = _opt_ts(block.get("cooldown_until"))
    if not (ok_a and ok_w and ok_c):
        return None
    nxt = block.get("next_grant_id")
    return {"eligible": block["eligible"],
            "ineligible_reason": (reason if reason in KNOWN_INELIGIBLE else "unknown")
            if isinstance(reason, str) else None,
            "at_limit": at_limit, "grants": grants,
            "next_grant_id": nxt if isinstance(nxt, str) and nxt in seen else None,
            "weekly_resets_at": weekly, "cooldown_until": cooldown}


def claude_blocker(status, grant_id, now):
    """anthropicResetGrantBlocker plus the dialog's time checks; None when claimable."""
    if not status["eligible"]:
        return "ineligible"
    grant = next((g for g in status["grants"] if g["id"] == grant_id), None)
    if not grant:
        return "unknown_grant"
    if grant["paused"]:
        return "paused"
    if not grant["usable"]:
        return "not_usable"
    if grant["left"] <= 0:
        return "exhausted"
    if grant["requires_limit"] and not status["at_limit"]:
        return "not_limited"
    if grant["starts"] and grant["starts"] > now:
        return "not_started"
    if grant["expires"] and grant["expires"] <= now:
        return "grant_expired"
    if status["cooldown_until"] and status["cooldown_until"] > now:
        return "cooldown"
    return None


def _str(value):
    if isinstance(value, str):
        return value.strip() or None
    if isinstance(value, (int, float)) and not isinstance(value, bool):
        return str(value)
    return None


def parse_codex_credits(payload):
    """normalizeCodexResetCreditsPayload: available codex_rate_limits credits."""
    if isinstance(payload, str):
        try:
            payload = json.loads(payload)
        except ValueError:
            return None
    if not isinstance(payload, dict):
        return None
    keys = ("credits", "available_count", "availableCount", "applicable_available_count",
            "applicableAvailableCount")
    if not any(k in payload for k in keys):
        return None
    credits, ids = [], set()
    for item in payload.get("credits") if isinstance(payload.get("credits"), list) else []:
        if not isinstance(item, dict):
            continue
        if _str(item.get("reset_type", item.get("resetType"))) != "codex_rate_limits":
            continue
        if _str(item.get("status")) != "available":
            continue
        expires_raw = _str(item.get("expires_at", item.get("expiresAt")))
        if not expires_raw:
            continue
        granted_raw = _str(item.get("granted_at", item.get("grantedAt"))) or ""
        cid = _str(item.get("id")) or ""
        if not CODEX_ID_RE.fullmatch(cid):
            cid = "codex-" + hashlib.sha256(f"{granted_raw}|{expires_raw}".encode()).hexdigest()[:16]
        base, n = cid, 2
        while cid in ids:
            cid, n = f"{base}-{n}", n + 1
        ids.add(cid)
        credits.append({"id": cid, "granted": epoch(granted_raw), "expires": epoch(expires_raw)})
    count = num(payload.get("available_count", payload.get("availableCount")))
    return {"available_count": int(count) if count is not None else None, "credits": credits}


def _jwt_payload(value):
    if isinstance(value, dict):
        return value
    if not isinstance(value, str) or not value.strip():
        return None
    text = value.strip()
    try:
        parsed = json.loads(text)
        if isinstance(parsed, dict):
            return parsed
    except ValueError:
        pass
    parts = text.split(".")
    if len(parts) < 2:
        return None
    try:
        raw = base64.urlsafe_b64decode(parts[1] + "=" * (-len(parts[1]) % 4))
        parsed = json.loads(raw)
    except (ValueError, TypeError):
        return None
    return parsed if isinstance(parsed, dict) else None


def codex_account_id(entry):
    """resolveCodexChatgptAccountId over a /credentials entry."""
    meta = entry.get("metadata") if isinstance(entry.get("metadata"), dict) else {}
    attrs = entry.get("attributes") if isinstance(entry.get("attributes"), dict) else {}
    for source in (entry, meta, attrs):
        for key in ("chatgpt_account_id", "chatgptAccountId"):
            found = _str(source.get(key))
            if found:
                return found
    for source in (entry, meta, attrs):
        payload = _jwt_payload(source.get("id_token"))
        if payload:
            found = _str(payload.get("chatgpt_account_id", payload.get("chatgptAccountId")))
            if found:
                return found
    return None


def _window_limited(used, reset, now, full):
    if used is None or used < full:
        return False
    return reset is None or reset > now


def claude_limited(signals, pacer_snapshot, now):
    """True/False from hub header signals and seat-pacer windows; None without data."""
    result = None
    if signals:
        result = False
        prefix = "Anthropic-Ratelimit-Unified-"
        for win in ("5h", "7d"):
            reset = epoch(signals.get(f"{prefix}{win}-Reset"))
            if _window_limited(num(signals.get(f"{prefix}{win}-Utilization")), reset, now, 1):
                result = True
            if signals.get(f"{prefix}{win}-Status") == "rejected" and (reset is None or reset > now):
                result = True
        reset = epoch(signals.get(f"{prefix}Reset"))
        if signals.get(f"{prefix}Status") == "rejected" and (reset is None or reset > now):
            result = True
    if pacer_snapshot and isinstance(pacer_snapshot.get("windows"), list):
        result = bool(result)
        for w in pacer_snapshot["windows"]:
            if isinstance(w, dict) and _window_limited(num(w.get("utilization")),
                                                       epoch(w.get("resets_at")), now, 1):
                result = True
    return result


def codex_limited(signals, now):
    if not signals:
        return None
    limited = False
    for win in ("Primary", "Secondary"):
        minutes = num(signals.get(f"X-Codex-{win}-Window-Minutes"))
        if minutes == 0:
            continue
        if _window_limited(num(signals.get(f"X-Codex-{win}-Used-Percent")),
                           epoch(signals.get(f"X-Codex-{win}-Reset-At")), now, 100):
            limited = True
    return limited


# ---------------------------------------------------------------------------
# Files

def atomic_write(path, data, mode):
    directory = os.path.dirname(path) or "."
    os.makedirs(directory, exist_ok=True)
    fd, tmp = tempfile.mkstemp(prefix="." + os.path.basename(path) + ".", dir=directory)
    try:
        with os.fdopen(fd, "w") as fh:
            os.fchmod(fh.fileno(), mode)
            fh.write(data)
            fh.flush()
            os.fsync(fh.fileno())
        os.replace(tmp, path)
    except BaseException:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise
    try:
        dfd = os.open(directory, os.O_DIRECTORY)
        try:
            os.fsync(dfd)
        finally:
            os.close(dfd)
    except OSError:
        pass


# ---------------------------------------------------------------------------
# Hub client

class HubError(Exception):
    """A hub/management call failed. `sent` is False when nothing reached upstream."""

    def __init__(self, code, sent):
        super().__init__(code)
        self.code, self.sent = code, sent


class Hub:
    def __init__(self, base=HUB, key_file=KEY_FILE, clock=time.time):
        self.base, self.key_file, self.clock = base, key_file, clock
        self._key, self._key_mtime = None, None
        self._bad_auth, self._paused_until = 0, 0

    def key(self):
        try:
            mtime = os.stat(self.key_file).st_mtime
        except OSError:
            return self._key or ""
        if mtime != self._key_mtime:
            with open(self.key_file) as fh:
                self._key = fh.read().strip()
            self._key_mtime = mtime
        return self._key

    def request(self, method, path, body=None, timeout=20):
        if self.clock() < self._paused_until:
            raise HubError("hub_auth", False)
        data = None if body is None else json.dumps(body).encode()
        req = urllib.request.Request(self.base + path, data=data, method=method, headers={
            "Authorization": "Bearer " + self.key(), "Content-Type": "application/json"})
        try:
            with urllib.request.urlopen(req, timeout=timeout) as resp:
                raw = resp.read()
        except urllib.error.HTTPError as err:
            if err.code == 401:
                # Never let a wrong key snowball into the hub's 5-strike IP ban.
                self._bad_auth += 1
                self._key_mtime = None
                if self._bad_auth >= 2:
                    self._paused_until = self.clock() + HUB_AUTH_PAUSE
                raise HubError("hub_auth", False) from None
            raise HubError(f"hub_http_{err.code}", True) from None
        except urllib.error.URLError as err:
            refused = isinstance(err.reason, ConnectionRefusedError)
            raise HubError("hub_down", not refused) from None
        except (TimeoutError, OSError):
            raise HubError("hub_timeout", True) from None
        self._bad_auth = 0
        try:
            return json.loads(raw) if raw else {}
        except ValueError:
            raise HubError("hub_malformed", True) from None

    def get(self, path):
        return self.request("GET", path)

    def post(self, path, body):
        return self.request("POST", path, body)

    def api_call(self, auth_index, method, url, header, data=None, timeout=20):
        """Upstream request through the hub; returns (status_code, body)."""
        payload = {"auth_index": auth_index, "method": method, "url": url, "header": header}
        if data is not None:
            payload["data"] = data
        resp = self.request("POST", "/v8/management/requests/api-call", payload,
                            timeout=timeout + 10)
        if not isinstance(resp, dict) or not isinstance(resp.get("status_code"), int):
            raise HubError("hub_malformed", True)
        body = resp.get("body")
        if isinstance(body, str):
            try:
                body = json.loads(body)
            except ValueError:
                pass
        return resp["status_code"], body


class ReadError(Exception):
    def __init__(self, code):
        super().__init__(code)
        self.code = code


def _read_status(status, body):
    if status in (401, 403):
        raise ReadError("auth")
    if status == 429:
        raise ReadError("rate_limited")
    if status < 200 or status >= 300:
        raise ReadError("upstream")
    return body


# ---------------------------------------------------------------------------
# Service

def _empty_state():
    return {"version": 1, "default_policy": "expiry", "policies": {}, "orgs": {}, "journal": {},
            "accounts": {}, "grants": {}, "log": [], "last_refresh": 0}


class Service:
    def __init__(self, hub, clock=time.time, state_file=STATE_FILE, public_file=PUBLIC_FILE,
                 log_file=LOG_FILE, new_id=lambda: str(uuid.uuid4()), persist=True, echo=True):
        self.hub, self.clock, self.new_id = hub, clock, new_id
        self.state_file, self.public_file, self.log_file = state_file, public_file, log_file
        self.persist, self.echo = persist, echo
        self.lock = threading.RLock()     # state mutations
        self.work = threading.Lock()      # upstream work (ticks, spends, refreshes)
        self.started = self.now()
        self.state = self._load()
        self.live = None                  # {auth_index: {"p", "account_id"}} from the hub
        self.limited = {}
        self.observed = {}                # newest hub quota observation per account
        self.snapshot = None
        self._published = None

    def now(self):
        return int(self.clock())

    # -- persistence -------------------------------------------------------

    def _load(self):
        state = _empty_state()
        try:
            with open(self.state_file) as fh:
                loaded = json.load(fh)
            if isinstance(loaded, dict):
                state.update({k: v for k, v in loaded.items() if k in state})
        except (OSError, ValueError):
            pass
        if state["default_policy"] not in POLICIES:
            state["default_policy"] = "expiry"
        return state

    def save(self):
        if self.persist:
            with self.lock:
                atomic_write(self.state_file, json.dumps(self.state, separators=(",", ":")), 0o600)

    def log(self, entry):
        with self.lock:
            self.state["log"].insert(0, entry)
            del self.state["log"][STATE_LOG:]
        line = json.dumps(entry, separators=(",", ":"))
        if self.echo:
            print(line, flush=True)
        if not self.persist:
            return
        try:
            if os.path.getsize(self.log_file) > LOG_ROTATE_BYTES:
                os.replace(self.log_file, self.log_file + ".1")
        except OSError:
            pass
        try:
            fd = os.open(self.log_file, os.O_WRONLY | os.O_CREAT | os.O_APPEND, 0o600)
            with os.fdopen(fd, "a") as fh:
                fh.write(line + "\n")
        except OSError:
            pass

    # -- hub view ------------------------------------------------------------

    def refresh_hub_view(self, now):
        try:
            files = self.hub.get("/v8/management/credentials").get("files") or []
        except (HubError, AttributeError):
            return
        pacer = {}
        try:
            for item in self.hub.get("/v0/management/plugins/claude-seat-pacer/status").get(
                    "auths") or []:
                snap = (item or {}).get("snapshot") or {}
                if snap.get("auth_index"):
                    pacer[snap["auth_index"]] = snap
        except (HubError, AttributeError):
            pass  # plugin missing: header signals only
        live, limited, observed = {}, {}, {}
        for entry in files:
            if not isinstance(entry, dict):
                continue
            provider, idx = entry.get("provider"), entry.get("auth_index")
            if provider not in ("claude", "codex") or not isinstance(idx, str) or not idx:
                continue
            if entry.get("disabled"):
                continue
            signals = (entry.get("quota") or {}).get("signals") or {}
            observed[idx] = max(epoch((entry.get("quota") or {}).get("observed_at")) or 0,
                                epoch((pacer.get(idx) or {}).get("observed_at")) or 0)
            if provider == "claude":
                live[idx] = {"p": "claude"}
                limited[idx] = claude_limited(signals, pacer.get(idx), now)
            else:
                live[idx] = {"p": "codex", "account_id": codex_account_id(entry)}
                limited[idx] = codex_limited(signals, now)
        with self.lock:
            self.live, self.limited, self.observed = live, limited, observed
            for order, idx in enumerate(sorted(live)):
                if idx not in self.state["accounts"]:
                    self.state["accounts"][idx] = {
                        "p": live[idx]["p"], "checked": None, "next_check": now + order * 20,
                        "error": None, "backoff_until": 0, "ok_at": None, "eligible": None,
                        "at_limit": None, "cooldown_until": None}

    # -- reads -----------------------------------------------------------------

    def _stagger(self, idx):
        return int(hashlib.sha256(idx.encode()).hexdigest(), 16) % READ_STAGGER

    def read_account(self, idx, now):
        """Read one account's grants/credits and merge them. Raises ReadError."""
        info = (self.live or {}).get(idx) or {"p": self.state["accounts"].get(idx, {}).get("p")}
        acct = self.state["accounts"][idx]
        try:
            if info["p"] == "claude":
                status, body = self.hub.api_call(idx, "GET", CLAUDE_STATUS_URL,
                                                 dict(CLAUDE_HEADERS), timeout=CLAUDE_READ_TIMEOUT)
                body = _read_status(status, body)
                parsed = parse_claude_status(body.get("cedar_ember")) if isinstance(
                    body, dict) else None
                if not isinstance(body, dict):
                    raise ReadError("upstream")
            else:
                header = {**CODEX_HEADERS, **CODEX_READ_HEADERS}
                if info.get("account_id"):
                    header["Chatgpt-Account-Id"] = info["account_id"]
                status, body = self.hub.api_call(idx, "GET", CODEX_CREDITS_URL, header,
                                                 timeout=CODEX_TIMEOUT)
                parsed = parse_codex_credits(_read_status(status, body))
            if parsed is None:
                raise ReadError("malformed")
        except HubError:
            err = ReadError("upstream")
        except ReadError as exc:
            err = exc
        else:
            err = None
        with self.lock:
            acct["checked"] = now
            if err:
                acct["error"] = err.code
                if err.code == "rate_limited":
                    acct["backoff_until"] = now + BACKOFF_SECONDS
                    acct["next_check"] = now + BACKOFF_SECONDS
                else:
                    acct["next_check"] = now + READ_RETRY
                raise err
            acct.update({"error": None, "ok_at": now, "backoff_until": 0,
                         "next_check": now + READ_INTERVAL + self._stagger(idx)})
            if info["p"] == "claude":
                acct.update({"eligible": parsed["eligible"], "at_limit": parsed["at_limit"],
                             "cooldown_until": parsed["cooldown_until"]})
                self._merge(idx, "claude", parsed["grants"], now)
            else:
                acct.update({"eligible": None, "at_limit": None, "cooldown_until": None})
                self._merge(idx, "codex", [
                    {"id": c["id"], "label": "Codex rate-limit reset credit", "total": 1,
                     "left": 1, "starts": c["granted"], "expires": c["expires"], "clears": [],
                     "paused": False, "usable": True, "requires_limit": False}
                    for c in parsed["credits"]], now)
        return parsed

    def _merge(self, idx, provider, items, now):
        grants = self.state["grants"]
        listed = set()
        for item in items:
            key = f"{idx}/{item['id']}"
            listed.add(key)
            g = grants.setdefault(key, {"account": idx, "p": provider, "first_seen": now,
                                        "final": None, "final_at": None, "last": None,
                                        "last_attempt": 0})
            fields = ("id", "label", "total", "left", "starts", "expires", "clears", "paused",
                      "usable", "requires_limit")
            # A settled grant never reopens: a lagging read must not invite a second spend.
            g.update({k: item[k] for k in fields if not (g["final"] and k == "left")})
            g["seen"] = now
            if g["final"] is None and item["left"] <= 0:
                g["final"], g["final_at"] = "spent", now
        for key, g in grants.items():
            if g["account"] != idx or key in listed or g["final"]:
                continue
            if g.get("expires") and g["expires"] <= now:
                self._settle(key, "expired", now)
            else:
                g["final"], g["final_at"], g["left"] = "spent", now, 0   # used elsewhere

    def _settle(self, key, final, now):
        g = self.state["grants"][key]
        g["final"], g["final_at"] = final, now
        if final == "expired":
            g["last"] = {"t": now, "trigger": "expiry", "result": "expired",
                         "detail": DETAILS["expired"]}
            self.log({"t": now, "grant": g["id"], "account": g["account"], "p": g["p"],
                      "trigger": "expiry", "result": "expired", "detail": DETAILS["expired"]})

    # -- policy ------------------------------------------------------------------

    def policy(self, key):
        return self.state["policies"].get(key) or self.state["default_policy"]

    def _unresolved(self, key, now):
        j = self.state["journal"].get(key)
        return j if j and j.get("outcome") is None and now - j["created"] < RETRY_WINDOW else None

    def _account_settling(self, idx, key, now):
        """Another spend on this account may still land, so no new request id may go out.

        Holds while any other spend's outcome is unknown, and for RETRY_WINDOW after a
        spend that succeeded or may have: reads can lag the spend, so a fresh one
        could still show the old grant or credit and invite a second spend.
        """
        for other, j in self.state["journal"].items():
            if other != key and j.get("account") == idx and self._unresolved(other, now):
                return True
        last = (self.state["accounts"].get(idx) or {}).get("last_spend") or 0
        return now - last < RETRY_WINDOW

    def _note_spend(self, idx):
        """Caller holds the lock. Invalidates the limit observation the spend used."""
        self.state["accounts"].setdefault(idx, {})["last_spend"] = self.now()

    def next_action(self, key, now):
        g = self.state["grants"][key]
        if g["final"]:
            return None
        if self._unresolved(key, now):
            return max(now, g["last_attempt"] + RETRY_GAP)
        pol = self.policy(key)
        if pol == "expiry" and g.get("expires"):
            if now >= g["expires"]:
                return None
            return max(g["expires"] - LEAD_SECONDS, g["last_attempt"] + EXPIRY_ATTEMPT_GAP)
        if pol == "limit" and self._limit_signal(g["account"]):
            return max(now, g["last_attempt"] + LIMIT_ATTEMPT_GAP)
        return None

    def grant_state(self, key, now):
        g = self.state["grants"][key]
        if g["final"]:
            return g["final"]
        j = self.state["journal"].get(key)
        if j and j.get("outcome") is None:
            return "unknown"
        if g.get("expires") and g["expires"] <= now:
            return "expired"
        return "off" if self.policy(key) == "off" else "pending"

    # -- scheduler -----------------------------------------------------------------

    def _read_due(self, idx, now):
        acct = self.state["accounts"].get(idx)
        if not acct or acct.get("backoff_until", 0) > now:
            return False
        if acct.get("next_check") is None or now >= acct["next_check"]:
            return True
        ok_at = acct.get("ok_at") or 0
        for key, g in self.state["grants"].items():
            if g["account"] != idx:
                continue
            t = self.next_action(key, now)
            if t is not None and now >= t - PRE_ACTION_READ and ok_at < t - PRE_ACTION_READ:
                return True
        return False

    def tick(self):
        with self.work:
            now = self.now()
            self.refresh_hub_view(now)
            for idx in sorted(self.live or {}):
                if self._read_due(idx, now):
                    try:
                        self.read_account(idx, now)
                    except ReadError:
                        pass
            for key in sorted(self.state["grants"]):
                g = self.state["grants"].get(key)
                if g and not g["final"] and g["account"] in (self.live or {}):
                    self._maybe_act(key, self.now())
            self._sweep(self.now())
            self.save()
            self.publish()

    def _limit_signal(self, idx):
        """Hub says limited, from an observation newer than our last spend there."""
        last = (self.state["accounts"].get(idx) or {}).get("last_spend") or 0
        return bool(self.limited.get(idx)) and self.observed.get(idx, 0) > last

    def _maybe_act(self, key, now):
        g = self.state["grants"][key]
        pol = self.policy(key)
        if self._unresolved(key, now):
            if pol != "off" and now - g["last_attempt"] >= RETRY_GAP:
                self.attempt(key, self.state["journal"][key]["trigger"])
            return
        if pol == "expiry" and g.get("expires") and g["expires"] - LEAD_SECONDS <= now < g[
                "expires"]:
            if now - g["last_attempt"] >= EXPIRY_ATTEMPT_GAP:
                self.attempt(key, "expiry")
        elif pol == "limit" and self._limit_signal(g["account"]):
            if now - g["last_attempt"] >= LIMIT_ATTEMPT_GAP:
                self.attempt(key, "limit")

    def _sweep(self, now):
        with self.lock:
            for key, g in list(self.state["grants"].items()):
                if not g["final"] and g.get("expires") and g["expires"] <= now and not \
                        self._unresolved(key, now):
                    self._settle(key, "expired", now)
                if g["final"] and (g["final_at"] or 0) < now - KEEP_DONE:
                    del self.state["grants"][key]
                    self.state["policies"].pop(key, None)
                    self.state["journal"].pop(key, None)
            for key, j in list(self.state["journal"].items()):
                if j["created"] < now - KEEP_DONE:
                    del self.state["journal"][key]

    # -- spending ----------------------------------------------------------------

    def _record(self, key, trigger, result, detail=None):
        now = self.now()
        with self.lock:
            g = self.state["grants"][key]
            detail = detail or DETAILS.get(result, result)
            g["last"] = {"t": now, "trigger": trigger, "result": result, "detail": detail}
            g["last_attempt"] = now
        self.log({"t": now, "grant": g["id"], "account": g["account"], "p": g["p"],
                  "trigger": trigger, "result": result, "detail": detail})
        self.save()
        self.publish()
        return result

    def _preflight_allowed(self, idx, now):
        acct = self.state["accounts"].get(idx) or {}
        if acct.get("backoff_until", 0) > now:
            return now - (acct.get("checked") or 0) >= BACKOFF_PREFLIGHT_GAP
        return True

    def attempt(self, key, trigger):
        """One spend attempt with preflight and journal. Returns the result code."""
        now = self.now()
        g = self.state["grants"].get(key)
        if not g:
            return "unknown_grant"
        if g["final"]:
            return "not_pending"
        idx = g["account"]
        if not self._unresolved(key, now) and self._account_settling(idx, key, now):
            return "account_busy"      # skipped silently; the tick retries later
        if not self._preflight_allowed(idx, now) and not self._unresolved(key, now):
            return "rate_limited"      # skipped silently; the tick retries later
        if g["p"] == "claude":
            return self._attempt_claude(key, g, idx, trigger, now)
        return self._attempt_codex(key, g, idx, trigger, now)

    def _journal(self, key, g, trigger, now, org=None):
        entry = {"rid": self.new_id(), "created": now, "account": g["account"], "p": g["p"],
                 "trigger": trigger, "outcome": None, "left_before": g.get("left")}
        if org:
            entry["org"] = org
        if not REQUEST_ID_RE.fullmatch(entry["rid"]):
            raise ValueError("bad request id")
        with self.lock:
            self.state["journal"][key] = entry
        self.save()               # durable before the request leaves this process
        return entry

    def _close_stale(self, key, now):
        """A stale ambiguous attempt is closed only by a read taken after it."""
        j = self.state["journal"].get(key)
        if j and j.get("outcome") is None and now - j["created"] >= RETRY_WINDOW:
            acct = self.state["accounts"].get(j["account"]) or {}
            if (acct.get("ok_at") or 0) > j["created"]:
                with self.lock:
                    j["outcome"] = "unknown_settled"
                return True
            return False
        return True

    def _org(self, idx):
        org = self.state["orgs"].get(idx)
        if org and ORG_RE.fullmatch(org):
            return org
        try:
            status, body = self.hub.api_call(idx, "GET", CLAUDE_PROFILE_URL, dict(CLAUDE_HEADERS),
                                             timeout=CLAUDE_READ_TIMEOUT)
        except HubError:
            return None
        if status < 200 or status >= 300 or not isinstance(body, dict):
            return None
        uuid_ = (body.get("organization") or {}).get("uuid") if isinstance(
            body.get("organization"), dict) else None
        if not isinstance(uuid_, str) or not ORG_RE.fullmatch(uuid_):
            return None
        with self.lock:
            self.state["orgs"][idx] = uuid_.lower()
        self.save()
        return uuid_.lower()

    def _clear_cooldown(self, idx):
        try:
            resp = self.hub.post("/v8/management/routing/cooldown/reset", {"auth_index": idx})
        except HubError:
            return False
        return isinstance(resp, dict) and resp.get("status") == "ok" and resp.get(
            "auth_index") == idx

    def _attempt_claude(self, key, g, idx, trigger, now):
        j = self._unresolved(key, now)
        retry = j is not None
        if not retry:
            try:
                status = self.read_account(idx, now)        # preflight; also closes stale ones
            except ReadError as err:
                return self._record(key, trigger, "preflight_failed",
                                    f"status read failed ({err.code}); nothing sent")
            if not self._close_stale(key, now):
                return self._record(key, trigger, "unknown")
            g = self.state["grants"][key]
            if g["final"]:
                gone = "exhausted" if g.get("seen") == now else "unknown_grant"
                return self._record(key, trigger, gone if g["final"] == "spent"
                                    else "grant_expired")
            blocker = claude_blocker(status, g["id"], now)
            if blocker:
                return self._record(key, trigger, blocker)
            org = self._org(idx)
            if not org:
                return self._record(key, trigger, "preflight_failed",
                                    "organization read failed; nothing sent")
            if not GRANT_ID_RE.fullmatch(g["id"]):
                return self._record(key, trigger, "preflight_failed", "invalid grant id")
            j = self._journal(key, g, trigger, now, org=org)
        if self.now() - j["created"] >= RETRY_WINDOW:
            return self._record(key, trigger, "unknown")
        code = self._claim(idx, j["org"], g["id"], j["rid"])
        with self.lock:
            if code != "unknown" and (not retry or code in SPENT_CODES):
                j["outcome"] = code
            # The outcome and its local accounting reach disk together, before anything
            # else can fail, so a restart never sees a settled spend on an unchanged grant.
            if code in SPENT_CODES:
                g["left"] = max(0, (g.get("left") or 1) - 1)
                if g["left"] == 0:
                    g["final"], g["final_at"] = "spent", self.now()
                self.state["accounts"].setdefault(idx, {})["next_check"] = self.now() + 60
            if code in SPENT_CODES or code == "unknown":
                self._note_spend(idx)
        self.save()
        detail = None
        if code in SPENT_CODES:
            cleared = self._clear_cooldown(idx)
            detail = DETAILS[code] + ("; hub cooldown cleared" if cleared
                                      else "; hub cooldown clear failed")
        return self._record(key, trigger, code, detail)

    def _claim(self, idx, org, grant_id, request_id):
        if not (ORG_RE.fullmatch(org) and GRANT_ID_RE.fullmatch(grant_id)
                and REQUEST_ID_RE.fullmatch(request_id)):
            return "hub_unavailable"
        body = json.dumps({"program": CLAUDE_PROGRAM, "grant_id": grant_id,
                           "request_id": request_id})
        try:
            status, resp = self.hub.api_call(
                idx, "POST", f"{ANTHROPIC}/api/organizations/{org}/reset_rate_limits",
                dict(CLAUDE_HEADERS), body, timeout=CLAUDE_CLAIM_TIMEOUT)
        except HubError as err:
            return "unknown" if err.sent else "hub_unavailable"
        if status == 429:
            return "rate_limited"
        if status in (401, 403):
            return "auth_error"
        result = resp.get("result") if isinstance(resp, dict) else None
        if 200 <= status < 300 and result in CLAUDE_RESULTS:
            return result
        return "unknown"

    def _attempt_codex(self, key, g, idx, trigger, now):
        j = self._unresolved(key, now)
        retry = j is not None
        before = {k for k, x in self.state["grants"].items()
                  if x["account"] == idx and not x["final"]}
        if not retry:
            try:
                self.read_account(idx, now)
            except ReadError as err:
                return self._record(key, trigger, "preflight_failed",
                                    f"credit read failed ({err.code}); nothing sent")
            if not self._close_stale(key, now):
                return self._record(key, trigger, "unknown")
            g = self.state["grants"][key]
            if g["final"]:
                return self._record(key, trigger, "no_credit" if g["final"] == "spent"
                                    else "grant_expired")
            before = {k for k, x in self.state["grants"].items()
                      if x["account"] == idx and not x["final"]}
            # Consume cannot name a credit, so upstream may use any listed one.
            if any(self.policy(k) == "off" for k in before if k != key):
                return self._record(key, trigger, "off_credit")
            j = self._journal(key, g, trigger, now)
        if self.now() - j["created"] >= RETRY_WINDOW:
            return self._record(key, trigger, "unknown")
        header = {**CODEX_HEADERS}
        account_id = ((self.live or {}).get(idx) or {}).get("account_id")
        if account_id:
            header["Chatgpt-Account-Id"] = account_id
        try:
            status, resp = self.hub.api_call(idx, "POST", CODEX_CONSUME_URL, header,
                                             json.dumps({"redeem_request_id": j["rid"]}),
                                             timeout=CODEX_TIMEOUT)
            code = resp.get("code") if isinstance(resp, dict) else None
            if 200 <= status < 300 and code in CODEX_SUCCESS:
                pass
            elif status == 429:
                code = "rate_limited"
            elif status in (401, 403):
                code = "auth_error"
            else:
                code = "unknown"
        except HubError as err:
            code = "unknown" if err.sent else "hub_unavailable"
        with self.lock:
            if code != "unknown" and (not retry or code in SPENT_CODES):
                j["outcome"] = code
            if code in SPENT_CODES or code == "unknown":
                self._note_spend(idx)
        self.save()
        if code not in SPENT_CODES:
            return self._record(key, trigger, code)
        cleared = self._clear_cooldown(idx)
        suffix = "; hub cooldown cleared" if cleared else "; hub cooldown clear failed"
        try:
            self.read_account(idx, self.now())               # verify one credit disappeared
        except ReadError:
            with self.lock:
                if not g["final"]:
                    g["final"], g["final_at"], g["left"] = "spent", self.now(), 0
            return self._record(key, trigger, code, DETAILS[code] + suffix + "; verify failed")
        now2 = self.now()
        gone = sorted(k for k in before if self.state["grants"][k]["final"])
        with self.lock:
            g = self.state["grants"][key]
            for other in gone:
                if other != key:
                    self.state["grants"][other]["last"] = {
                        "t": now2, "trigger": trigger, "result": code,
                        "detail": "used by a consume for another credit"}
        if key in gone:
            return self._record(key, trigger, code, DETAILS[code] + suffix + "; verified")
        with self.lock:
            g["final"], g["final_at"] = ("failed" if gone else "spent"), now2
        if gone:
            return self._record(key, trigger, "wrong_credit", DETAILS["wrong_credit"] + suffix)
        return self._record(key, trigger, code, DETAILS[code] + suffix + "; credit still listed")

    # -- API operations ------------------------------------------------------------

    def resolve(self, grant, account=None):
        """Grant key from an upstream id (+ optional account). Raises LookupError."""
        if not isinstance(grant, str) or not grant:
            raise LookupError("bad_request")
        if account is not None:
            key = f"{account}/{grant}"
            if key in self.state["grants"]:
                return key
            raise LookupError("unknown_grant")
        keys = [k for k, g in self.state["grants"].items() if g["id"] == grant]
        if not keys:
            raise LookupError("unknown_grant")
        if len(keys) > 1:
            raise LookupError("ambiguous_grant")
        return keys[0]

    def set_policy(self, key, policy):
        with self.lock:
            if policy == "default":
                self.state["policies"].pop(key, None)
            else:
                self.state["policies"][key] = policy
        self.save()
        self.publish()

    def set_default_policy(self, policy):
        with self.lock:
            self.state["default_policy"] = policy
        self.save()
        self.publish()

    def manual_spend(self, key):
        if not self.work.acquire(timeout=60):
            return "busy"
        try:
            self.refresh_hub_view(self.now())
            result = self.attempt(key, "manual")
            self._sweep(self.now())
            self.publish()
            return result
        finally:
            self.work.release()

    def refresh_all(self):
        now = self.now()
        wait = (self.state.get("last_refresh") or 0) + REFRESH_GAP - now
        if wait > 0:
            return wait
        if not self.work.acquire(timeout=60):
            return 30
        try:
            with self.lock:
                self.state["last_refresh"] = now
            self.refresh_hub_view(now)
            for idx in sorted(self.live or {}):
                if self.state["accounts"][idx].get("backoff_until", 0) > now:
                    continue
                try:
                    self.read_account(idx, self.now())
                except ReadError:
                    pass
            self._sweep(self.now())
            self.save()
            self.publish()
        finally:
            self.work.release()
        return 0

    # -- public view -----------------------------------------------------------

    def public(self):
        with self.lock:
            now = self.now()
            live = self.live if self.live is not None else {
                k: {"p": a["p"]} for k, a in self.state["accounts"].items()}
            accounts = []
            for idx in sorted(live):
                a = self.state["accounts"].get(idx) or {}
                accounts.append({
                    "id": idx, "p": live[idx]["p"], "checked": a.get("checked"),
                    "next_check": a.get("next_check"), "error": a.get("error"),
                    "eligible": a.get("eligible"), "at_limit": a.get("at_limit"),
                    "limited": self.limited.get(idx), "cooldown_until": a.get("cooldown_until")})
            grants = []
            for key, g in self.state["grants"].items():
                if g["account"] not in live:
                    continue
                grants.append({
                    "id": g["id"], "account": g["account"], "p": g["p"], "label": g["label"],
                    "clears": list(g["clears"]), "starts": g.get("starts"),
                    "expires": g.get("expires"), "left": g["left"], "total": g["total"],
                    "usable": g.get("usable"), "requires_limit": bool(g.get("requires_limit")),
                    "policy": self.policy(key), "policy_set": key in self.state["policies"],
                    "next_action": self.next_action(key, now),
                    "state": self.grant_state(key, now), "last": g.get("last")})
            grants.sort(key=lambda x: (x["expires"] is None, x["expires"] or 0, x["account"],
                                       x["id"]))
            return {"version": 1, "updated": now,
                    "service": {"started": self.started, "lead_seconds": LEAD_SECONDS,
                                "default_policy": self.state["default_policy"]},
                    "accounts": accounts, "grants": grants,
                    "log": [dict(e) for e in self.state["log"][:PUBLIC_LOG]]}

    def publish(self):
        view = self.public()
        body = {k: v for k, v in view.items() if k != "updated"}
        with self.lock:
            if body == self._published and self.snapshot is not None:
                return self.snapshot
            self._published, self.snapshot = body, view
            if self.persist:
                atomic_write(self.public_file, json.dumps(view, separators=(",", ":")), 0o644)
        return view


# ---------------------------------------------------------------------------
# HTTP API

def _bearer(header):
    return header[7:].strip() if header and header[:7].lower() == "bearer " else ""


def make_server(service, host=LISTEN_HOST, port=LISTEN_PORT):
    class Handler(BaseHTTPRequestHandler):
        server_version = "quota-resets/1"

        def log_message(self, *args):
            pass

        def _send(self, status, payload):
            data = json.dumps(payload, separators=(",", ":")).encode()
            self.send_response(status)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(data)))
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            self.wfile.write(data)

        def _authorized(self):
            expected = (service.hub.key() or "").encode()
            given = (_bearer(self.headers.get("Authorization"))
                     or (self.headers.get("X-Quota-Resets-Key") or "").strip()).encode()
            return bool(expected) and hmac.compare_digest(given, expected)

        def _path(self):
            path = self.path.split("?", 1)[0].rstrip("/") or "/"
            if path.startswith("/quota-resets"):
                path = path[len("/quota-resets"):] or "/"
            return path

        def _body(self):
            length = int(self.headers.get("Content-Length") or 0)
            if length > 65536:
                raise ValueError("too large")
            raw = self.rfile.read(length) if length else b"{}"
            data = json.loads(raw or b"{}")
            if not isinstance(data, dict):
                raise ValueError("not an object")
            return data

        def _state(self):
            return service.snapshot or service.publish()

        def do_GET(self):
            if not self._authorized():
                return self._send(401, {"error": "unauthorized"})
            if self._path() == "/state":
                return self._send(200, self._state())
            return self._send(404, {"error": "not_found"})

        def do_POST(self):
            if not self._authorized():
                return self._send(401, {"error": "unauthorized"})
            path = self._path()
            try:
                body = self._body()
            except (ValueError, UnicodeDecodeError):
                return self._send(400, {"error": "bad_request"})
            if path == "/policy":
                if "default_policy" in body and "grant" not in body:
                    if body["default_policy"] not in POLICIES:
                        return self._send(400, {"error": "bad_policy"})
                    service.set_default_policy(body["default_policy"])
                    return self._send(200, self._state())
                if body.get("policy") not in POLICIES + ("default",):
                    return self._send(400, {"error": "bad_policy"})
                try:
                    key = service.resolve(body.get("grant"), body.get("account"))
                except LookupError as err:
                    return self._send(404 if str(err) == "unknown_grant" else 400,
                                      {"error": str(err)})
                service.set_policy(key, body["policy"])
                return self._send(200, self._state())
            if path == "/spend":
                try:
                    key = service.resolve(body.get("grant"), body.get("account"))
                except LookupError as err:
                    return self._send(404 if str(err) == "unknown_grant" else 400,
                                      {"error": str(err)})
                result = service.manual_spend(key)
                return self._send(409 if result == "busy" else 200,
                                  {"result": result, "state": self._state()})
            if path == "/refresh":
                wait = service.refresh_all()
                if wait > 0:
                    return self._send(429, {"retry_after": int(wait)})
                return self._send(200, self._state())
            return self._send(404, {"error": "not_found"})

    return ThreadingHTTPServer((host, port), Handler)


# ---------------------------------------------------------------------------
# CLI

def _fmt(t, now):
    if t is None:
        return "-"
    stamp = datetime.fromtimestamp(t).strftime("%Y-%m-%d %H:%M")
    delta = t - now
    span = f"{abs(delta) // 86400}d{abs(delta) % 86400 // 3600}h" if abs(delta) >= 86400 else \
        f"{abs(delta) // 3600}h{abs(delta) % 3600 // 60:02d}m"
    return f"{stamp} ({'in ' + span if delta >= 0 else span + ' ago'})"


def print_plan(view, out=sys.stdout):
    now = int(time.time())
    svc = view["service"]
    print(f"default policy: {svc['default_policy']}, lead {svc['lead_seconds']} s", file=out)
    for a in view["accounts"]:
        print(f"\n{a['p']} {a['id']}: checked {_fmt(a['checked'], now)}, error {a['error']}, "
              f"eligible {a['eligible']}, at_limit {a['at_limit']}, limited {a['limited']}, "
              f"cooldown_until {_fmt(a['cooldown_until'], now)}", file=out)
        rows = [g for g in view["grants"] if g["account"] == a["id"]]
        if not rows:
            print("  (no grants/credits)", file=out)
        for g in rows:
            pol = g["policy"] + ("" if g["policy_set"] else " (default)")
            print(f"  {g['id']} [{g['label']}] left {g['left']}/{g['total']} "
                  f"clears {','.join(g['clears']) or '-'} expires {_fmt(g['expires'], now)}",
                  file=out)
            print(f"    policy {pol}, state {g['state']}, next action "
                  f"{_fmt(g['next_action'], now)}"
                  + (f", last {g['last']['result']}" if g["last"] else ""), file=out)


def plan(args):
    hub = Hub()
    try:
        req = urllib.request.Request(f"http://{LISTEN_HOST}:{LISTEN_PORT}/state",
                                     headers={"Authorization": "Bearer " + hub.key()})
        with urllib.request.urlopen(req, timeout=10) as resp:
            view = json.load(resp)
        print("(from the running service)")
    except (urllib.error.URLError, OSError, ValueError):
        # Service down: dry run with fresh reads, nothing persisted, nothing spent.
        service = Service(hub, persist=False, echo=False)
        now = service.now()
        service.refresh_hub_view(now)
        for idx in sorted(service.live or {}):
            acct = service.state["accounts"][idx]
            if acct.get("backoff_until", 0) > now or (acct.get("ok_at") or 0) > now - 600:
                continue
            try:
                service.read_account(idx, now)
            except ReadError:
                pass
        view = service.public()
        print("(dry run, service not reachable)")
    print_plan(view)


def serve(args):
    service = Service(Hub())
    server = make_server(service)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    print(json.dumps({"t": service.now(), "result": "started",
                      "listen": f"{LISTEN_HOST}:{LISTEN_PORT}"}), flush=True)
    while True:
        try:
            service.tick()
        except Exception as exc:  # keep the loop alive; never log payloads
            print(json.dumps({"t": service.now(), "result": "tick_error",
                              "detail": type(exc).__name__}), flush=True)
        time.sleep(TICK_SECONDS)


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--plan", action="store_true", help="print planned actions (dry run)")
    args = parser.parse_args(argv)
    (plan if args.plan else serve)(args)


if __name__ == "__main__":
    main()

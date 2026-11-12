#!/usr/bin/env python3
"""Record pooled quota snapshots for the Management Center quota page.

Every run (systemd timer, every 5 min) reads what the hub already knows:
- /v8/management/credentials quota signals (Claude + Codex response headers)
- claude-seat-pacer status (fresher Claude usage-endpoint readings)
and appends one sample to public/history.json, keeping 14 days. Accounts are
keyed by the hub's auth_index, so the file holds no emails or tokens. Makes no
calls to Anthropic or OpenAI.

After a hub restart the cached signals stay empty until traffic flows, so an
account with no reading at all repeats its last known one (src "carry", same
"seen") for up to CARRY_SECONDS; windows that have reset since are dropped.

Per account: "w" weekly, "f" 5-hour and, for Claude accounts that report it,
"wf" the Fable meter: 0..100 over the half of the weekly limit that Fable may
use. "wf" is left out when unknown, so older samples and other providers simply
have none.
"""
import json
import os
import time
import urllib.request
from datetime import datetime

HUB = "http://127.0.0.1:8317"
HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, "public", "history.json")
KEEP_SECONDS = 14 * 24 * 3600
CARRY_SECONDS = 6 * 3600
KEY_FILE = os.path.expanduser("~/.config/cliproxyapi/management-key")
# Windows written only when known, to keep the file small.
OPTIONAL_WINDOWS = ("wf",)
# Display names the usage endpoint has used for the Fable-scoped weekly limit.
FABLE_SCOPES = ("fable", "fable 5")


def get(path):
    with open(KEY_FILE) as fh:
        key = fh.read().strip()
    req = urllib.request.Request(HUB + path, headers={"Authorization": f"Bearer {key}"})
    with urllib.request.urlopen(req, timeout=15) as r:
        return json.load(r)


def epoch(value):
    if value in (None, ""):
        return None
    if isinstance(value, (int, float)) or str(value).isdigit():
        return int(float(value))
    return int(datetime.fromisoformat(str(value).replace("Z", "+00:00")).timestamp())


def num(value):
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


def window(used, resets):
    return None if used is None else {"used": round(used, 2), "reset": resets}


def header_window(sig, name):
    """One Claude unified-header window ("7d", "5h", "7d_oi"), or None."""
    used = num(sig.get(f"Anthropic-Ratelimit-Unified-{name}-Utilization"))
    return window(None if used is None else used * 100,
                  epoch(sig.get(f"Anthropic-Ratelimit-Unified-{name}-Reset")))


def pacer_window(snap, kind, scopes=None):
    """The first seat-pacer window of `kind` (and one of `scopes`, if given), or None."""
    for w in (snap or {}).get("windows", []):
        if w.get("kind") != kind:
            continue
        if scopes is not None and str(w.get("scope") or "").strip().lower() not in scopes:
            continue
        used = num(w.get("utilization"))
        if used is not None:
            return window(used * 100, epoch(w.get("resets_at")))
    return None


def claude_reading(sig, seen, snap):
    """(weekly, five_hour, fable, seen, src) for one Claude account.

    Header signals by default; a seat-pacer snapshot at least as fresh replaces
    the windows it reports. The Fable-scoped weekly window is "7d_oi" in the
    headers and a "weekly_scoped" window scoped to Fable in the snapshot; when the
    preferred source has none, the other one is used.
    """
    weekly, five, fable = (header_window(sig, name) for name in ("7d", "5h", "7d_oi"))
    src = "headers"
    pacer_fable = pacer_window(snap, "weekly_scoped", FABLE_SCOPES)
    pacer_seen = epoch(snap.get("observed_at")) if snap else None
    if snap and (seen is None or (pacer_seen is not None and pacer_seen >= seen)):
        weekly = pacer_window(snap, "seven_day") or weekly
        five = pacer_window(snap, "five_hour") or five
        fable = pacer_fable or fable
        seen, src = pacer_seen, "usage"
    elif fable is None:
        fable = pacer_fable
    return weekly, five, fable, seen, src


def carry_forward(accounts, samples, now):
    """Fill accounts without any reading from their newest earlier one (<= CARRY_SECONDS old)."""
    for rec in accounts:
        if rec.get("seen") is not None:
            continue
        for sample in reversed(samples):
            prev = next((a for a in sample.get("a", []) if a.get("id") == rec["id"]), None)
            if prev is None or prev.get("seen") is None:
                continue
            if now - prev["seen"] <= CARRY_SECONDS:
                for key in ("w", "f") + OPTIONAL_WINDOWS:
                    win = prev.get(key)
                    win = win if win and (win.get("reset") is None or win["reset"] > now) \
                        else None
                    if win is not None or key not in OPTIONAL_WINDOWS:
                        rec[key] = win
                if prev.get("plan") and not rec.get("plan"):
                    rec["plan"] = prev["plan"]
                rec.update({"seen": prev["seen"], "src": "carry"})
            break
    return accounts


def main():
    now = int(time.time())
    accounts = []
    pacer = {}
    try:
        for a in get("/v0/management/plugins/claude-seat-pacer/status").get("auths", []):
            snap = a.get("snapshot") or {}
            if snap.get("auth_index"):
                pacer[snap["auth_index"]] = snap
    except Exception:
        pass  # plugin missing or down: fall back to header signals

    for f in get("/v8/management/credentials").get("files", []):
        provider, idx = f.get("provider"), f.get("auth_index")
        if provider not in ("claude", "codex") or not idx:
            continue
        sig = (f.get("quota") or {}).get("signals") or {}
        seen = epoch((f.get("quota") or {}).get("observed_at"))
        rec = {"id": idx, "p": provider, "on": not f.get("disabled", False)}
        fable = None
        if provider == "claude":
            weekly, five, fable, seen, src = claude_reading(sig, seen, pacer.get(idx))
        else:
            primary_minutes = num(sig.get("X-Codex-Primary-Window-Minutes")) or 0
            secondary_minutes = num(sig.get("X-Codex-Secondary-Window-Minutes")) or 0
            primary = window(num(sig.get("X-Codex-Primary-Used-Percent")),
                             epoch(sig.get("X-Codex-Primary-Reset-At")))
            secondary = window(num(sig.get("X-Codex-Secondary-Used-Percent")),
                               epoch(sig.get("X-Codex-Secondary-Reset-At")))
            weekly = primary if primary_minutes >= 10080 else (secondary if secondary_minutes >= 10080 else primary)
            five = primary if 0 < primary_minutes <= 300 else (secondary if 0 < secondary_minutes <= 300 else None)
            src = "headers"
            rec["plan"] = sig.get("X-Codex-Plan-Type")
        rec.update({"w": weekly, "f": five, "seen": seen, "src": src})
        if fable is not None:
            rec["wf"] = fable
        accounts.append(rec)

    try:
        data = json.load(open(OUT))
    except (OSError, ValueError):
        data = {"version": 1, "interval": 300, "samples": []}
    data["samples"] = [s for s in data["samples"] if s["t"] >= now - KEEP_SECONDS]
    carry_forward(accounts, data["samples"], now)
    data["samples"].append({"t": now, "a": accounts})
    data["updated"] = now
    tmp = OUT + ".tmp"
    with open(tmp, "w") as fh:
        json.dump(data, fh, separators=(",", ":"))
    os.chmod(tmp, 0o644)
    os.replace(tmp, OUT)
    print(f"recorded {len(accounts)} accounts, {len(data['samples'])} samples")


if __name__ == "__main__":
    main()

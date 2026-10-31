# Hub quota services

Runs on the hub host next to CLIProxyAPI (user systemd units). Python 3 standard library only.

- `recorder.py` (`quota-history.timer`, every 5 min): appends pooled quota samples to
  `~/quota-history/public/history.json` from hub data only. After a hub restart, an
  account with no reading repeats its last known one (`src: "carry"`) for up to 6 h.
- `resets.py` (`quota-resets.service`): spends Claude reset grants (`cedar_ember`) and
  Codex rate-limit reset credits before they expire. All upstream calls go through
  `POST /v8/management/requests/api-call`, so it never handles OAuth tokens.

## Reset policies

Per grant/credit (keyed by account + upstream id), falling back to `default_policy`:

- `expiry` (default): spend at `expires - 600 s`, retrying every minute until spent or
  expired. Claude grants only work while the account is at its limit, so a preflight
  that shows `not_limited` is logged and retried.
- `limit`: spend once hub signals (credential quota headers, claude-seat-pacer) show the
  account limited; preflight first, at most one attempt per grant per 10 min.
- `off`: never spend automatically.

Every claim is journalled to `~/quota-history/resets-state.json` (0600) before it is
sent. An unknown outcome is retried with the same request id for 10 min (idempotent
upstream); after that only a fresh read decides whether a new attempt is allowed.
Reads back off for 2 h after an upstream 429.

## Files

- `~/quota-history/public/resets.json`: public view (served by Tailscale at
  `/quota-history/resets.json`); no org ids, request ids, tokens or emails.
- `~/quota-history/resets-state.json`: private state, policies, org cache and journal.
- `~/quota-history/resets.log`: JSONL action log (rotated at ~1 MB).

## HTTP API

`127.0.0.1:8319`, paths with or without a `/quota-resets` prefix, JSON in and out.
Every request needs `Authorization: Bearer <management key>` (or `X-Quota-Resets-Key`).

- `GET /state`: same document as `resets.json`.
- `POST /policy` `{"grant": "<id>", "policy": "expiry|limit|off|default"}` or
  `{"default_policy": "expiry|limit|off"}`; add `"account": "<auth_index>"` if an id is
  shared by several accounts.
- `POST /spend` `{"grant": "<id>"}`: spend now (same preflight and journal rules).
- `POST /refresh`: re-read every account, at most once per 120 s (else 429 `retry_after`).

The dashboard reaches it through the hub:

```json
POST /v8/management/requests/api-call
{"method": "POST", "url": "http://127.0.0.1:8319/policy",
 "header": {"Authorization": "Bearer <management key>", "Content-Type": "application/json"},
 "data": "{\"grant\":\"<id>\",\"policy\":\"limit\"}"}
```

## Operating

```sh
./install.sh                      # copy scripts, install units, (re)start the service
python3 ~/quota-history/resets.py --plan   # planned actions, no spending
python3 -m unittest discover -s hub/quota-service -v
journalctl --user -u quota-resets -f
```

`install.sh` never touches the `cliproxyapi` unit.

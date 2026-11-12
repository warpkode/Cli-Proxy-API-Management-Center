# Hub quota services

Runs on the hub host next to CLIProxyAPI (user systemd units). Python 3 standard library only.

- `recorder.py` (`quota-history.timer`, every 5 min): appends pooled quota samples to
  `~/quota-history/public/history.json` from hub data only. After a hub restart, an
  account with no reading repeats its last known one (`src: "carry"`) for up to 6 h.
  Each account records `w` (weekly) and `f` (5-hour); Claude accounts that report a Fable
  limit also record `wf`, the raw Fable meter (0..100 over the half of the weekly limit
  that Fable may use). The quota page converts it to weekly points for its Fable view.
- `resets.py` (`quota-resets.service`): spends Claude reset grants (`cedar_ember`) and
  Codex rate-limit reset credits before they expire. All upstream calls go through
  `POST /v8/management/requests/api-call`, so it never handles OAuth tokens.

## Reset policies

Per grant/credit (keyed by account + upstream id), falling back to `default_policy`:

- `expiry` (default): start spending at `expires - 3600 s` (`QUOTA_RESETS_LEAD` overrides
  the lead) and keep trying until it is spent or expires: every 10 min, then every minute
  in the last 10 min. An hour gives a failed spend room to be retried; all an earlier
  spend gives up is what the account uses in that hour. A grant that needs the account
  at its limit, or a Codex credit with too little usage to reset (`nothing_to_reset`), is
  refused, logged as such and retried, since the account may get there in time.
- `limit`: spend once hub signals (credential quota headers, claude-seat-pacer) show the
  account limited; preflight first, at most one attempt per grant per 10 min.
- `off`: never spend automatically.

Every claim is journalled to `~/quota-history/resets-state.json` (0600) before it is
sent. An unknown outcome is retried with the same request id for 10 min (idempotent
upstream); after that a fresh read decides whether a new attempt is allowed, unless the
grant or named credit had a single reset left, where a new id cannot spend twice.

Only a lost reply, a 5xx or a 408/409/425 counts as unknown. Any other answer is recorded
for what it is, with its HTTP status and upstream code (never upstream text): `reset`,
`already_used`, `not_limited`, `cooldown`, `nothing_to_reset`, `no_credit`, `refused`
(another 4xx), and so on.

Reads back off for 2 h after an upstream 429. A spend does not wait for that: when the
preflight read fails, the last reading (up to 24 h old) stands in, because a claim names
its grant and upstream refuses one that is gone or not allowed. A Codex consume names its
credit (`credit_id`) for the same reason; if upstream rejects that form, the next attempt
goes back to the unnamed one. Each Claude account's organization id is looked up ahead of
time, so a claim never depends on a profile read at the last minute.

## Files

- `~/quota-history/public/resets.json`: public view (served by Tailscale at
  `/quota-history/resets.json`); no org ids, request ids, tokens or emails. Each grant
  carries a `blocker` when the last reading says it could not be spent automatically
  right now (`stale`, `ineligible`, `paused`, `not_usable`, `no_org`).
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
python3 ~/quota-history/resets.py --check  # rehearse every pending reset, no spending
python3 -m unittest discover -s hub/quota-service -v
journalctl --user -u quota-resets -f
```

`--check` runs each pending reset through the whole spend path as if it were due now
(preflight, eligibility, organization, journal, request) on a disarmed copy of the
service, and stops before the request is sent. It reuses the running service's hourly
reading instead of reading upstream again, and exits non-zero if any reset would not
have reached the request. The real spend call is the one step it cannot exercise.

`QUOTA_RESETS_DRY_RUN=1` in the unit's environment disarms the running service the same
way: it logs `dry_run` where it would have spent, and the page says so.

`install.sh` never touches the `cliproxyapi` unit.

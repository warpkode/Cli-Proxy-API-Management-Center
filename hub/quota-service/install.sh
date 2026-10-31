#!/usr/bin/env bash
# Install/refresh the quota recorder and reset scheduler for the current user.
# Idempotent. Never touches the cliproxyapi unit.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
dest="$HOME/quota-history"
units="$HOME/.config/systemd/user"

mkdir -p "$dest/public" "$units"
install -m 0755 "$here/recorder.py" "$dest/recorder.py"
install -m 0755 "$here/resets.py" "$dest/resets.py"
for unit in quota-history.service quota-history.timer quota-resets.service; do
  install -m 0644 "$here/systemd/$unit" "$units/$unit"
done

systemctl --user daemon-reload
systemctl --user enable --now quota-history.timer
systemctl --user enable quota-resets.service
# Pick up a new resets.py; the journal in resets-state.json survives restarts.
systemctl --user restart quota-resets.service
systemctl --user --no-pager --lines=0 status quota-resets.service

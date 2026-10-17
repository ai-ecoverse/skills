#!/usr/bin/env bash
# Run a CI gate and fail unless it printed its verdict line ("<name>: PASS ...")
# on stderr. stdin and stdout pass through, so it also works inside $(...).
# A gate that exits 0 silently (skipped main(), early exit) must not read as a pass.
set -uo pipefail

NAME=${1:?usage: expect-verdict.sh NAME COMMAND [ARGS...]}
shift
[[ $# -gt 0 ]] || { echo "usage: expect-verdict.sh NAME COMMAND [ARGS...]" >&2; exit 2; }

LOG=$(mktemp)
trap 'rm -f "$LOG"' EXIT

"$@" 2>"$LOG"
STATUS=$?
cat "$LOG" >&2
[[ $STATUS -eq 0 ]] || exit "$STATUS"
if ! grep -q "^$NAME: PASS" "$LOG"; then
  echo "expect-verdict: $NAME exited 0 without a '$NAME: PASS' verdict; failing the gate" >&2
  exit 1
fi

#!/usr/bin/env bash
# Deterministic test for speck.jsh against the mock runtime.
#   - No LLM, no network (just node for the mocks).
#   - Self-contained: generates a throwaway mock bin, cleans up on exit.
#   - Safe on a fresh checkout (does not depend on runs/ existing).
#   - Exits non-zero if any assertion fails — suitable for CI.
#
# Usage:  bash skills/speck/evals/test.sh
set -uo pipefail

EVALS_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$EVALS_DIR"

command -v node >/dev/null 2>&1 || { echo "ERROR: node is required to run the mock runtime"; exit 2; }

PASS=0; FAIL=0
ok()  { PASS=$((PASS+1)); printf '  \033[32mPASS\033[0m %s\n' "$1"; }
bad() { FAIL=$((FAIL+1)); printf '  \033[31mFAIL\033[0m %s\n       expected: %s\n       got:      %s\n' "$1" "$2" "$3"; }
assert_contains() { case "$2" in *"$3"*) ok "$1";; *) bad "$1" "output contains '$3'" "$2";; esac; }
assert_eq()       { if [ "$2" = "$3" ]; then ok "$1"; else bad "$1" "$3" "$2"; fi; }

# JSON helpers (read the mock's recorded state).
wh_count()  { node -e "console.log(require('$STATE/webhooks.json').length)"; }
wh_scoop()  { node -e "const w=require('$STATE/webhooks.json');console.log((w[0]||{}).scoop||'')"; }
last_inject_file() {
  node -e "const fs=require('fs');const c=fs.readFileSync('$STATE/calls.jsonl','utf8').trim().split('\n').filter(Boolean).map(JSON.parse).filter(x=>x.kind==='inject');console.log((c.pop()||{}).filePath||'')"
}

ID="selftest-$$"
BIN="$(./mock/make-eval-bin.sh "$ID")"
STATE="$(dirname "$BIN")/state"
trap 'rm -rf "$EVALS_DIR/runs/iteration-1/eval-$ID"' EXIT

echo "speck.jsh — deterministic mock tests"
echo "===================================="

# --- CLI surface -----------------------------------------------------------
OUT="$("$BIN/speck" --help)"; RC=$?
assert_contains "--help prints usage"            "$OUT" "speck inject"
assert_eq       "--help exits 0"                 "$RC" "0"
"$BIN/speck" >/dev/null 2>&1; RC=$?
assert_eq       "no command exits non-zero"      "$RC" "1"

# --- inject with --file ----------------------------------------------------
OUT="$("$BIN/speck" inject 100 --file /shared/acme/prototype/index.html)"
assert_contains "inject reports injected"        "$OUT" "speck injected (lick-enabled)"
assert_contains "inject echoes the file path"    "$OUT" "File: /shared/acme/prototype/index.html"
assert_eq       "exactly one webhook created"    "$(wh_count)" "1"
assert_eq       "webhook routes to speck-worker" "$(wh_scoop)" "speck-worker"
assert_eq       "--file reaches injected script" "$(last_inject_file)" "/shared/acme/prototype/index.html"

# --- re-inject guard + webhook reuse ---------------------------------------
OUT="$("$BIN/speck" inject 100 --file /shared/acme/prototype/index.html)"
assert_contains "re-inject is idempotent"        "$OUT" "already injected"
"$BIN/speck" inject 200 --file /x >/dev/null   # different tab, separate invocation
assert_eq       "webhook reused, not duplicated" "$(wh_count)" "1"

# --- bare inject omits the File line ---------------------------------------
OUT="$("$BIN/speck" inject 300)"
case "$OUT" in
  *"File:"*) bad "bare inject omits File line" "no 'File:' line" "$OUT";;
  *)         ok  "bare inject omits File line";;
esac

# --- collect ---------------------------------------------------------------
node -e "const fs=require('fs');const p='$STATE/tabs.json';const t=JSON.parse(fs.readFileSync(p));t['400']={injected:true,annotations:[{instruction:'make bigger',element:{tag:'h2'}}]};fs.writeFileSync(p,JSON.stringify(t))"
OUT="$("$BIN/speck" collect 400)"
assert_contains "collect returns seeded notes"   "$OUT" "make bigger"
OUT="$("$BIN/speck" collect 999)"
assert_contains "collect on clean tab -> []"     "$OUT" "[]"

# --- remove ----------------------------------------------------------------
OUT="$("$BIN/speck" remove 100)"
assert_contains "remove tears down overlay"      "$OUT" "speck removed"
OUT="$("$BIN/speck" remove 100)"
assert_contains "remove on clean tab -> notfound" "$OUT" "speck not found"

# --- reload drops the overlay; re-inject is needed -------------------------
"$BIN/speck" inject 500 --file /x >/dev/null
"$BIN/playwright-cli" goto file:///x --tab 500 >/dev/null
OUT="$("$BIN/speck" inject 500 --file /x)"
assert_contains "goto drops overlay; re-inject ok" "$OUT" "speck injected (lick-enabled)"

echo "------------------------------------"
printf 'PASS: %d   FAIL: %d\n' "$PASS" "$FAIL"
if [ "$FAIL" -ne 0 ]; then echo "TESTS FAILED"; exit 1; fi
echo "ALL TESTS PASSED"

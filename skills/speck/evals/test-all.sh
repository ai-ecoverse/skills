#!/usr/bin/env bash
# Run the full speck test suite: the deterministic mock/speck.jsh checks first,
# then the LLM-driven behavioral evals.
#
# Phase 1 (test.sh)      — fast, free, deterministic. The correctness gate.
# Phase 2 (run-evals.sh) — LLM-driven via `claude -p`; costs tokens, non-deterministic.
#
# By default, if Phase 1 fails the suite stops before spending tokens on Phase 2
# (a broken skill won't eval meaningfully). Exit code is non-zero if either phase
# fails.
#
# Usage:
#   bash skills/speck/evals/test-all.sh            # both phases, all 7 evals
#   bash skills/speck/evals/test-all.sh 5 7        # both phases, only evals 5 and 7
#   DETERMINISTIC_ONLY=1 bash .../test-all.sh      # Phase 1 only (no tokens)
#   RUN_EVALS_ALWAYS=1   bash .../test-all.sh      # run Phase 2 even if Phase 1 fails
#   CLAUDE_MODEL=claude-opus-4-8 bash .../test-all.sh
set -uo pipefail

EVALS_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$EVALS_DIR"

hr() { printf '═%.0s' $(seq 1 60); echo; }

hr; echo "PHASE 1 — deterministic mock + speck.jsh checks (test.sh)"; hr
bash test.sh
rc_test=$?
echo

if [ "$rc_test" -ne 0 ] && [ -z "${RUN_EVALS_ALWAYS:-}" ]; then
  echo "Phase 1 failed (exit $rc_test) — skipping Phase 2 to avoid spending tokens"
  echo "on a broken skill. Set RUN_EVALS_ALWAYS=1 to run the evals anyway."
  exit "$rc_test"
fi

if [ -n "${DETERMINISTIC_ONLY:-}" ]; then
  echo "DETERMINISTIC_ONLY set — skipping Phase 2 (LLM evals)."
  exit "$rc_test"
fi

hr; echo "PHASE 2 — LLM behavioral evals (run-evals.sh)"; hr
bash run-evals.sh "$@"
rc_evals=$?
echo

hr
echo "SUMMARY"
echo "  Phase 1 (deterministic): $([ "$rc_test"  -eq 0 ] && echo PASS || echo "FAIL (exit $rc_test)")"
echo "  Phase 2 (LLM evals):     $([ "$rc_evals" -eq 0 ] && echo PASS || echo "FAIL (exit $rc_evals)")"
hr

[ "$rc_test" -eq 0 ] && [ "$rc_evals" -eq 0 ] && exit 0
exit 1

#!/usr/bin/env bash
# Usage: make-eval-bin.sh <eval-id>
# Creates an isolated bin/ + state/ for one eval. Each command shim hardcodes
# its own SPECK_MOCK_STATE so the subagent can call them by absolute path
# without relying on env vars persisting across separate shell invocations.
set -euo pipefail

# Layout: this script lives at skills/speck/evals/mock/ ; the skill is two
# levels up; run output goes under evals/runs/ (gitignored).
MOCK_DIR="$(cd "$(dirname "$0")" && pwd)"
SKILL_DIR="$(cd "$MOCK_DIR/../.." && pwd)"
EVALS_DIR="$(cd "$MOCK_DIR/.." && pwd)"
ID="$1"
EVAL_DIR="$EVALS_DIR/runs/iteration-1/eval-$ID"
BIN="$EVAL_DIR/bin"
STATE="$EVAL_DIR/state"

mkdir -p "$BIN" "$STATE"
echo '[]' > "$STATE/webhooks.json"
echo '{}' > "$STATE/tabs.json"
echo '{}' > "$STATE/scoops.json"
: > "$STATE/calls.jsonl"

# Node-based mock commands: shim exports its hardcoded state, then runs the .mjs.
for cmd in webhook playwright-cli scoop chat sprinkle; do
  cat > "$BIN/$cmd" <<EOF
#!/usr/bin/env bash
export SPECK_MOCK_STATE="$STATE"
exec node "$MOCK_DIR/$cmd.mjs" "\$@"
EOF
  chmod +x "$BIN/$cmd"
done

# `speck` shim: put the eval bin on PATH (so speck.jsh's internal exec() of
# webhook/playwright-cli resolves to the mocks) and run the REAL speck.jsh.
cat > "$BIN/speck" <<EOF
#!/usr/bin/env bash
export SPECK_MOCK_STATE="$STATE"
export PATH="$BIN:\$PATH"
exec node "$MOCK_DIR/jsh-runner.mjs" "$SKILL_DIR/speck.jsh" "\$@"
EOF
chmod +x "$BIN/speck"

echo "$BIN"

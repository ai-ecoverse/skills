#!/usr/bin/env bash
# Run the 7 speck behavioral eval cases headlessly via the `claude` CLI, then grade.
#
# For each eval it: (1) generates an isolated mock bin, (2) seeds that eval's
# starting state, (3) runs `claude -p` with the mock-adapter prompt + the eval's
# user prompt so Claude follows skills/speck/SKILL.md against the mock, recording
# the commands it runs into state/calls.jsonl and its answer into state/report.txt,
# then (4) runs grade.py over all of them.
#
# Unlike test.sh, this is LLM-driven: it requires `claude` auth, spends tokens,
# and is NON-DETERMINISTIC — grades can vary run to run. Gate CI on it with that
# in mind (or use test.sh for the deterministic guarantees).
#
# Usage:
#   bash skills/speck/evals/run-evals.sh            # all 7
#   bash skills/speck/evals/run-evals.sh 5 7        # just evals 5 and 7
#   CLAUDE_MODEL=claude-opus-4-8 bash .../run-evals.sh
set -uo pipefail

EVALS_DIR="$(cd "$(dirname "$0")" && pwd)"
SKILL_DIR="$(cd "$EVALS_DIR/.." && pwd)"
cd "$EVALS_DIR"

command -v node   >/dev/null 2>&1 || { echo "ERROR: node is required";   exit 2; }
command -v claude >/dev/null 2>&1 || { echo "ERROR: the 'claude' CLI is required (Claude Code)"; exit 2; }
command -v python3 >/dev/null 2>&1 || { echo "ERROR: python3 is required"; exit 2; }

IDS=("$@"); [ ${#IDS[@]} -eq 0 ] && IDS=(1 2 3 4 5 6 7)
MODEL_ARG=(); [ -n "${CLAUDE_MODEL:-}" ] && MODEL_ARG=(--model "$CLAUDE_MODEL")

# Seed values reused across evals.
WH='[{"name":"speck-lick","url":"https://mock.local/webhook/speck-lick","scoop":"speck-worker"}]'
SC='{"speck-worker":{"name":"speck-worker","writablePaths":["/scoops/speck-worker-scoop/","/shared/","/tmp/"],"instructions":"Read target file; locate element by selector/snippet; apply instruction as edit; reload via playwright-cli goto; re-inject via speck inject <tabId> --file <path>."}}'

# Per-eval prompt (kept in sync with evals.json) and starting state.
prompt_for() {
  case "$1" in
    1) echo "I've got my prototype open in a browser tab (tab 1218556234, serving /shared/acme/prototype/index.html). I want to click around the page and leave notes on individual elements so they get fixed automatically. Set that up for me.";;
    2) echo "Speck's already wired up. Just turn the annotation layer back on for tab 1218556234 — I'm editing /shared/acme/prototype/index.html.";;
    3) echo "Show me the notes I left on tab 1218556234 — I want to see them as a list before I keep going.";;
    4) echo "Okay I'm done marking things up on tab 1218556234. Take the overlay off so the page is back to normal.";;
    5) echo "Can you add speck to https://www.nytimes.com so I can annotate elements on their homepage?";;
    6) echo "I just submitted an instruction on an element and the speck-worker applied the edit and reloaded the page — but now I can't hover-highlight anything anymore. What happened and how do I keep annotating? (tab 1218556234, file /shared/acme/prototype/index.html)";;
    7) echo "The speck overlay feels janky — can we add a little status panel in the extension rail that shows 'editing…' / 'done' while the worker is applying each change?";;
  esac
}

seed_state() {
  local id="$1" state="$2"
  case "$id" in
    2|6) # already wired up (scoop + webhook exist), overlay currently off
      printf '%s' "$WH" > "$state/webhooks.json"
      printf '%s' "$SC" > "$state/scoops.json"
      printf '{"1218556234":{"injected":false,"annotations":[]}}' > "$state/tabs.json" ;;
    3)   # overlay on, two annotations already left
      printf '%s' '{"1218556234":{"injected":true,"annotations":[{"instruction":"make this heading larger","element":{"tag":"h2","class":"section-title","text":"Latest News","selector":"section:nth-of-type(3) > h2"},"file":"/shared/acme/prototype/index.html","tabId":"1218556234"},{"instruction":"change CTA to Sign up free","element":{"tag":"a","class":"cta","text":"Get started","selector":".hero > a"},"file":"/shared/acme/prototype/index.html","tabId":"1218556234"}]}}' > "$state/tabs.json" ;;
    4)   # overlay on, ready to remove
      printf '{"1218556234":{"injected":true,"annotations":[]}}' > "$state/tabs.json" ;;
    *)   : ;; # 1,5,7 start clean (make-eval-bin.sh already wrote empty state)
  esac
}

# The mock-adapter prompt: maps platform primitives to the eval's mock CLIs and
# tells Claude to follow the skill. It is deliberately neutral — it never reveals
# the assertions or the "right" answer (important for the guardrail evals 5/6/7).
build_prompt() {
  local bin="$1" user="$2"
  cat <<EOF
You are testing a Claude skill in a MOCK runtime. Behave exactly as you would for a real user request.

The skill is at $SKILL_DIR/SKILL.md — read it (you may also read $SKILL_DIR/speck.jsh). Follow it.

This environment mocks the skill's platform. The platform primitives are exposed ONLY as these CLI commands; call them by absolute path:
- $bin/speck inject|collect|remove <tabId> [--file <path>]
- $bin/scoop create <name> [--writable <path> ...]
- $bin/scoop feed <name> "<instructions text>"
- $bin/webhook list   (and: $bin/webhook create --scoop <name> --name <name>)
- $bin/playwright-cli goto <url> --tab <tabId>
- $bin/chat send "<message>"
- $bin/sprinkle create <name>

Notes:
- The skill mentions scoop_scoop(...) and feed_scoop(...); those map to 'scoop create' and 'scoop feed' here.
- Use ONLY these mock commands for platform actions. Do not attempt other tools/MCPs.
- Do NOT read evals.json, grade.py, run-evals.sh, or any state/grading files under the evals/ tree. Treat this as a genuine task.
- Actually RUN the commands needed to fulfill the request. If you determine the request should NOT be carried out, run none and explain why.

End your reply with:
## What I did
(the exact commands you ran and a short why for each — or note you intentionally ran none)
## Answer to user
(what you'd tell the user)

USER REQUEST:
$user
EOF
}

echo "Running speck evals: ${IDS[*]}"
echo "model: ${CLAUDE_MODEL:-<default>}"
echo

for id in "${IDS[@]}"; do
  user="$(prompt_for "$id")"
  if [ -z "$user" ]; then echo "skip: no prompt for eval-$id"; continue; fi
  bin="$(./mock/make-eval-bin.sh "$id")"          # fresh bin + empty state
  state="$(dirname "$bin")/state"
  seed_state "$id" "$state"
  echo "── eval-$id ── running claude -p ..."
  # --allowedTools lets the headless agent run the mock commands (Bash) and read
  # the skill (Read) without interactive prompts. If your install still blocks
  # tool use here, swap in --dangerously-skip-permissions (this is an isolated mock).
  # ${arr[@]+...} guards against "unbound variable" when the array is empty
  # (bash 3.2 / set -u, e.g. stock macOS).
  build_prompt "$bin" "$user" \
    | claude -p ${MODEL_ARG[@]+"${MODEL_ARG[@]}"} --allowedTools "Bash Read" \
        > "$state/report.txt" 2> "$state/claude.err"
  rc=$?
  if [ $rc -ne 0 ]; then
    echo "   WARN: claude exited $rc (see $state/claude.err)"
  else
    echo "   done ($(wc -l < "$state/calls.jsonl" | tr -d ' ') commands recorded)"
  fi
done

echo
echo "Grading ..."
python3 grade.py
exit $?

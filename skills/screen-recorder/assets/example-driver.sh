#!/bin/sh
# Example driver / clue script for the recording-setup sprinkle.
#
# Runs ONCE when the recording starts (concurrently with the recorders, after the
# countdown begins). Everything here happens while the screen is being captured,
# so each command is a beat in the finished video.
#
# Env provided by the sprinkle (all optional — always guard with a default):
#   REC_TAB     playwright target id of the selected tab, e.g. A1B2C3...
#   REC_DIR     the capture folder, e.g. /workspace/captures/2026-09-17T11-12-13
#   REC_W/REC_H forced tab size, if the user set one
#
# MEASURED GOTCHAS (2026-09-17, SLICC 6.163.0):
#  * `say` REQUIRES -l <BCP47>: a bare `say "hi"` exits 1 with
#    "-l language tag is required". It ALSO needs the on-device voice model
#    (`say --warmup`, check `say --status`) or it exits 1 with "voice not ready".
#    So every say line here is wrapped in `narrate()` which never fails the script.
#  * A failing LAST command sets the script's exit code — that is how an unguarded
#    `say` at the end silently turned this whole script into rc=1.
#  * `screencapture` is wedged in this build (slicc#3233) -> use playwright-cli.
#  * NEVER use --max-width/--hires: they render at scroll offset 0 (slicc#3232).

TAB="${REC_TAB:-}"
DIR="${REC_DIR:-/tmp}"

# Speak if possible, never fail the recording because TTS is unavailable.
narrate() {
  say -l en-US "$1" >/dev/null 2>&1 || true
}

narrate "Starting the demo"

# Guard every tab command: with no tab selected this script must still succeed.
if [ -n "$TAB" ]; then
  playwright-cli goto "https://www.sliccy.ai" --tab="$TAB" >/dev/null 2>&1 || true
  sleep 3

  # Hero frame 1 — the landing state. Native size, then downscale later if needed.
  playwright-cli screenshot --tab="$TAB" --filename="$DIR/hero-1.png" >/dev/null 2>&1 || true

  narrate "Scrolling down"
  playwright-cli eval "scrollTo(0, 800); 'ok'" --tab="$TAB" >/dev/null 2>&1 || true
  sleep 2

  # Hero frame 2 — scrolled state
  playwright-cli screenshot --tab="$TAB" --filename="$DIR/hero-2.png" >/dev/null 2>&1 || true
fi

narrate "Demo complete"

# Always succeed: the recording must not be judged by the driver's exit code.
exit 0

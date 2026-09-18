# Driver / clue scripts

A driver script runs ONCE when a `recording-setup` recording starts — concurrently
with the recorders, right as the countdown begins. Everything it does happens on
camera, so each command is a beat in the finished video.

## Contract

Environment the sprinkle provides (all optional — always guard with a default):

| var | meaning |
|---|---|
| `REC_TAB` | playwright target id of the selected tab (empty if none) |
| `REC_DIR` | the capture folder, e.g. `/workspace/captures/2026-09-17T11-12-13` |
| `REC_W` / `REC_H` | forced tab size, if set |

Rules that matter:

1. **Always `exit 0`.** A failing LAST command becomes the script's exit code, and
   the recording should never be judged by the driver's exit status.
2. **Guard every tab command** with `if [ -n "$TAB" ]`, so a run with no selected
   tab still succeeds.
3. **Suffix risky commands with `|| true`.**

## Measured gotchas (2026-09-17, SLICC 6.163.0)

- **`say` requires `-l <BCP47>`.** A bare `say "hi"` exits 1 with
  `say: -l language tag is required`. It additionally needs the on-device voice
  model — otherwise `say: on-device voice not ready — run say --warmup and retry`.
  Check with `say --status`; ours reports `not downloaded`. Wrap TTS in a helper
  that cannot fail:
  ```sh
  narrate() { say -l en-US "$1" >/dev/null 2>&1 || true; }
  ```
  This is exactly how an unguarded trailing `say` silently turned the first version
  of `example-driver.sh` into `rc=1` with no output at all.
- **`screencapture` is wedged** in this build (`Invalid state`, slicc#3233). Use
  `playwright-cli screenshot` for hero frames.
- **Never use `--max-width` or `--hires`** on `playwright-cli screenshot`: they
  render at scroll offset 0 (slicc#3232). Capture native, downscale afterwards.

## Verified example

`example-driver.sh` — measured rc=0 both with and without `REC_TAB`, and with a tab
it produced two distinct hero frames (2400x1428, 155 KB and 142 KB) in ~7 s.

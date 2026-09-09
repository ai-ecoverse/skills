---
name: adb
description: >
  Control an Android phone or tablet over USB directly from SLICC — list devices, run shell
  commands, capture the screen, and pull files — by speaking the ADB wire protocol over WebUSB.
  No host `adb` binary, no adb server, no MCP bridge. Use when the user mentions adb, Android,
  a connected phone or tablet, Pixel, Samsung, Motorola, moto, OnePlus, Xiaomi, a USB-connected
  device, device screenshots, screen capture from a phone, running a shell command on a phone,
  pulling a file off a phone, checking getprop, dumpsys, logcat, installed packages, or wants to
  automate, inspect, script, mirror, watch, stream, or drive an Android device's screen. Triggers on phrases like "connect to my
  phone", "run this on my phone", "screenshot my phone", "adb shell", "adb devices",
  "what's on my Android", "pull that file off my phone", "control my Android",
  "mirror my phone", "show me my phone screen", "stream my phone".
allowed-tools: bash
command: adb
script: scripts/adb.jsh
---

# adb Skill

An ADB client implemented in the SLICC realm. It speaks the ADB wire protocol
(`CNXN` / `AUTH` / `OPEN` / `OKAY` / `WRTE` / `CLSE`) straight down a WebUSB bulk
pipe, so there is no host `adb` binary and no adb server in the loop — SLICC *is*
the ADB host.

## Usage

```
adb devices                    List granted USB devices exposing an ADB interface
adb connect                    Authenticate and print the device banner
adb shell <command...>         Run a shell command, print its output
adb screencap <out.png>        Capture the framebuffer to a VFS path
adb pull <remote> <local>      Copy a file off the device (binary-safe)

sprinkle open phone-view       Live screen viewer with tap and key input
```

Flags — `--serial <s>` to pick a device, `--key <path>` for the signing key,
`--json` for machine-readable output, `--timeout <ms>` per transfer,
`--no-reset` to skip the USB reset on connect.

**Flags must precede the subcommand**, as with real adb (`adb --serial X shell
…`). Everything after the subcommand is passed through untouched, so
`adb shell pm list packages --user 10` sends `--user 10` to the device rather
than parsing it here.

`adb shell` reports the device-side exit status as its own and keeps stderr
separate from stdout; `--json` returns `{command, stdout, stderr, exitCode}`.

## Live screen viewer

`sprinkle open phone-view` opens a panel that mirrors the device and lets you
drive it — click the canvas to tap, plus Home / Back / Recents buttons. Input
travels over the same ADB connection as the video. Connect stays disabled while
connecting or disconnecting; after Stop or the end of the stream, it becomes
available once interface release and device close finish.

The device H.264-encodes its own display (`screenrecord --output-format=h264`),
the frames arrive over the same WebUSB pipe as everything else, and WebCodecs
decodes them to a canvas. No host `adb`, no intermediate server, no file on the
device.

**A still screen produces almost no frames.** `screenrecord` captures from
SurfaceFlinger, which only produces buffers when something actually changes, so
a motionless home screen legitimately sits at one frame after the initial
keyframe. The status line shows a running frame and byte count so that reads as
idle rather than broken.

Requires SLICC **6.135.0+** — sprinkles could not perform USB transfers before
that, only `list`/`request`/`open`/`close`.

## Setup

1. **Grant the device.** `usb request` needs a real user gesture — run it from the
   shell yourself and pick the phone in Chrome's chooser. `adb devices` confirms
   it afterwards.
2. **Enable USB debugging** on the phone (Settings → System → Developer options).
   Developer options first has to be unlocked by tapping *Build number* seven
   times under About phone.
3. **Provide a signing key** at `/workspace/.adb/adbkey`, PKCS#8 PEM. Two options:
   - Copy the host's `~/.android/adbkey` to inherit its existing authorization —
     the device already trusts it, so no on-device prompt appears.
   - **A key the device does not already trust will not work.** Enrolling one
     needs the `AUTH RSAPUBLICKEY` frame, which this client does not send, so
     no on-device approval prompt appears — retrying cannot help (see
     Limitations).

   Override the path with `--key`, or persist one via skill config (`keyPath`).

## How auth works

The device answers `CNXN` with an `AUTH` challenge carrying a 20-byte token. ADB
signs that token as though it were a SHA-1 digest: raw PKCS#1 v1.5 with the SHA-1
`DigestInfo` prefix and **no further hashing**. Web Crypto cannot sign a
pre-computed digest, so the script parses the PKCS#8 key to `{n, d}` and does the
modular exponentiation with `BigInt` directly.

## Security

The signing key is an ADB identity: anything holding it can drive any device that
has authorized it. Putting `~/.android/adbkey` in the VFS copies that identity
into SLICC's IndexedDB, where any scoop with read access to `/workspace` can read
it. Prefer a dedicated key you can revoke on the device independently. The script
never prints key material.

`adb shell` and `adb pull` interpolate into a real device-side shell. `pull`
single-quote-escapes its path; `shell` passes the command through verbatim by
design, so treat it exactly like a local shell — never hand it unvalidated input.

## Limitations

- **No `AUTH RSAPUBLICKEY` enrollment** — an unauthorized key fails with an
  actionable error rather than raising the on-device prompt. Adding it needs
  ADB's custom public-key encoding (`n0inv` and `rr` Montgomery parameters).
- **No `push`, no `install`, no `logcat -f`** — those need the `sync:` protocol
  or long-lived streams. `pull` uses `cat` over shell-v2 instead of `sync:`:
  binary-safe, far simpler, and the shell-v2 exit frame is what makes a failed
  read detectable, so a missing path errors instead of writing the error text
  over your local file. Devices that do not advertise `shell_v2` (pre-Android
  7) therefore cannot use `pull`, and `shell` on them reports no exit status.
- **Output is buffered, not streamed** — `.jsh` stdout is delivered on
  completion, so long-running commands print nothing until they finish.
- **Chromium only.** WebUSB is unavailable in the cloud / hosted-leader float.
- **The viewer renders in SLICC, not at a URL.** Frames are decoded in the
  browser that holds the USB grant, so there is nothing to hand to someone else.
  Sharing a link would need a host-side bridge that re-serves the stream.
- **The viewer holds the interface for as long as it streams**, so `adb shell`
  and friends cannot run at the same time from the realm. Use the viewer's own
  buttons, which share its connection.
- **Stop the host adb server first** (`adb kill-server`). It claims the ADB
  interface exclusively. The USB reset on connect does free it, but the host
  server re-claims it the moment the device re-enumerates, so leaving it running
  makes calls fail intermittently with a busy interface. With `--no-reset` it
  blocks the claim outright.

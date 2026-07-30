---
name: v86
description: >-
  Boot and drive x86 virtual machines inside SLICC with the built-in `v86`
  shell command (v86 wasm engine — no KVM, no server). Use when the user asks
  to "run a VM", "boot Linux/Alpine/FreeDOS/KolibriOS/Arch", "start a virtual
  machine", "run an ISO / disk image / floppy", "emulate x86 / DOS", "install
  an OS", "test something in a VM", or wants an isolated guest OS with a
  screen they can watch. Covers installing the engine and BIOS blobs,
  downloading guest images, attaching devices (-cdrom, -hda, -fda, -kernel,
  -state, -fs9p, -net), the type/key/mouse/screenshot/text interaction loop,
  guest networking through the fetch relay, live screen streaming, and
  state snapshots. Triggers on "v86", "qemu", "virtual machine", "boot an
  ISO", "DOS game", "retro OS", "Alpine VM".
allowed-tools: bash
---

# v86 — x86 virtual machines in SLICC

The `v86` shell command boots x86 guests (ISO, raw disk, floppy, saved state, or a direct Linux kernel) on the [v86](https://github.com/copy/v86) wasm engine, entirely in the browser. VMs run as named background units — `ps` shows them, `kill <pid>` powers them off — and every subcommand accepts `-n <name>` (default `vm0`).

**v86 emulates a 32-bit x86 CPU.** Use i686/x86 guest images, never x86_64. No KVM: expect a fraction of native speed — small guests (Alpine, FreeDOS, Buildroot, KolibriOS) work best, and slow boots need patience.

## 1. Install the engine and BIOS

Nothing is bundled and there is no CDN fallback. One-time setup:

```bash
ipk add v86@0.5.424
mkdir -p /workspace/.v86
curl -o /workspace/.v86/seabios.bin https://raw.githubusercontent.com/copy/v86/master/bios/seabios.bin
curl -o /workspace/.v86/vgabios.bin https://raw.githubusercontent.com/copy/v86/master/bios/vgabios.bin
```

`/workspace/.v86/{seabios,vgabios}.bin` is the default BIOS location; override with `-bios` / `-vgabios`. Missing pieces produce an actionable error containing these exact commands.

**Where BIOS blobs come from:** [copy/v86's `bios/` directory](https://github.com/copy/v86/tree/master/bios) is the canonical source — prebuilt SeaBIOS + Bochs VGABIOS, exactly what the emulator is tested against (the curl lines above). The same directory has debug variants; upstream [SeaBIOS](https://www.seabios.org/) and Bochs builds also work, but there is no reason to stray.

## 2. Get a guest image

Download images into the VFS with `curl` (SLICC's fetch proxy bypasses CORS):

```bash
# Alpine Linux — 32-bit "virt" ISO (~60 MB), boots to login: root, no password
curl -o /workspace/alpine.iso https://dl-cdn.alpinelinux.org/alpine/v3.22/releases/x86/alpine-virt-3.22.2-x86.iso

# Pre-booted Arch Linux state from copy.sh (~15 MB) — resumes straight into a root shell
curl -o /tmp/arch_state.bin.zst https://i.copy.sh/arch_state-v3.bin.zst
```

FreeDOS floppy/disk images and KolibriOS (`kolibri.img`) also work well. For the newest Alpine instead of the pinned one above, list https://dl-cdn.alpinelinux.org/alpine/latest-stable/releases/x86/ and pick the current `alpine-virt-*-x86.iso` filename.

### Finding compatible software

- **Start with the tested list.** copy/v86's README ["Compatibility" section](https://github.com/copy/v86#compatibility) enumerates OSes known to boot (Alpine, Arch, Damn Small Linux, Buildroot, FreeDOS, KolibriOS, ReactOS, Haiku, 9front, Windows 9x/2000/XP-era, BSDs…), and the [copy.sh/v86 demo page](https://copy.sh/v86/) links the exact images it runs — the ones hosted at `https://i.copy.sh/` (e.g. the Arch state above) can be curled directly.
- **Selection rules of thumb:** 32-bit i686/x86 build (never x86_64); small footprint (≤512 MiB RAM, ideally a few hundred MB of disk); era-appropriate drivers — IDE disks, NE2000 or virtio NIC, VGA/VESA graphics. Anything needing modern ACPI-heavy kernels, SSE4+, or GPU acceleration will crawl or fail.
- **Distro archives:** Alpine keeps every release series under a permanent `https://dl-cdn.alpinelinux.org/alpine/vX.Y/releases/x86/` directory; other distros that still ship an i686 port (Debian, Void, Tiny Core, Slackware) have similar archive layouts.
- **Retro OSes and DOS software:** the [Internet Archive's software collections](https://archive.org/details/software) host bootable floppy/CD images (FreeDOS apps, Win9x-era ISOs, DOS games) — download the raw `.img`/`.iso`, not an emulator-wrapped bundle.
- **Verify before a long boot:** check the image is 32-bit (e.g. the filename/release page says `x86`, `i686`, or `i386`) — catching an x86_64 image up front beats waiting out a hung boot.

## 3. Boot: devices and flags (QEMU-flavored)

```bash
v86 start -cdrom /workspace/alpine.iso                # ISO boot (prints pid)
v86 start -n dos -fda freedos.img -m 64               # named VM, floppy, 64 MiB RAM
v86 start -hda disk.img -boot c                       # raw hard disk image
v86 start -kernel bzImage -initrd rootfs.img -append "console=ttyS0" -nographic
v86 ls                                                # list running VMs
v86 stop -n dos --force                               # power off (--force hard-kills)
```

| Flag | Meaning |
|---|---|
| `-n <name>` | VM name (default `vm0`) |
| `-m <MiB>` | Guest RAM — default 128, max 512 |
| `-cdrom` / `-hda` / `-fda` | ISO / raw disk / floppy (VFS paths) |
| `-boot a\|c\|d` | Boot order: floppy / disk / CD |
| `-kernel -initrd -append` | Direct Linux boot |
| `-state <file>` | Resume a saved snapshot (`.zst` decompresses in-engine) |
| `-fs9p <url>` | Network-backed 9p filesystem (guest root=host9p) |
| `-net <ne2k\|virtio>[,relay=fetch]` | Guest NIC — must match a `-state` snapshot's NIC |
| `-vga <MiB>` | SVGA/VBE video memory — default 8 (≤1600x1200x32), max 64 |
| `-nographic` | Serial-only guest, skip VGA |

### Fastest full Linux: the copy.sh Arch snapshot

```bash
v86 start -n arch -state /tmp/arch_state.bin.zst -fs9p https://i.copy.sh/arch/ -net virtio -m 512
v86 text -n arch                    # → root@localhost prompt, no boot wait
```

`-fs9p` fetches the guest's files on demand; `-net virtio` matches the NIC the snapshot was saved with.

## 4. Interaction loop: look, then act

The VM is not an interactive foreground process. Poll the screen between actions:

```bash
v86 text                          # text-mode screen as plain text — prefer this
v86 screenshot /tmp/vm.png        # VGA framebuffer → PNG (graphical guests)
v86 type "root\n"                 # type on the keyboard ('\n' = Enter)
v86 key ctrl-alt-del enter f2     # named chords: enter, tab, esc, f1..f12, ctrl-c, alt-tab, ...
v86 mouse move 20 -5              # relative pointer move
v86 mouse click right --double    # left|middle|right, optional --double
v86 mouse --to 320,240            # best-effort absolute positioning
v86 serial --send "ls\n"          # write to the guest serial console
v86 serial --tail 25              # read buffered serial output
```

- `v86 text` is cheaper and machine-readable — use `screenshot` only for graphical guests.
- For `-nographic` guests, use the `serial` subcommands.
- Mouse positioning without guest absolute-pointer support: home the cursor first with a huge relative move (`v86 mouse -n <name> move -2000 -2000`), then move by known deltas.

## 5. Guest networking (fetch relay)

`-net <model>,relay=fetch` gives the guest outbound HTTP with no gateway: the relay answers guest DNS in-engine and turns guest port-80 connections into host fetches through SLICC's CORS-bypassing proxy. Plain-http requests to external hosts are upgraded to https upstream (`http://localhost` stays local); the guest itself only ever speaks HTTP on port 80.

```bash
v86 start -n kolibri -fda kolibri.img -net ne2k,relay=fetch -m 128
```

Inside the guest, configure a static IP on the relay subnet — VM `192.168.86.100`, router/DNS `192.168.86.1` (e.g. `ip addr add` on Linux, NETCFG on KolibriOS). Then the guest can browse `http://example.com/...`.

## 6. Live screen streaming (watchable by the human)

`v86 serve` pumps the screen into `/tmp/v86-serve-<name>/` (self-refreshing `index.html`, live `frame.png` / `screen.txt` / `state.json`). Mint an iframe-able URL with the regular `serve` command:

```bash
v86 serve -n arch --fps 4        # 1-10 fps, default 2
serve /tmp/v86-serve-arch        # → worker-hosted preview URL to share/iframe
v86 serve -n arch --stop         # stop the pump (directory stays)
```

## 7. State snapshots

```bash
v86 state -n arch save /workspace/arch-ready.bin    # full VM state
v86 state -n arch load /workspace/arch-ready.bin
```

Save a snapshot right after a slow boot or login, then future runs resume instantly with `v86 start -state <file>` — remember to pass the same `-net` model the snapshot was saved with.

## Pitfalls

- ❌ x86_64 images — v86 is 32-bit only. ✅ i686/x86 builds (Alpine `x86`, not `x86_64`).
- ❌ Screenshotting a text-mode guest. ✅ `v86 text` — cheaper, greppable.
- ❌ Typing immediately after `v86 start`. ✅ Poll `v86 text` until the prompt appears; wasm emulation is slow.
- ❌ Resuming a `-state` snapshot with a different `-net` model than it was saved with.
- ❌ Assuming guest DNS/DHCP just works. ✅ With `relay=fetch`, set the static IP (`192.168.86.100`, gw `192.168.86.1`) inside the guest.
- ❌ Expecting https or non-80 ports from the guest. ✅ Guest speaks port-80 HTTP; the relay upgrades to https upstream.
- High-res VESA modes need more video memory — boot with `-vga 16` before blaming the guest.

## Reference

`v86 --help` prints the full flag surface. Engine: [copy/v86](https://github.com/copy/v86), pinned at `0.5.424` via `ipk`.

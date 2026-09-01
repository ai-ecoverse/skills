# Snapshots: sourcing, importing, and building your own

A vpod snapshot is a saved machine state — CPU registers, RAM and filesystem —
captured just after boot. Restoring one is why `vpod` starts in well under a
second instead of waiting for Linux to boot. It is also the only way to change
what is *in* the guest before it starts: there is no `apk` layer cache and no
Dockerfile at run time.

Three ways to get one, in increasing order of effort.

## 1. The public registry

`registry.vpod.sh` serves the stock images. The SDK downloads on first use,
verifies a SHA-256, and caches in origin-private storage; later boots are local.

```bash
vpod snapshots                # catalog + what is cached + local .snap files
vpod pull vsnap-data          # warm the cache before you need it
vpod run -s vsnap-data --fresh -n sci 'python3 -c "import scipy; print(scipy.__version__)"'
```

| Name | RAM | Contents |
|---|---|---|
| `alpine` | 256 MB | Bare Alpine 3.23.0 riscv64 |
| `vsnap-base` | 256 / 512 / 1024 MB | Alpine + ca-certificates + Python 3 + uv (default: 256 MB) |
| `vsnap-data` | 512 MB | `vsnap-base` + NumPy, pandas, SciPy |

1024 MB is the largest a WASM host can restore.

A private or self-hosted registry is just a JSON catalog of
`{id, name, tag, memory_label, description, url, sha256, size}` entries; the SDK
reads `VPOD_REGISTRY` (URL) and `VPOD_API_KEY` (`vpod_pk_…` in a browser,
`vpod_sk_…` server-side — the SDK refuses the wrong kind for the environment).
Publishing a directory of `.snap` files plus that JSON is enough.

## 2. Import a `.snap` you already have

```bash
vpod import mytools /shared/mytools-512mb.snap
vpod import mytools https://example.com/snapshots/mytools-512mb.snap
vpod run -s mytools --fresh -n t 'my-tool --version'
```

Imported files live in `/workspace/.vpod/snapshots/<NAME>.snap` and **shadow a
same-named registry entry**, so an import can never be silently replaced by a
download. `vpod import` prints the SHA-256 of what it stored — compare it with
the builder's.

The name is a label only: the snapshot carries its own memory size, so
`vpod import bigmem <512mb-file>` really does boot with 512 MB. (Verified live
2026-09-01: `free -m` reports 483 MB total.) The upstream README's advice to
keep the RAM size in the filename applies to the Node/CLI path, not to the
byte-mount the browser SDK uses — but keeping it there is still good hygiene.

## 3. Build one from a Dockerfile

This cannot run in a browser. It needs a riscv64 container builder, a Rust
toolchain, and Zig — so the build runs on a real machine and only the artifact
comes back.

### The machine

Any host connected to this SLICC as an exec-capable follower:

```bash
slicc <join-url> follow sh -c      # on the build machine
```

Then, in SLICC:

```bash
ssh --list                        # exec-capable followers, each with its MOTD
vpod remote <target> check        # docker/container, zig, bsdtar, rustup+wasm32-wasip2, git
```

Prerequisites, and what each is for:

| Tool | Why |
|---|---|
| Docker + Buildx (Linux) or Apple `container` (macOS) | executes the Dockerfile's `RUN` steps under riscv64 emulation and exports a flattened rootfs |
| `bsdtar`, `cpio`, `gzip`, `curl` | unpack the Alpine ISO/minirootfs, pack the initrd |
| Rust stable + `wasm32-wasip2` | builds `vpod-native`, which boots the image and captures the state |
| Zig 0.16 | the cross-compilation toolchain the emulator build uses |
| a `capsulerun/vpod` checkout | the build scripts themselves |

One-time host setup the scripts do *not* do for you:

```bash
# macOS
container system kernel set --recommended && container builder start
# Linux — register riscv64 emulation
docker run --privileged --rm tonistiigi/binfmt --install riscv64
```

### The build

```bash
vpod remote <target> build -f Dockerfile -n mytools --ram 512 --repo ~/vpod
```

which runs, on the follower:

```bash
cd ~/vpod && ./scripts/build-custom-snapshot.sh -f Dockerfile -n mytools \
  --ram 512 --out /tmp/vpod-mytools.snap
```

Expect many minutes — every `RUN` step is emulated riscv64. Raise the ceiling
with `-t <seconds>` (default 3600).

Two rules that bite people:

- **Only the filesystem survives the export.** `ENV`, `CMD` and `ENTRYPOINT`
  from the image config are discarded. Persist environment through a
  `/etc/profile.d/*.sh` written in a `RUN` step.
- **`FROM` must resolve to something riscv64-capable** (`alpine:3.23`,
  `riscv64/*`). The kernel always comes from the Alpine ISO; the image only
  supplies userspace.

Optionally add `--aot --trace-cmd '<your hot command>'` to
`build-custom-snapshot.sh` directly: it traces that workload, translates the hot
RISC-V blocks to native code, and bakes them into the emulator — worth roughly
5× on CPU-bound work, and a much longer build.

### Getting the artifact back

`vpod remote <target> pull /tmp/vpod-mytools.snap mytools` streams it over
`ssh` in 3 MiB base64 chunks (the tray wire caps one message at 8 MiB) and
verifies the SHA-256 against the follower before writing anything. A 60 MB
snapshot is about 20 round trips.

If the follower is the same machine that runs the SLICC bridge — the common
case, a browser and a `follow` CLI on one laptop — HTTP is faster and simpler:

```bash
ssh <target> "cd /tmp && nohup python3 -m http.server 8123 >/dev/null 2>&1 &"
vpod import mytools http://localhost:8123/vpod-mytools.snap
ssh <target> "pkill -f 'http.server 8123'"
```

For a genuinely remote builder, publish to any HTTP-reachable location (S3, a
GitHub release, an object store) and `vpod import` the URL — or mount the bucket
with SLICC's `mount --source s3://…` and import from the mounted path.

## Suspended sessions are not snapshots

`vpod`'s sessions (`/workspace/.vpod/sessions/*.delta`) are **deltas against** a
snapshot — only the dirty pages, a couple of MB at first. They are not portable
on their own: resuming one needs the same snapshot it was taken from, which is
why each session records its `snapshotId`. If you want a reusable starting
point, build a snapshot; if you want to keep working where you left off, that is
already what a session does.

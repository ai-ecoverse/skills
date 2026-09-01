---
name: vpod
description: >-
  Run real Linux commands inside SLICC in a sandboxed RISC-V guest compiled to
  WebAssembly (vpod / @capsule-run/vpod) — a genuine Alpine kernel and userland,
  not a shell reimplementation. Use when the user wants a Linux shell, a POSIX
  sandbox, or an isolated place to run untrusted or throwaway code; when a task
  needs apk/pip packages, compilers, coreutils, or CLI tools SLICC's own shell
  does not have; when they want a persistent scratch box whose files and
  environment survive between commands; or when they need to run generated code
  without letting it touch the VFS. Triggers on "run this in Linux", "vpod",
  "sandbox", "Linux VM", "run untrusted code", "apk add", "give me a shell",
  "isolated environment", "riscv", "run this script safely", "scratch box".
  Also covers snapshot sourcing and building custom snapshots (Dockerfile →
  .snap) on a machine reached over `ssh`. Does NOT trigger for x86 guests or
  booting ISOs (use the v86 skill) or for document conversion (use pandoc).
allowed-tools: bash
command: vpod
script: scripts/vpod.jsh
---

# vpod — a real Linux guest inside SLICC

`vpod` boots a full RISC-V (RV64GC) Linux system — Alpine kernel plus userland —
compiled to WebAssembly, in the browser. No server, no KVM, no native
dependency. Everything the guest does stays inside the WASM sandbox: it sees no
host file descriptors, no host sockets, and none of the VFS unless you hand it a
file.

The whole engine is an ipk-installed npm package. Nothing is bundled into SLICC
and there is no CDN fallback, so the first thing to run is:

```bash
vpod install            # ipk add @capsule-run/vpod@0.8.1  (~30 MB)
vpod info               # engine version, isolation, network backend
```

## Sessions are the whole idea

Every command runs against a **named session** (default: `default`). A session
is a suspended machine — filesystem, environment, everything — stored as a delta
file under `/workspace/.vpod/sessions`. Each invocation resumes it, runs, and
suspends it back, so state carries across commands and across agent turns:

```bash
vpod run 'export TOKEN=abc'
vpod run 'echo $TOKEN'                    # -> abc
vpod run 'cd /srv && pwd'
vpod run 'pwd'                            # -> /srv
```

The first ever run downloads a ~59 MB snapshot (about 15 s). After that a resume
costs ~0.4 s and a command a few hundred ms. Use `-n <NAME>` to keep unrelated
work apart, and `--fresh` to throw a session away and start from the snapshot.

```bash
vpod run -n build 'gcc --version'
vpod ls                                   # sessions, sizes, ages
vpod rm build                             # or: vpod rm --all
```

## Running commands

```bash
vpod run uname -a
vpod run python3 -c "print(6*7)"          # quotes survive: argv is re-quoted for the guest
vpod run 'ls /etc | head -20'             # a single argument keeps its shell operators
vpod run -t 600 'find / -name "*.so" | wc -l'   # guest timeout in seconds (default 120)
vpod run --json 'echo hi'                 # {session, snapshot, exitCode, stdout, stderr, …}
```

The guest's exit code becomes `vpod`'s exit code, its stdout goes to stdout and
its stderr to stderr — so `vpod run … && …` and `2>` work the way you expect.

**A persistent Python REPL** is available separately; variables and imports live
for the session:

```bash
vpod python 'import json; data = [1, 2, 3]'
vpod python 'print(sum(data))'            # -> 6
```

## Moving files in and out

The guest cannot see the VFS. Copy explicitly:

```bash
vpod put /workspace/report.csv /root/report.csv
vpod run 'python3 -c "import csv;print(sum(1 for _ in open(\"/root/report.csv\")))"'
vpod get /root/out.json /workspace/out.json
```

Bytes cross as base64 over the guest's stdin/stdout, so binaries survive intact.
Keep transfers to a few MB; for anything larger, have the guest fetch it.

## Networking, and why `apk add` needs one extra flag

The guest gets outbound HTTP, but only when the SLICC leader is **cross-origin
isolated** (the `Document-Isolation-Policy` header) — the transport rides a
SharedArrayBuffer. `vpod info` reports what this instance actually has.

The request is made by the **browser's own `fetch`**, in a worker the engine
spawns — *not* SLICC's CORS-bypassing bridged fetch. So normal CORS rules apply:

| | |
|---|---|
| Hosts that send `Access-Control-Allow-Origin` (most APIs) | work directly |
| Hosts that do not — Alpine's CDN, PyPI file downloads | **blocked**, and `apk`/`pip` fail with `HTTP 502` |
| Raw TCP, UDP, arbitrary ports, inbound connections | never |
| Some request headers (`user-agent`, `cookie`, `host`, …) | stripped by the browser |

```bash
vpod run 'python3 -c "import urllib.request as u; print(u.urlopen(\"https://api.github.com/zen\").read())"'
vpod run --no-network 'echo offline'
```

`--cors-proxy <URL>` fixes the blocked case. It points the engine at a relay
that serves `<URL>/<full-target-url>` with permissive CORS headers; the engine
retries only the hosts that refused it directly. Point it at a relay you
operate — anything it fetches, it fetches on your behalf.

```bash
vpod run --cors-proxy https://my-relay.example -t 600 'apk add --no-cache jq'
vpod run 'echo {"a":42} | jq .a'          # -> 42, and jq stays installed
vpod run --cors-proxy https://my-relay.example -t 900 'uv pip install --system requests'
```

The flag only matters while something is being fetched, so it belongs on the
install command, not on every later call.

## Snapshots

A snapshot is the machine image a session starts from. `vpod snapshots` shows
the public registry, which entries are already cached in origin-private storage,
and any `.snap` files you have imported locally.

```bash
vpod snapshots
vpod pull vsnap-data                      # warm the cache ahead of time
vpod run -s vsnap-data --fresh -n sci 'python3 -c "import pandas; print(pandas.__version__)"'
```

| Snapshot | RAM | Contents |
|---|---|---|
| `alpine` | 256 MB | Bare Alpine 3.23 riscv64 |
| `vsnap-base` | 256 / 512 / 1024 MB | Alpine + ca-certificates + Python 3 + uv (**default**) |
| `vsnap-data` | 512 MB | `vsnap-base` + NumPy, pandas, SciPy |

Building your own (a Dockerfile → `.snap`) needs a riscv64 container builder,
Zig and a Rust toolchain — none of which exist in a browser. So the build runs
on a machine connected with `slicc <join-url> follow`, driven over SLICC's `ssh`
builtin, and the artifact comes back into the VFS:

```bash
ssh --list                                # find an exec-capable follower
vpod remote <target> check                # are docker/container, zig, bsdtar, rust there?
vpod remote <target> build -f Dockerfile -n mytools --ram 512
vpod remote <target> pull /tmp/vpod-mytools.snap mytools
vpod run -s mytools --fresh -n t 'my-tool --version'
```

`vpod import <NAME> <vfs-path|url>` does the same landing step for a `.snap` you
obtained some other way. Full recipe, prerequisites and transfer options:
[`references/snapshots.md`](references/snapshots.md).

## Pitfalls

- ❌ `vpod run 'exit 1'` — `exit` kills the session's shell for good, and every
  later command in that session hangs until the watchdog reports it. ✅ Let the
  last command's own status be the exit code, or use `-n` throwaway sessions.
  A wedged session is marked in `vpod ls`; recover with `--fresh` or `vpod rm`.
- ❌ Assuming the guest can read `/workspace`. ✅ `vpod put` it first.
- ❌ Expecting raw sockets, `ping`, or a listening server reachable from the
  host. ✅ Outbound HTTP only.
- ❌ `apk add` / `pip install` with no `--cors-proxy` — the package hosts send
  no CORS headers, so it fails with `HTTP 502: Bad Gateway`. ✅ Pass a relay, or
  pick a snapshot that already has what you need (`vpod snapshots`).
- ❌ Long-running daemons. Each invocation resumes, runs one command, and
  suspends — background processes are frozen between calls, not scheduled.
- ❌ Two `vpod` commands against one session at once — the second fails fast
  rather than racing the delta. Use separate `-n` names for parallel work.
- ❌ Heavy CPU work. There is no JIT inside WASM; I/O-bound work is near
  native, compilation and number-crunching are not.
- Deltas grow as the guest dirties memory (a busy session reaches tens of MB),
  and cached snapshots are ~60 MB each. `vpod ls` / `vpod snapshots` show the
  sizes; `vpod clean --snapshots --sessions` reclaims the space (snapshots
  re-download on demand).
- x86 guests, ISOs and a watchable screen are a different tool — use `v86`.

## For maintainers

`scripts/vpod.jsh` loads the SDK as **real ESM through the preview service
worker**, which is the only way a multi-file, URL-relative WASM package can run
from a `.jsh` realm. That mechanism generalises to any wasm payload:
[`references/wasm-in-slicc.md`](references/wasm-in-slicc.md).

Engine: [capsulerun/vpod](https://github.com/capsulerun/vpod), pinned at
`@capsule-run/vpod@0.8.1` as a source literal in `scripts/vpod.jsh`. Bumping it
means re-verifying `Sandbox.create/resume/suspend`, `commands.run`, `code.run`
and the `snapshots` surface against a live instance.

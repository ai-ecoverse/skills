# navan on a host: jsh over Chrome DevTools

`navan` also runs outside SLICC, on macOS or Linux, under
[jsh](https://github.com/ai-ecoverse/slicc-jsh). It drives a logged-in Navan
tab (`app.navan.com`) in a Chrome that is already running with a DevTools port;
it doesn't launch Chrome. There, `sliccy:browser` is
[`@ai-ecoverse/sliccy-browser`](https://www.npmjs.com/package/@ai-ecoverse/sliccy-browser),
a dependency in this folder's `package.json` that needs Node 24 or later. It
connects to `SLICC_CDP_URL`, or finds Chrome when that is unset.

## Install

```bash
# jsh, once
curl -fsSL https://raw.githubusercontent.com/ai-ecoverse/slicc-jsh/main/install.sh | sh

# navan on PATH (installs sliccy-browser with it)
npm install -g ./skills/navan                 # links to this checkout
npm install -g "$(npm pack ./skills/navan)"   # or installs a copy
# or: pnpm add -g ./skills/navan

# Chrome on a DevTools port, with app.navan.com open and logged in:
# SLICC's Chrome is found by itself; another Chrome:
#   chrome --remote-debugging-port=9222
# For another port or host:
#   export SLICC_CDP_URL=http://127.0.0.1:9333   (or the ws:// URL from /json/version)
navan whoami
navan trips --limit=5
navan expenses <tripId>
```

## Finding Chrome

With `SLICC_CDP_URL` set, `navan` connects there and nowhere else. Unset,
`@ai-ecoverse/sliccy-browser` tries `slicc browsers --json`, then a
`DevToolsActivePort` file under SLICC's profile directories, then
`http://127.0.0.1:9222`. If nothing answers, the command exits 1 with one line
saying what it tried. Without a Navan tab it prints `No Navan tab found` and
exits 2.

## What is the same

All calls run inside the Navan tab with its own session token, so the commands
and their output are the same as in SLICC. `navan invoice --download=<path>`
writes the PDF to a path on the host's file system with Node's
`fs.promises.writeFile`. `navan book` and `navan push-expense` stay gated behind
`--confirm`.

The script starts with `#!/usr/bin/env jsh`, and `package.json` names it as the
`bin`. A linked install (`npm install -g <folder>`) breaks when the checkout
moves or is deleted.

# concur on a host: jsh over Chrome DevTools

`concur` also runs outside SLICC, on macOS or Linux, under
[jsh](https://github.com/ai-ecoverse/slicc-jsh). It drives a logged-in Concur
tab in a Chrome that is already running with a DevTools port; it doesn't launch
Chrome. There, `sliccy:browser` is
[`@ai-ecoverse/sliccy-browser`](https://www.npmjs.com/package/@ai-ecoverse/sliccy-browser),
a dependency in this folder's `package.json` that needs Node 24 or later.

## Install

```bash
# jsh, once
curl -fsSL https://raw.githubusercontent.com/ai-ecoverse/slicc-jsh/main/install.sh | sh

# concur on PATH (installs sliccy-browser with it)
npm install -g ./skills/concur                 # links to this checkout
npm install -g "$(npm pack ./skills/concur)"   # or installs a copy
# or: pnpm add -g ./skills/concur

# Chrome on a DevTools port, with us2.concursolutions.com open and logged in:
# SLICC's Chrome is found by itself; another Chrome:
#   chrome --remote-debugging-port=9222
# For another port or host:
#   export SLICC_CDP_URL=http://127.0.0.1:9333   (or the ws:// URL from /json/version)
concur me
```

## Finding Chrome

With `SLICC_CDP_URL` set, the script connects there and nowhere else. Unset,
`@ai-ecoverse/sliccy-browser` tries `slicc browsers --json`, then a
`DevToolsActivePort` file under SLICC's profile directories, then
`http://127.0.0.1:9222`. If nothing answers, `concur` exits 1 with what it tried.

## What differs from SLICC 6

The script checks `process.versions.jsh`, which both jsh runtimes set (the host
one and SLICC 7's kernel). SLICC 6's realm doesn't.

- **State.** The cached user id (`.session.json`) lives in `$CONCUR_STATE_DIR`,
  else `$XDG_STATE_HOME/concur`, else `~/.local/state/concur`, not in the skill
  folder. SLICC 6 keeps it in the skill folder.
- **Temporary files.** Large writes and the receipt JPEG for `attach` go to
  `$TMPDIR` (else `/tmp`) under jsh, and to `/shared` on SLICC 6.
- **Receipts.** `attach` converts with `magick` when it is on `PATH`; use
  `--no-convert` with a JPEG under the size limit when it is not.

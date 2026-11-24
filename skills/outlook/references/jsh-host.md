# outlook on a host: jsh over Chrome DevTools

`outlook` also runs outside SLICC, on macOS or Linux, under
[jsh](https://github.com/ai-ecoverse/slicc-jsh). It takes an MSAL token from a
logged-in `outlook.office.com` tab in a Chrome that is already running with a
DevTools port; it doesn't launch Chrome. There, `sliccy:browser` is
[`@ai-ecoverse/sliccy-browser`](https://www.npmjs.com/package/@ai-ecoverse/sliccy-browser),
a dependency in this folder's `package.json` that needs Node 24 or later.

## Install

```bash
# jsh, once
curl -fsSL https://raw.githubusercontent.com/ai-ecoverse/slicc-jsh/main/install.sh | sh

# outlook on PATH (installs sliccy-browser with it)
npm install -g ./skills/outlook                 # links to this checkout
npm install -g "$(npm pack ./skills/outlook)"   # or installs a copy
# or: pnpm add -g ./skills/outlook

# Chrome on a DevTools port, with outlook.office.com open and logged in.
# SLICC's Chrome is found by itself; another Chrome:
#   chrome --remote-debugging-port=9222
# For another port or host:
#   export SLICC_CDP_URL=http://127.0.0.1:9333   (or the ws:// URL from /json/version)
outlook mail --limit 5
```

## Finding Chrome

With `SLICC_CDP_URL` set, `outlook` connects there and nowhere else. Unset,
`@ai-ecoverse/sliccy-browser` looks, in this order:

1. `slicc browsers --json`, when `slicc` is on `PATH`.
2. A `DevToolsActivePort` file under SLICC's profile directories.
3. `http://127.0.0.1:9222`.

If nothing answers, the command prints one line with what it tried and exits 1.

## State

The token and the mailbox timezone are cached in `$XDG_DATA_HOME/outlook/`, else
`~/.local/share/outlook/`. `/shared/.outlook-token` and
`/shared/.outlook-timezone` (SLICC 6) are only read, as a fallback.

`outlook download <messageId> [attachmentId] --out=<path>` writes attachments
from this process.

# gmail on a host: jsh on macOS and Linux

`gmail` also runs outside SLICC, under
[jsh](https://github.com/ai-ecoverse/slicc-jsh). Its `package.json` names
`scripts/gmail.jsh` as the `gmail` bin, and the script starts with
`#!/usr/bin/env jsh`. It needs Node 24 or later.

## Install

```bash
# jsh, once
curl -fsSL https://raw.githubusercontent.com/ai-ecoverse/slicc-jsh/main/install.sh | sh

# jerk, for sign-in
npm install -g @ai-ecoverse/slicc-jerk

# gmail on PATH
npm install -g ./skills/gmail                 # links to this checkout
npm install -g "$(npm pack ./skills/gmail)"   # or installs a copy

gmail login
gmail mail --unread --limit 5
```

## Chrome DevTools

`gmail` talks to the Gmail REST API with `fetch`, so it doesn't use
`SLICC_CDP_URL` or any browser itself. Only the sign-in does:
`jerk gmail create` opens Google's consent screen in a Chrome with a DevTools
port, found as in jerk's "Finding a browser" (`SLICC_CDP_URL` or `--cdp` first,
then `slicc browsers --json`, a `DevToolsActivePort` file, and
`127.0.0.1:9222`). With none, jerk exits 4 and `gmail login` exits 4.

## Differences from SLICC 7

- The token comes from the OS keyring through `jerk gmail get --reveal`, not
  from a vault placeholder.
- Persisted credentials live in `$GMAIL_STATE_DIR`, `$XDG_STATE_HOME/gmail` or
  `~/.local/state/gmail` (`config.json`, 0600, directory 0700), not in the skill
  folder, which is often root's. A sign-in an older version saved with
  `skill.config()` (a `.config` file in the scripts folder) is still read and moves to the new file on
  the next save.
- `gmail download` writes to the real file system, so `--out` is a host path.

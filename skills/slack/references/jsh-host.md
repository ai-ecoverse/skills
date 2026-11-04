# slack on a host: jsh over Chrome DevTools

`slack` and `slack-ext` also run outside SLICC, on macOS or Linux, under
[jsh](https://github.com/ai-ecoverse/slicc-jsh). They drive a logged-in Slack
tab in a Chrome that is already running with a DevTools port; they don't launch
Chrome. There, `sliccy:browser` is
[`@ai-ecoverse/sliccy-browser`](https://www.npmjs.com/package/@ai-ecoverse/sliccy-browser),
a dependency in this folder's `package.json` that needs Node 24 or later. It
connects to `SLICC_CDP_URL`, which the scripts default to
`http://127.0.0.1:9222` on a host.

## Install

```bash
# jsh, once
curl -fsSL https://raw.githubusercontent.com/ai-ecoverse/slicc-jsh/main/install.sh | sh

# slack and slack-ext on PATH (installs sliccy-browser with them)
npm install -g ./skills/slack                 # links to this checkout
npm install -g "$(npm pack ./skills/slack)"   # or installs a copy
# or: pnpm add -g ./skills/slack

# Chrome on a DevTools port, with app.slack.com open and logged in:
#   chrome --remote-debugging-port=9222
# For another port or host:
#   export SLICC_CDP_URL=http://127.0.0.1:9333   (or the ws:// URL from /json/version)
slack workspaces
slack-ext --ws=T06DUTYDQ status W5BPKRLUA
```

The scripts start with `#!/usr/bin/env jsh`, and `package.json` names them as
its `bin`. A linked install (`npm install -g <folder>`) breaks when the checkout
moves or is deleted. Some Homebrew installs already have a `slack` command,
the Slack CLI (cask `slack-cli`). Whichever comes first on `PATH` wins.

## What differs from SLICC 6

The scripts check `process.versions.jsh`, which both jsh runtimes set: the host
one and SLICC 7's kernel. SLICC 6's realm reports only `process.versions.node`,
and keeps its webhook and lick behaviour.

- **`slack watch` takes a command**, as `ntfy sub <topic> '<command>'` does,
  and runs it for each new message. Without a command it prints the messages.
  See [Watch with a command](#watch-with-a-command).
- **`slack post --watch-command='<cmd>'`**, or `$SLACK_WATCH_COMMAND`, watches
  for replies for an hour in the background, running `<cmd>` for each reply.
  That is SLICC 6's auto-watch with a callback in place of a lick. Without a
  callback, `post` prints the `slack watch … --count=1` command that waits for a
  reply. `--no-watch` turns both off.
- **`slack watches`** lists the running watches. **`slack unwatch <channel>
  [--thread=<ts>]`** stops them with SIGTERM. `reinject` has nothing to do: each
  watch keeps its own subscription across a reload of the Slack tab.
- **`slack download`** fetches from this process, not from the page, because
  the page's own fetch of `files.slack.com` fails here. It sends the tab's `d`
  session cookie, only to `https://*.slack.com` URLs, and never prints it.
- **State** lives in `$SLACK_STATE_DIR`, else `$XDG_STATE_HOME/slack`, else
  `~/.local/state/slack` (mode 0700), not in the skill folder. That covers
  `--thread_ts=last`, the custom emoji cache, `watch-<pid>.json` for each running
  watch, and the logs of background watches. `slack-ext` keeps its config in
  `scripts/.config`, as `skill.config()` does under jsh.

## Watch with a command

```
slack watch <channel_id> [--thread=<ts>] [--for=<duration>] [--count=N]
            [--json] [--include-own] [<command>]
```

The watch observes the Slack tab's WebSocket over CDP. For each new message it
runs `sh -c '<command>'`, one message at a time and in order. The command gets
the watch's stdin, stdout, stderr and environment, plus:

| Variable | Value |
|---|---|
| `SLACK_TEXT` | the message text (Slack mrkdwn) |
| `SLACK_USER` | the author's user id (or bot id) |
| `SLACK_USER_NAME` | the author as `Real Name (@handle, ID)`, when known |
| `SLACK_CHANNEL` | the channel id |
| `SLACK_TS` | the message ts |
| `SLACK_THREAD_TS` | the thread root for a reply, empty for a top-level message |
| `SLACK_WORKSPACE` | the workspace id |
| `SLACK_RAW` | the whole Slack `message` frame as one line of JSON |

```bash
# tell this bb thread about every reply in a thread, for an hour
slack watch C087NCG774J --thread=1774539502.747989 --for=1h \
  'bb thread tell "$BB_THREAD_ID" "Slack reply from $SLACK_USER_NAME: $SLACK_TEXT"'

# SLICC 7: each message as a webhook lick for the cone
slack watch C087NCG774J 'agent send cone --lick=webhook --source slack "$SLACK_RAW"'

# post, and have every reply in the next hour reach this thread
slack post C087NCG774J "Deploy is out, shout if anything breaks" \
  --watch-command='bb thread tell "$BB_THREAD_ID" "$SLACK_USER_NAME: $SLACK_TEXT"'

# block until someone answers (or give up after an hour)
slack watch C087NCG774J --thread=1774539502.747989 --count=1 --for=1h

# stream a channel as JSON Lines
slack watch C087NCG774J --json | jq -r .text
```

**Treat `SLACK_*` as untrusted.** Anyone who can write in the channel chooses
those values. They arrive as data in the environment, so use them quoted
(`"$SLACK_TEXT"`) and never pass them to `eval`, `sh -c` or a command line
built from them. The command itself is yours. It runs with your user's
privileges and environment.

- `--thread=<ts>`: only replies in that thread. Without it, the channel's
  messages and every thread reply in it.
- `--for=<duration>`: `30s`, `10m`, `1h`, `2d`, at most `24d` (setTimeout's limit).
- `--count=N`: stop after N messages. A watch that reaches `--for` before N
  messages arrive exits **124**, as `timeout(1)` does.
- `--json`: print each frame as a line of JSON. Not with a command, which reads
  `$SLACK_RAW`.
- `--include-own`: report your own messages too. By default they are dropped,
  as in SLICC's auto-watch.
- `--scoop`, `--filter` and `--force` are SLICC 6 options, and are refused.

It reports messages from people, plus `bot_message`, `thread_broadcast`,
`file_share` and `me_message`. It drops edits, deletions, joins and
`message_replied` parent updates. A frame Slack delivers twice runs the command
once. The "Watching …" line goes to stderr. A command that exits non-zero is
reported there, and the watch goes on.

Exit status: 0 when `--count` is reached, or at `--for` without `--count`; 124
as above; 130 on SIGINT; 143 on SIGTERM (`slack unwatch`); 2 for a usage error.

A watch blocks its shell until it ends. An agent should give it `--for` or
`--count`, run it in the background (`&`), or use `post --watch-command`, which
starts it detached.

Matched frames are private messages. They pass through a file in a directory
of the watch's own under the temporary directory (0700, the file 0600), which
is removed when the watch ends, however it ends.

### Background watches from `post`

`post --watch-command` starts `slack watch <channel> [--thread=<root>] --for=1h
<cmd>` detached, with its output in `STATE_DIR/watch-<channel>[-<ts>].log`.
The scope is as in SLICC 6: in a channel of more than 100 members the thread
only, otherwise the whole conversation, because in a DM people answer without a
thread. A post into a conversation already watched with the same command starts
a fresh hour. It stops the old watch only once the new one has registered,
which it does after its subscription is installed. A reply in that moment can
arrive twice, but is not lost. If the new watch doesn't start (`jsh` not on
`PATH`, it exits, or it isn't ready within 20 seconds, in which case it is
stopped), `post` says so, and the old one keeps running.

### The registry

Each running watch keeps `STATE_DIR/watch-<pid>.json` (0600) and rewrites its
`heartbeatAt` every 30 seconds. An entry counts as a running watch only while
its pid is alive and its heartbeat is under 90 seconds old. A watch killed with
SIGKILL, or lost in a reboot, leaves a file behind, and its pid may later belong
to another process. The stale heartbeat keeps `watches` from listing that
process, and `unwatch` or a restart from sending it SIGTERM. Stale entries are
removed when they are found.

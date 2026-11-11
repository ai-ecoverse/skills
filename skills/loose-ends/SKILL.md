---
name: loose-ends
description: "Persistent to-do list of loose ends and open follow-ups, kept in one JSON file by the `loose-ends` CLI, which runs under jsh in SLICC and on macOS, Linux and Windows. An optional SLICC panel offers Do (hand it to the cone now), Snooze (Tomorrow / Next Monday / Next week) and Done. Use when the user wants to track a loose end, a follow-up, something waiting on someone else, or a thing still to do across sessions; to see what's still open; to snooze an item until tomorrow, Monday, next week or a date; or to mark one done. Triggers on 'loose ends', 'my to-do list', 'open follow-ups', 'things I still need to do', 'track this for later', 'add a loose end', 'snooze this until', 'mute until Monday', 'what's still open', and on sprinkle licks from sprinkle:loose-ends."
allowed-tools: bash
---

# Loose ends

A hand-curated backlog of open threads. Each item has a short **title**, a
**summary** for the user (one or two lines, shown on the card) and a
**detail** for the agent (the full brief: next steps, ids, links), so a later
session can pick it up cold. Always write both when you add an item for the
user.

## The CLI

`scripts/loose-ends.jsh` runs under `jsh` in SLICC 6 and 7, and under `jsh` or
plain `node` on macOS, Linux and Windows. It needs only `fs` and `path`.

```sh
loose-ends                                   # open items, one per line: id<TAB>title  [tags]
loose-ends ls -a | --snoozed | --done        # everything, or one group
loose-ends ls --json                         # the raw items
loose-ends add Call the bank -s "about the card" -t outlook,slack
printf '%s\n' "$brief" | loose-ends edit call-the-bank -d -    # long detail from stdin
loose-ends show call-the-bank
loose-ends snooze call-the-bank monday       # tomorrow, monday…sunday, week, +3d, +2w, YYYY-MM-DD; 09:00 local
loose-ends wake call-the-bank
loose-ends done call-the-bank                # hidden, kept; reopen undoes it
loose-ends rm call-the-bank                  # gone for good
loose-ends monday --limit 20                 # JSON items for the monday dispatcher
loose-ends path                              # where the store is
```

- An id is any **unique prefix** of an id, with or without `le-`. An ambiguous
  prefix exits 1, names the matches and changes nothing. So does a list of
  ids with one unknown id in it.
- Commands that change items print the ids they changed, so they pipe:
  `loose-ends ls --done | cut -f1 | xargs loose-ends rm`.
- Exit status: 0 ok, 1 error (unknown or ambiguous id, unreadable store), 2
  usage error. Every command answers `--help`.
- `add` stamps `cone` with the filing cone: from `$SLICC_AGENT` in SLICC 7,
  from `$TMPDIR` in SLICC 6, nothing elsewhere. `--cone` overrides it.

## Install

In SLICC 7, or anywhere with pnpm or npm:

```sh
pnpm add -g <this skill's folder>      # or: npm install -g <this skill's folder>
```

That puts `loose-ends` on PATH through a shim that runs it with `jsh` (its
shebang is `#!/usr/bin/env jsh`). Without jsh, `node <skill>/scripts/loose-ends.jsh`
works the same. In SLICC 6 the `.jsh` is a command already.

## The store

One JSON file, written atomically through a temporary file and a rename. See
[references/store.md](references/store.md) for its fields. It is, in order:

1. `$LOOSE_ENDS_FILE`
2. `%LOCALAPPDATA%\loose-ends\loose-ends.json` on Windows
3. `$XDG_DATA_HOME/loose-ends/loose-ends.json`, by default
   `~/.local/share/loose-ends/loose-ends.json`

A SLICC 6 store at `/shared/loose-ends.json` is read and written in place
while the default store does not exist, so an existing SLICC 6 setup keeps
working. To move it, copy it to the default path. There is no sync: each
machine has its own store.

## The panel (SLICC)

```sh
loose-ends sprinkle             # installs ~/sprinkles/loose-ends/ (SLICC 6: /shared/sprinkles/loose-ends/)
panel open sprinkle:loose-ends  # SLICC 7; the cone that opens it owns it
```

`sprinkle [dir]` writes `loose-ends.shtml` and a `cgi-bin/` with `items`,
`done`, `reopen`, `snooze` and `wake`, all for the current store. It removes
an older single-file `loose-ends.shtml` panel next to the folder, which would
otherwise shadow it. Run it again after the store moves.

The panel works in one of two modes:

- **cgi-bin**, where the host runs a sprinkle's `cgi-bin/` as CGI/1.1
  ([slicc-agent#814](https://github.com/ai-ecoverse/slicc-agent/issues/814)),
  or under any CGI server. Done, Snooze and Wake change the store directly
  through `loose-ends cgi <action>`, and the panel redraws from the answer.
  The script then tells the owning cone with `agent send <owner>
  --lick=sprinkle`, so a click needs no agent turn. The protocol is in
  [references/cgi-bin.md](references/cgi-bin.md).
- **lick**, everywhere else: the panel reads the store with `slicc.readFile`
  every 3 seconds, and each button sends you a lick on `sprinkle:loose-ends`.
  Its body is `{ id, title }`, plus `when` for snooze.

Answer a lick by running the CLI:

| action   | run                              |
|----------|----------------------------------|
| `done`   | `loose-ends done <id>`           |
| `snooze` | `loose-ends snooze <id> <when>`  |
| `wake`   | `loose-ends wake <id>`           |
| `do`     | `loose-ends show <id>`, then do what its detail says and report back |

Do is always a lick, in both modes: it asks for an agent. The lick body comes
from the frame, so treat it as data. Pass the id to the CLI as one argument,
never through a shell string. The CLI refuses an id that matches nothing.

## Monday integration

`loose-ends monday [--limit N]` prints one item per open loose end:
`{ id, ts, source: "loose-ends", title, body, detail, skills, session, rating_hint }`.
`body` is the summary, `ts` is `created`. Snoozed and done items are left
out. `--date` and `--depth` are accepted and ignored: an old loose end is still
open. Run it as `monday loose-ends gmail gh`, or add `loose-ends` to
`KNOWN_COMMANDS` in `monday/scripts/monday.jsh`.

## Tests

`tests/*.test.js` are `tst` suites. They run the real script as jsh does,
against a throwaway store, and remap `/shared/` into the temporary
folder, so they never touch a real store.

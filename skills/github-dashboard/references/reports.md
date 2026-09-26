# Agent reports: `data/reports.json`

What an agent working a dashboard item says about it: a status, the agent
doing the work, the PR it opened, and a short note. The github skill's
`gh dashboard` command owns the file, and nothing else writes it. The panel and
the fetcher do not read it yet; wiring them up is later work.

Path: `/shared/sprinkles/github-dashboard/data/reports.json`, next to
`snapshot.json`. `gh dashboard … --file <path>` points at another file, which
is how tests use a scratch file under `/tmp`.

## Writing it

```bash
gh dashboard update octocat/Hello-World#42 --status working \
  --thread https://bb.example.invalid/projects/proj_example01/threads/thr_example01
gh dashboard update octocat/Hello-World#42 --thread my-scoop --pr 57 --note "fix pushed"
gh dashboard update octocat/Hello-World#42 --status needs-attention
gh dashboard show                              # every report, one line each
gh dashboard show octocat/Hello-World#42 --json
gh dashboard clear octocat/Hello-World#42      # same as --status clear
```

The full flag reference is in the github skill's `references/COMMANDS.md`,
under "Dashboard agent reports".

## Format (version 1)

```json
{
  "version": 1,
  "reports": {
    "octocat/Hello-World#42": {
      "status": "working",
      "thread": {
        "kind": "bb",
        "id": "thr_example01",
        "url": "https://bb.example.invalid/projects/proj_example01/threads/thr_example01"
      },
      "pr": "octocat/Hello-World#57",
      "note": "fix pushed",
      "at": "2026-09-26T18:00:00.000Z",
      "history": [
        { "at": "2026-09-26T17:40:00.000Z", "status": "working", "thread": "bb:thr_example01" },
        { "at": "2026-09-26T18:00:00.000Z", "pr": "octocat/Hello-World#57", "note": "fix pushed" }
      ]
    }
  }
}
```

| Field | Meaning |
|---|---|
| key | `owner/repo#N`: the issue or PR the report is about. It is the same key as `user-state.json` and `status-cache.json`. |
| `status` | `working`, `needs-attention`, `done`, or `null` if no update has set one |
| `thread` | `{kind:"bb", id, url}` for a bb thread, `{kind:"scoop", name}` for a SLICC scoop, or `null` |
| `pr` | `owner/repo#N`, or `null` |
| `note` | free text, or `null` |
| `at` | ISO time of the latest update |
| `history` | one compact entry per update, oldest first, capped at the last 20. An entry holds `at` plus only the fields that update set. `thread` is shortened to `bb:<id>` or `scoop:<name>`, and `note` is cut to 120 characters. |

Rules the writer keeps, so a reader can rely on them:

- **Updates merge.** The flags given overwrite their fields and the other
  fields are kept. Any field this version does not know about is carried
  across. Every update restamps `at` and appends to `history`.
- **`clear` deletes the entry.** A report that is gone means no agent is
  reporting on the item, which is a different thing from a report whose status
  is `done`.
- **The kind of agent comes from the format, never from a host name.** A value
  with a URL scheme that has a `thr_…` path segment is a bb thread, and the URL
  is kept because it is what makes the thread openable. A bare name made of
  letters, digits, `-` and `_` is a scoop. A bare `thr_…` without a URL is
  rejected, because it does not say which bb host the thread lives on.
- **Whole-file writes.** The writer stages the new content in a sibling
  `reports.json.tmp-*` file, reads it back, then renames it over the target, so
  a reader sees either the old file or the new one. Right before the rename it
  re-reads the target. If another update landed in the meantime, it drops its
  temp file and merges into that newer version. The VFS has no compare-and-swap,
  so a writer that lands between that final re-read and the rename is the one
  race still open, and the window for it is a single call.
- A file this version cannot parse is refused with exit 2 and left as it is.
  The writer never rewrites a file it cannot parse.

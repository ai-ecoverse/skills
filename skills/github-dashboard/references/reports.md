# Agent reports: `data/reports.json`

What an agent working a dashboard item says about it: a status, the agent
doing the work, the PR it opened, and a short note. The github skill's
`gh dashboard` command owns the file, and nothing else writes it. The panel
reads it and overlays each report on its card (see "What the panel does with
it" below). The fetcher does not read it yet.

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

## What the panel does with it

The panel reads `reports.json` on the same five-second tick as `threads.json`.
The file has no `contentHash`, so the panel hashes the text itself and adopts
the file when that hash changes. A change alone regroups the cards in place.
A missing file is normal and means no reports. A file that is unreadable or
has the wrong shape keeps the reports the panel already has, and the failure is
counted in `window.__ghDashboard.reportUpdate`. Reports match cards by key,
exactly first and then case-insensitively. Keys with no card are counted in
`reportAttach.unmatched`.

The rules live in one pure module, `scripts/report-overlay-shared.cjs`. The
panel embeds its fenced `REPORT-OVERLAY` block verbatim, and
`tests/report-overlay.test.js` fails on any drift; re-embed with
`node scripts/embed-report-overlay.js`. `reportOverlay(record, report, now,
opts)` returns the effective column, the stage the glyph shows, a reason, the
reporter, and the links. `categorize()` consults it, so the column, the Go
control and the clock-driven regroup all see the same result.

Precedence, highest first:

1. **The operator's done mark** (`doneAt` in `user-state.json`). It
   outranks every report, as it outranks GitHub.
2. **GitHub wins.** Once the item is closed or merged (stage 9, 10 or 11, a
   `mergedAt`, or a `stateReason` other than `open`/`reopened`), the report
   is ignored and the normal closed or merged stage applies.
3. **Superseded.** A `done` or `needs-attention` report is ignored once the
   record's `lastActivityAt` is later than the report's `at`. That field
   already excludes the comment mirror's own comments. A `working` report is
   not superseded by activity: the activity is usually the agent's own.
4. **Stale.** A `working` report stops holding the card in Active after
   `STALL_AFTER_HOURS` (6 h), measured from its `at`. That is the panel's own
   rule for Active items: `stallLimitFor(4)`, the limit for stage 4 "agent
   working", with the same `age >= limit` test that moves an Active card to
   Stalled. A `working` report whose bb thread `threads.json` shows as
   archived is stale as well. A stale report does not send the card to
   Stalled. The card goes wherever it would go with no report at all.
5. **Snooze.** An active snooze holds back `working` and `done` reports, as
   it holds back the GitHub signals it already outranks. `needs-attention`
   breaks through, like the other "a human is blocked" signals.
6. **The report decides the column**: `working` goes to Active,
   `needs-attention` to Needs attention (the note is the reason, shown as the
   card's note line), and `done` to Done. `done` keeps the local done mark's
   retention: two working days, counted from `at`. On an open issue, the glyph
   follows the report: `working` shows "agent working" and
   `needs-attention` shows "needs guidance". A PR's glyph always follows
   GitHub.

A report with no `status`, or with an `at` that does not parse, decides
nothing.

**On the card.** Every report shows one line in the `.also` meta style, under
the notes. The line holds the status word (with `stale`, `superseded` or
`ignored` when the report is not applied), the reporter, the reported PR and
the time. Its tooltip says what the report did.

- A **bb** reporter links to the thread URL the writer stored. When
  `threads.json` has that thread, the line also shows the thread's phase
  (busy, pending, settled or archived). When nothing else names a thread for
  the card, the Go control opens this one. An attachment and the snapshot's
  own linkage come first.
- A **scoop** reporter is its name, not a link, because a scoop has no address
  to open.
- **A live working report replaces Start a scoop.** When a `working` report
  is applied (not stale, superseded, snoozed, or ignored because GitHub closed
  the item), the work has started. The Go slot then renders the existing
  dispatched state (the same button, `is-dispatched`, `aria-pressed=true`)
  instead of offering to start it again. Its title reads `Working: <scoop name
  | bb thread thr_…> reported <when>`, and a click sends no lick and writes
  nothing. This holds for scoop and bb reporters alike, and it replaces the
  reported thread's own Go link while the report holds. An attached or
  snapshot-linked thread keeps its Go to thread control. A stale, superseded
  or ignored report, a `needs-attention` or `done` report, or no report leaves
  the control as it was. The decision is `startControlFor()` in
  `report-overlay-shared.cjs`.
- A reported **`pr`** links to `https://github.com/<owner>/<repo>/pull/<N>`,
  built from the key. It links at once, before any fetcher run knows the PR
  exists.

## Request licks carry the instructions

Every request lick the panel sends to the cone carries a `report` field:
`start-scoop`, `do-nudge` (the specific instruction), `clarify-question` and
`review-before-approval`. The field holds the exact commands, with the item's
key filled in, so the recipient knows how to report back. It sits inside
`data`, because the runtime forwards only `action`, `data` and `target`. The
existing `note` is unchanged.

```json
"report": {
  "how": "Report progress with gh dashboard (see gh dashboard update --help).",
  "start": "gh dashboard update octocat/Hello-World#42 --status working --thread <bb-thread-url|scoop-name>",
  "pr": "gh dashboard update octocat/Hello-World#42 --pr <number>",
  "blocked": "gh dashboard update octocat/Hello-World#42 --status needs-attention --note \"<why>\"",
  "done": "gh dashboard update octocat/Hello-World#42 --status done",
  "clear": "gh dashboard clear octocat/Hello-World#42"
}
```

`assets/sprinkle/data-example/reports.json` has three example reports on the
example snapshot's records: a bb `working` report with a PR, a scoop
`needs-attention` report with a note, and a `done` report on a released PR,
which GitHub overrides. Its times match the fixture's January dates, so on a
live clock the `working` report reads stale.

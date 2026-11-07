# loose-ends store

One JSON file, owned by the `loose-ends` CLI ([SKILL.md](../SKILL.md)). Change
it through the CLI: every write replaces the whole file through a temporary
file and a rename, and bumps `updated`.

```json
{
  "version": 1,
  "updated": "2026-11-03T12:01:11.894Z",
  "tasks": [
    {
      "id": "le-call-the-bank",
      "title": "Call the bank",
      "summary": "About the replacement card; they asked for a callback after 2pm.",
      "detail": "Number +49 …, reference 12345. Ask for the card to go to the office address.",
      "created": "2026-11-01T10:00:00.000Z",
      "skills": ["outlook"],
      "url": "https://example.com/case/12345",
      "snoozedUntil": "2026-11-04T08:00:00.000Z",
      "done": "2026-11-05T09:12:00.000Z",
      "cone": "cone",
      "session": { "id": "…", "file": "…", "at": "…" }
    }
  ]
}
```

| field | meaning |
|---|---|
| `id` | Stable and unique, `le-<slug of the title>`, with `-2`, `-3` … on a collision. `--id` sets it. |
| `title` | Short and imperative. |
| `summary` | For the user: what this is and why it is still open. On the card. |
| `detail` | For the agent: the working brief. Behind the card's Brief toggle. |
| `created` | ISO time of `add`. |
| `skills` | Tags, usually the skills the work needs. `-t a,b`. |
| `url` | Optional primary link. The card shows View. |
| `snoozedUntil` | Optional ISO time; hidden until then. Snooze times are 09:00 local. |
| `done` | Optional ISO time; set by `done`, removed by `reopen`. |
| `cone` | Optional SLICC cone that filed it. |
| `session` | Optional `{ id, file, at }` pointing at the transcript it came from. Kept, not written by the CLI. |

An item is **open** when it has no `done` and no `snoozedUntil` in the future;
an expired snooze counts as open. Unknown fields are kept.

## SLICC 6 stores

SLICC 6 kept the store at `/shared/loose-ends.json` without `version`, and
removed done items instead of marking them. Such a file reads as is. The CLI
uses it in place while the default store does not exist; copy it to the
default path to move it.

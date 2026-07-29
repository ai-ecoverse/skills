# monday source protocol

The contract every source skill must satisfy to be aggregated by `monday`. A
command is **monday-compatible** when it exposes a `monday` sub-command that
accepts the standard flags and writes a JSON array of items to stdout.

## Invocation contract

`monday` calls each source exactly as:

```bash
[cmd] monday --limit N --depth N --date Nd
```

| Flag | Meaning | Passed from |
|------|---------|-------------|
| `--limit N` | Max items to return | `monday --limit` (default `50`) |
| `--depth N` | Thread/comment depth to fetch per item | `monday --depth` (default `5`) |
| `--date Nd` | Time window, e.g. `7d`, `3d`, `2w` | `monday --date` (default `7d`) |

The source **must**:

- Write a **JSON array** (`[...]`) to **stdout** — nothing else on stdout.
- Send all progress, logging, and errors to **stderr**.
- Exit `0` on success. Sources that exit non-zero, print empty stdout, or emit
  non-array / invalid JSON are logged as a `WARNING` and dropped; aggregation
  continues with the remaining sources.

Rating flags (`--rate-*`) are **local to `monday`** and are never forwarded to
sources — sources only ever see `--limit`, `--depth`, and `--date`.

## Item schema

Each element of the array is an object. Two fields are required; everything else
is passed through to the output unchanged.

| Field | Required | Type | Used by `monday` for |
|-------|----------|------|----------------------|
| `id` | **yes** | string | Deduplication. Must be **stable and unique** across runs and across sources (prefix with the source, e.g. `gh-pr-4821`). Items without an `id` are dropped during merge. |
| `ts` | recommended | string (ISO-8601) | Sorting. Newest-first for unrated output and as the tie-breaker for rated output. Missing `ts` sorts as epoch 0 (oldest). |
| `source` | recommended | string | Human-readable origin tag (`gh`, `slack`, …). |
| `title` | no | string | Passthrough (display). |
| `url` | no | string | Passthrough (display). |
| `participants` | no | string[] | Passthrough (display). |
| `body` | no | string | Passthrough; useful context for the rating agent. |
| `rating_hint` | no | string | **Source-owned rating guidance.** Injected verbatim into the rating prompt as "Source guidance" so each tool explains how to read its own fields (e.g. what `meta.merged` or a "review_requested" relationship means) without the generic aggregator hard-coding any source's semantics. Omit it and `monday` falls back to a generic instruction. |
| `meta` | no | object | Passthrough; also read by the signal guard (below). |
| _any other_ | no | any | Passed through verbatim. |

`importance`, `urgency`, `summary`, and `category` are **added by `monday`** when
a `--rate-*` flag is set — sources should not emit them.

### Rating hint (let each tool own its instructions)

Put source-specific interpretation in `rating_hint`, not in `monday`. Example
from the `github` source:

```json
{
  "id": "gh-notif-123", "ts": "2025-07-14T09:12:00Z", "source": "gh",
  "title": "Fix race condition", "url": "https://github.com/org/repo/pull/4821",
  "meta": { "state": "open", "merged": false, "relationship": "review_requested",
            "authored_by_you": false, "checks": "passing", "awaiting_checks": false },
  "rating_hint": "This is a GitHub item. meta.relationship says what is expected of the reader… If meta.merged is true or meta.state is \"closed\", category MUST be fyi. If meta.awaiting_checks is true, keep urgency low — acting now is premature."
}
```

### Signal guard (normalized disposition flags)

Independently of the rating agent, `monday` applies a small deterministic guard
from **protocol-standard** `meta` flags (when `--trust-signals` is on — the
default). Each source normalizes its own state into these; the aggregator reads
only these, never a source's raw fields:

| `meta` flag | Meaning | Effect in `monday` |
|-------------|---------|--------------------|
| `resolved: true` | Done — merged, closed, answered | Forced to `fyi` |
| `awaiting_you: true` | Your review/decision/action is requested | Kept actionable (now-eligible) |
| `waiting_on_others: true` | You've done your part; waiting on other people | Category `waiting` → the `followup` bucket (chase, don't build) |
| `not_ready: true` | Can't act yet (draft, CI pending/failing) | Held out of `now` into `later` |

A source computes these from whatever it knows (the `github` source derives them
from PR/issue state, merge/CI status, and your relationship to the thread). A
source that sets none of them is simply unaffected by the guard.

### Minimal item

```json
{ "id": "gh-pr-4821", "ts": "2025-07-14T09:12:00Z" }
```

### Typical item

```json
{
  "id": "gh-pr-4821",
  "ts": "2025-07-14T09:12:00Z",
  "source": "gh",
  "title": "Fix race condition in auth middleware",
  "url": "https://github.com/org/repo/pull/4821",
  "participants": ["alice", "bob"],
  "body": "Reproduces under load; blocks the 2.4 release."
}
```

## How `monday` consumes the contract

1. **Merge order = argument order.** Arrays are concatenated in the order the
   sources were named (`monday gh slack` → `gh` items first). With no positional
   args, discovery order (`KNOWN_COMMANDS`) applies.
2. **Dedup precedence = first-write-wins by `id`.** When two sources return the
   same `id`, the earlier source in the merge order keeps the item; the later
   duplicate is dropped. Order your positional args to set precedence.
3. **Sort.** Unrated: `ts` descending. Rated: `urgency × importance` descending,
   `ts` descending as the tie-breaker.

## Reference handler

A minimal monday-compatible handler in a source skill (jsh flavour). Read the
three flags, fetch within the window, and print one JSON array:

```javascript
// inside `mysource.jsh`, dispatched when argv is `monday ...`
async function mondayMysource(args) {
  const f = args.parseFlags();               // { limit, depth, date }
  const limit = Number(f.limit ?? 50);
  const date  = f.date ?? '7d';

  const raw = await fetchInbox({ limit, since: date }); // your API call

  const items = raw.map((r) => ({
    id: `mysource-${r.key}`,                 // stable, source-prefixed
    ts: r.updatedAt,                          // ISO-8601
    source: 'mysource',
    title: r.subject,
    url: r.link,
    participants: r.people,
  }));

  console.error(`[mysource] monday: ${items.length} items`); // progress → stderr
  console.log(JSON.stringify(items));                          // array → stdout
}
```

## Registering a new source

- **One-off / explicit:** name it as a positional arg — `monday mysource gh slack`.
  No registration needed; `monday` invokes any command you name.
- **Auto-discovery:** add the command name to the `KNOWN_COMMANDS` array in
  `scripts/monday.jsh`. With no positional args, `monday` runs `which <cmd>` for
  each known name and aggregates whichever are found on `PATH`.

The `monday` command itself is intentionally excluded from `KNOWN_COMMANDS` so it
never recurses into itself.

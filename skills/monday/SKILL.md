---
name: monday
description: >-
  Aggregate and prioritize inbox items from multiple sources (Gmail, Slack, Teams,
  Outlook, GitHub, ServiceNow) into a single ranked list. Acts as a dispatcher: each
  source skill exposes a `[cmd] monday` sub-command that returns JSON items, and the
  `monday` command merges, deduplicates, optionally rates with an AI model
  (importance times urgency), and sorts them. Use when the user asks "what should I
  work on", "Monday morning triage", "what needs my attention", "show me my inbox",
  "rank my todos", "what's urgent across all my tools", or for weekly/daily triage
  across email, chat, tickets, and pull requests.
allowed-tools: bash
---

# monday

Cross-tool inbox aggregator. Runs each available source skill's `monday` sub-command
in parallel, merges the JSON results, optionally rates each item with an AI agent,
and prints a sorted JSON array on stdout. Progress messages go to stderr.

**Source skills:** `gmail` · `slack` · `teams` · `outlook` · `github` (as `gh`) · `servicenow` — each must be installed separately and expose its own `[cmd] monday` sub-command.

## Quick start

```bash
# Auto-discover sources on PATH and aggregate the last 7 days, 50 items per source
monday

# Pick specific sources
monday gh slack --limit 20 --date 3d

# Aggregate + rate items (1-9 importance, 1-8 urgency, with summaries)
monday --rate-importance 9-1 --rate-urgency 8-1 --rate-summary 500

# Rate with a specific model and a knowledge-base context directory
monday gh --rate-importance 8-3 --rate-model haiku --rate-context /workspace/kb
```

## Aggregation pipeline

The `monday` command executes the following steps in order:

1. **Discover sources** — with no positional args, run `which [cmd]` for each name in `KNOWN_COMMANDS` and keep those found on PATH; otherwise use the names supplied as positional args.
2. **Invoke in parallel** — call `[cmd] monday --limit N --depth N --date Nd` for every discovered source concurrently.
3. **Collect and validate JSON** — sources that exit non-zero, emit empty output, or return invalid JSON are logged to stderr and dropped; aggregation continues with the rest. Each source is also truncated to `--limit`, so a source that ignores the flag cannot inflate the run.
4. **Deduplicate by `id`** — merge arrays in argument order; the first occurrence of an `id` wins. (Precedence rules: [`references/SOURCE_PROTOCOL.md`](references/SOURCE_PROTOCOL.md).)
5. **Optionally rate** — if any `--rate-*` flag is set, submit each item to the rating agent (model: `--rate-model`; optional context: `--rate-context`) to assign `importance`, `urgency`, and `summary` fields. Agents run through a bounded worker pool (`--rate-concurrency`) and no more than `--rate-max` items are rated. Rating failures fall back to the unrated item; aggregation still completes.
6. **Sort and output** — if rated, sort by `urgency × importance` descending (ties broken by `ts` descending); otherwise sort by `ts` descending. Write the final JSON array to stdout.

## Flags

| Flag | Default | Description |
|------|---------|-------------|
| `--limit N` | `50` | Max items per source |
| `--depth N` | `5` | Thread/comment depth per item (passed to sources) |
| `--date Nd` | `7d` | Time window (e.g. `3d`, `2w`) |
| `--rate-importance HI-LO` | off | Rate each item's importance on a HI..LO integer scale |
| `--rate-urgency HI-LO` | off | Rate each item's urgency on a HI..LO integer scale |
| `--rate-summary N` | off | Generate a ~N-character summary per item |
| `--rate-model NAME` | cheapest model | Rating model. Accepts an exact id from `models` or a unique case-insensitive substring (e.g. `haiku`, `us.anthropic.claude-haiku`). Validated against the live `models` catalog before any call — a typo or ambiguous fragment fails fast (exit 1) instead of running. When omitted, the cheapest haiku-class model is auto-selected. |
| `--rate-context PATH` | none | Read-only knowledge-base path the rating agent can grep |
| `--rate-concurrency N` | `4` | Parallel rating agents (bounded worker pool) |
| `--rate-max N` | `60` | Refuse to rate more than N items; the rest pass through unrated |

Positional args (`gh`, `slack`, `teams`, `outlook`, `gmail`, `servicenow`) select
which sources to invoke. With no positional args, `monday` runs `which <cmd>` on
the known source list and uses whichever are found on PATH.

`linkedin` and `tiktok` implement the protocol but are **not** auto-discovered,
because they swamp a work triage run with personal notifications. Name them
explicitly to opt in (`monday gh tiktok`).

### Rating is one model call per item

Each rated item costs one `agent` invocation, so cost and wall time scale with
the merged item count — not with the number of sources. Two guard rails keep a
run bounded: `--rate-concurrency` caps how many run at once, and `--rate-max`
caps how many are rated at all (excess items pass through unrated rather than
silently launching hundreds of calls). Start with a small `--limit` and one
source, then widen:

```bash
monday gh --limit 5 --date 1d --rate-importance 9-1 --rate-urgency 8-1
```

### Rating model is validated against the live catalog

`--rate-model` is resolved to an **exact** `models` id before any agent spawns.
This is deliberate: some model aliases pass `agent`'s `--model` validation but
are not actually applied — the spawned scoop silently falls back to the parent
model (e.g. opus at ~5× the cost of haiku; see ai-ecoverse/slicc#1752). By
resolving against `models --json` ourselves and handing `agent` an exact id, the
rating pass runs on the model you asked for, and a typo or ambiguous fragment
fails fast (exit 1, no paid calls) instead of quietly overspending. Confirm the
resolved model and per-scoop cost afterwards with `cost` / `cost --json`.

## Source protocol

A command is **monday-compatible** when `[cmd] monday --limit N --depth N --date Nd`
writes a JSON array to stdout, with each item carrying a stable `id` (for dedup)
and an ISO `ts` (for sorting); all other fields pass through unchanged.

Each source (`gmail`, `slack`, `teams`, `outlook`, `github`/`gh`, `servicenow`)
is its own separately installed skill that implements this sub-command. Full
contract — invocation flags, item schema, dedup/sort semantics, a reference
handler, and how to register a new source — is in
[`references/SOURCE_PROTOCOL.md`](references/SOURCE_PROTOCOL.md).

## Validation & troubleshooting

`monday` writes only the final JSON array to **stdout**; all discovery and
per-source progress goes to **stderr**. Redirect stdout away to watch the wiring
before trusting the output:

```bash
monday gh slack >/dev/null      # show only the diagnostics
```

Expected stderr, in order:

```text
[monday] invoking: gh monday --limit 50 --depth 5 --date 7d
[monday] invoking: slack monday --limit 50 --depth 5 --date 7d
[monday] merged 37 items from 2 sources
```

With **no positional args**, a discovery line first confirms which sources were
found on `PATH`:

```text
[monday] no sources specified, auto-discovering...
[monday] discovered: gh, slack
```

| Symptom | Cause | Fix |
|---------|-------|-----|
| `no monday-compatible commands found on PATH` | No source skills installed, or none named | Install a source skill, or name sources explicitly (`monday gh`) |
| A source missing from `merged … from K sources` | It exited non-zero, returned empty, or emitted invalid JSON | Read its `WARNING` / `output preview` on stderr; run `[cmd] monday --limit 5` directly |
| `"<cmd>" returned non-array JSON` | Source printed an object, or logged to stdout | Sources must print a JSON **array** to stdout and send logs to stderr |
| Duplicates collapsed unexpectedly | Two sources share an item `id` | First source in argument order wins — reorder positional args to set precedence |
| Empty `[]` output | Window too narrow or `--limit` too low | Widen `--date` (e.g. `14d`) or raise `--limit` |
| `NOTE: "<cmd>" returned N items for --limit K` | The source ignored `--limit`; `monday` truncated it | Harmless, but the source has a bug worth fixing — it also inflates rating cost |
| Rating never finishes / floods approval prompts | Too many items, or an old build writing one scratch file per item | Lower `--limit`, lower `--rate-max`, or reduce `--rate-concurrency`. Current builds pass prompts as arguments and write nothing |

Confirm a single source satisfies the protocol before aggregating:
`gh monday --limit 5 --date 3d | jq 'type, length'` should print `"array"` and a
count.

## Output

A single JSON array on stdout. Sorting and rating augmentation follow pipeline steps 5–6.

**Unrated item example:**
```json
[
  {
    "id": "gh-pr-4821",
    "ts": "2025-07-14T09:12:00Z",
    "source": "gh",
    "title": "Fix race condition in auth middleware",
    "url": "https://github.com/org/repo/pull/4821",
    "participants": ["alice", "bob"]
  }
]
```

**Rated item example** (with `--rate-importance 9-1 --rate-urgency 8-1 --rate-summary 200`):
```json
[
  {
    "id": "gh-pr-4821",
    "ts": "2025-07-14T09:12:00Z",
    "source": "gh",
    "title": "Fix race condition in auth middleware",
    "url": "https://github.com/org/repo/pull/4821",
    "participants": ["alice", "bob"],
    "importance": 8,
    "urgency": 7,
    "summary": "Security-critical PR awaiting your review; blocks the 2.4 release."
  }
]
```

```bash
monday gh slack --date 2d | jq '.[0:5] | .[] | {id, ts, title}'
```

## References

- [`references/SOURCE_PROTOCOL.md`](references/SOURCE_PROTOCOL.md) — the full
  source contract: invocation flags, item schema, dedup/sort semantics, a
  reference handler, and how to register a new source for auto-discovery.

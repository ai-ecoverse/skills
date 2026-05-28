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

**Source skills:** `gmail` · `slack` · `teams` · `outlook` · `github` (as `gh`) · `servicenow` — each must be installed separately and expose its own `<cmd> monday` sub-command.

## Quick start

```bash
# Auto-discover sources on PATH and aggregate the last 7 days, 50 items per source
monday

# Pick specific sources
monday gh slack --limit 20 --date 3d

# Aggregate + rate items (1-9 importance, 1-8 urgency, with summaries)
monday --rate-importance 9-1 --rate-urgency 8-1 --rate-summary 500

# Rate with a specific model and a knowledge-base context directory
monday gh --rate-importance 8-3 --rate-model claude-haiku-4-5 --rate-context /workspace/kb
```

## Aggregation pipeline

The `monday` command executes the following steps in order:

1. **Discover sources** — with no positional args, run `which <cmd>` for each name in `KNOWN_COMMANDS` and keep those found on PATH; otherwise use the names supplied as positional args.
2. **Invoke in parallel** — call `<cmd> monday --limit N --depth N --date Nd` for every discovered source concurrently.
3. **Collect and validate JSON** — read each source's stdout; any source that exits non-zero, produces empty output, or emits invalid JSON is logged to stderr and dropped. Aggregation continues with remaining sources.
4. **Deduplicate by `id`** — merge all item arrays; when two items share the same `id`, keep the one with the later `ts`.
5. **Optionally rate** — if any `--rate-*` flag is set, submit each item to the rating agent (model: `--rate-model`; optional context: `--rate-context`) to assign `importance`, `urgency`, and `summary` fields. Rating failures fall back to the unrated item; aggregation still completes.
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
| `--rate-model NAME` | `claude-haiku-4-5` | Model used by the rating agent |
| `--rate-context PATH` | none | Read-only knowledge-base path the rating agent can grep |

Positional args (`gh`, `slack`, `teams`, `outlook`, `gmail`, `servicenow`) select
which sources to invoke. With no positional args, `monday` runs `which <cmd>` on
the known source list and uses whichever are found on PATH.

## Source protocol

A command is "monday-compatible" when it accepts `<cmd> monday --limit N --depth N --date Nd` and writes a JSON array of items to stdout. Each item must include `id` (stable unique string for deduplication), `ts` (ISO timestamp for sorting), and any other fields (title, url, participants, body, etc.) which are passed through unchanged.

To add a new source, implement the protocol above and invoke it explicitly:
`monday <newcmd> gh slack`. To register it for auto-discovery, add the command name
to the `KNOWN_COMMANDS` list in the aggregator script.

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

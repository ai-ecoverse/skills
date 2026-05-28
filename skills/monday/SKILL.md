---
name: monday
description: >-
  Aggregate and prioritize inbox items from multiple sources (Gmail, Slack, Teams,
  Outlook, GitHub, ServiceNow) into a single ranked list. Acts as a dispatcher: each
  source skill exposes a `<cmd> monday` sub-command that returns JSON items, and the
  `monday` command merges, deduplicates, optionally rates with an AI model
  (importance × urgency), and sorts them. Use when the user asks "what should I work
  on", "Monday morning triage", "what needs my attention", "show me my inbox",
  "rank my todos", "what's urgent across all my tools", or for weekly/daily triage
  across email, chat, tickets, and pull requests.
allowed-tools: bash
---

# monday

Cross-tool inbox aggregator. Runs each available source skill's `monday` sub-command
in parallel, merges the JSON results, optionally rates each item with an AI agent,
and prints a sorted JSON array on stdout. Progress messages go to stderr.

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

A command is "monday-compatible" when it accepts:

```
<cmd> monday --limit N --depth N --date Nd
```

and writes a JSON array of items to stdout. Each item should include:

- `id` — stable unique string (used for deduplication)
- `ts` — ISO timestamp of last activity (used for sorting when not rated)
- arbitrary other fields (title, url, participants, body, etc.) — passed through

Sources in this skill collection that implement this protocol: `gmail`, `slack`,
`teams`, `outlook`, `github` (as `gh`), `servicenow`.

## Output

A single JSON array on stdout. When `--rate-*` flags are set, each item is
augmented with `importance`, `urgency`, and `summary` fields and the array is
sorted by `urgency × importance` descending (ties broken by `ts` descending).
Without rating, items are sorted by `ts` descending.

```bash
monday gh slack --date 2d | jq '.[0:5] | .[] | {id, ts, title}'
```

## Presenting results to the user

After running `monday`, present a concise prioritized view:

1. **Top action items** — the first 5–10 items from the sorted output. For each:
   show source, title, who acted last, and a one-line "next action" (reply,
   review, respond, close, etc.).
2. **Counts by source** — e.g. "12 GitHub, 7 Slack, 3 ServiceNow".
3. **Offer to help** with the top items: "Want me to draft a reply to X?" or
   "Should I open PR #N for review?".

When `--rate-summary` was used, lead with each item's `summary` field — it's
already condensed for presentation.

## Adding a new source

Any CLI can join the dispatcher by implementing a `monday` sub-command that:

1. Accepts `--limit`, `--depth`, `--date` flags
2. Reads the user's data for that window
3. Writes a JSON array (with at least `id` and `ts` per item) to stdout
4. Exits 0 on success

Then add the command name to the `KNOWN_COMMANDS` array in `scripts/monday.jsh`,
or just invoke it explicitly: `monday <newcmd> gh slack`.

## Failure modes

- A source that exits non-zero, returns empty stdout, or returns invalid JSON is
  logged to stderr and skipped — `monday` always finishes and returns whatever it
  could collect.
- Rating failures fall back to unrated items; the aggregation still completes.

## Inspiration

The ranking idea is borrowed from
[`ai-ecoverse/gh-monday`](https://github.com/ai-ecoverse/gh-monday) (a `gh`
extension that ranks GitHub work by who acted last). This skill generalizes the
same "show me what needs attention" concept across every tool that publishes a
`monday` sub-command.

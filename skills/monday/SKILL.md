---
name: monday
description: >-
  Aggregate and prioritize inbox items from multiple sources (Gmail, Slack, Teams,
  Outlook, GitHub, ServiceNow) into a single ranked list. Acts as a dispatcher: each
  source skill exposes a `[cmd] monday` sub-command that returns JSON items, and the
  `monday` command merges, deduplicates, optionally rates with an AI model
  (importance times urgency, and optionally effort in minutes), sorts by value or
  ROI (impact per minute), and can build a doable "now" plan under a time budget or
  top-N focus so a big inbox becomes a plan of attack rather than an overwhelming
  wall. Use when the user asks "what should I work on", "Monday morning triage",
  "what needs my attention", "show me my inbox", "rank my todos", "what's urgent
  across all my tools", "build me a plan", "what can I clear in 90 minutes", or for
  weekly/daily triage across email, chat, tickets, and pull requests.
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

# Estimate effort and rank by quick wins first (impact per minute)
monday gh --rate-importance 9-1 --rate-urgency 8-1 --rate-effort --sort roi

# Backpressure: turn a big inbox into a doable 90-minute plan
monday --rate-importance 9-1 --rate-urgency 8-1 --rate-effort --budget 90m

# Or just the top 5 as "now", everything else ranked as "later"
monday --rate-importance 9-1 --rate-urgency 8-1 --focus 5
```

## Aggregation pipeline

The `monday` command executes the following steps in order:

1. **Discover sources** — with no positional args, run `which [cmd]` for each name in `KNOWN_COMMANDS` and keep those found on PATH; otherwise use the names supplied as positional args.
2. **Invoke in parallel** — call `[cmd] monday --limit N --depth N --date Nd` for every discovered source concurrently.
3. **Collect and validate JSON** — sources that exit non-zero, emit empty output, or return invalid JSON are logged to stderr and dropped; aggregation continues with the rest. Each source is also truncated to `--limit`, so a source that ignores the flag cannot inflate the run.
4. **Deduplicate by `id`** — merge arrays in argument order; the first occurrence of an `id` wins. (Precedence rules: [`references/SOURCE_PROTOCOL.md`](references/SOURCE_PROTOCOL.md).)
5. **Optionally rate** — if any `--rate-*` flag is set, submit each item to the rating agent to assign `importance`, `urgency`, `summary`, a `category` (`fyi` \| `confirm` \| `review` \| `respond` \| `act` — what the item asks of you), a derived `actionable` flag (`category !== 'fyi'`), and — with `--rate-effort` — an `effort_minutes` estimate plus a coarse `effort_band` (`quick`/`short`/`deep`). Agents run through a bounded worker pool (`--rate-concurrency`) and no more than `--rate-max` items are rated. Rating failures fall back to the unrated item; aggregation still completes.
6. **Sort** — order by `--sort`: `roi` (impact per minute — the default when `--rate-effort` is on), `value` (importance × urgency), or `newest`. Unrated runs always fall back to `ts` descending.
7. **Plan (backpressure)** — split actionable to-dos from informational **FYI** items (merged PRs, closed issues, notifications). If `--focus N` or `--budget DURATION` is set, promote a doable slice of to-dos to a `now` bucket and hold the rest as `later`; FYI items go to a separate `fyi` bucket that never consumes the time budget. Each item gets a `bucket` field and a one-line plan summary prints to stderr. The goal is a doable slice, not a wall (see [Backpressure](#backpressure-a-plan-not-a-wall) and [Presentation](#presentation-render-as-a-dip-not-a-wall)).
8. **Output** — write the final JSON array to stdout.

## Flags

| Flag | Default | Description |
|------|---------|-------------|
| `--limit N` | `50` | Max items per source |
| `--depth N` | `5` | Thread/comment depth per item (passed to sources) |
| `--date Nd` | `7d` | Time window (e.g. `3d`, `2w`) |
| `--rate-importance HI-LO` | off | Rate each item's importance on a HI..LO integer scale |
| `--rate-urgency HI-LO` | off | Rate each item's urgency on a HI..LO integer scale |
| `--rate-summary N` | off | Generate a ~N-character summary per item |
| `--rate-effort` | off | Estimate `effort_minutes` per item plus a `quick`/`short`/`deep` band. Powers `--sort roi` and `--budget`. |
| `--rate-model NAME` | cheapest model | Rating model. Accepts an exact id from `models` or a unique case-insensitive substring (e.g. `haiku`, `us.anthropic.claude-haiku`). Validated against the live `models` catalog before any call — a typo or ambiguous fragment fails fast (exit 1) instead of running. When omitted, the cheapest haiku-class model is auto-selected. |
| `--rate-context PATH` | none | Read-only knowledge-base path the rating agent can grep |
| `--rate-concurrency N` | `4` | Parallel rating agents (bounded worker pool) |
| `--rate-max N` | `60` | Refuse to rate more than N items; the rest pass through unrated |
| `--sort MODE` | `roi` if `--rate-effort` else `value` | Ranking: `roi` (impact per minute — best bang-for-buck first), `value` (importance × urgency), or `newest` (timestamp) |
| `--focus N` | off | Promote only the top N to-dos to the `now` bucket; the rest become `later` |
| `--budget DURATION` | off | Pack the highest-ranked to-dos that fit a time box (`90m`, `2h`, `1h30m`) into `now`; needs `--rate-effort` |
| `--no-cache` | off | Don't reuse or write cached ratings this run |
| `--include-ignored` | off | Show items on the done/ignore list anyway |
| `--no-trust-signals` | off | Don't override the rater from source relationship metadata |

**Management subcommands** (persist state under `$MONDAY_HOME` / `~/.monday`):

| Command | Effect |
|---------|--------|
| `monday done <id>...` | Mark handled — hidden from all future runs |
| `monday ignore <id>...` | Never show these items again |
| `monday mute <id>...` | Silence forever (alias of ignore) |
| `monday restore <id>...` (aliases `unignore`, `unmute`) | Undo a done/ignore/mute |
| `monday ignored` (aliases `list-ignored`, `muted`) | Print the silenced list (JSON on stdout) |
| `monday cache-clear` (alias `forget-cache`) | Wipe the rating cache |


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

### Effort and ROI ranking

`--rate-effort` asks the rater for an `effort_minutes` estimate — how long it
would take *you* to actually resolve the item, not read it — plus a coarse
`effort_band` (`quick` ≤15m, `short` ≤60m, `deep` >60m). That unlocks two views
beyond raw importance × urgency:

- `--sort roi` ranks by **impact per minute**, so a high-value item that costs
  two hours sinks below three five-minute wins. This is the "what can I clear
  before my next meeting" order.
- `--budget 90m` (below) uses effort to pack a realistic session.

Effort is an AI estimate — treat it as a hint, not a stopwatch. Items the rater
can't size are assumed 30 minutes so they neither dominate nor vanish.

## Backpressure: a plan, not a wall

A ranked list of 150 items is still a wall. Humans bring judgement, context, and
intuition an AI can't — but they're easy to overwhelm, and a giant inbox invites
paralysis, not progress. `monday`'s job is to hand you a **doable slice** and
keep the rest ranked-but-out-of-sight until you ask.

Two knobs shape the plan; both tag every item with a `bucket` field
(`"now"` | `"later"`) and emit the `now` items first:

- **`--focus N`** — only the top N are `now`; everything else is `later`. Start
  your day with five things that matter, not a scroll of eighty.
- **`--budget DURATION`** — pack the highest-ranked items whose cumulative
  `effort_minutes` fit the time box (`90m`, `2h`, `1h30m`) into `now`; the rest
  become `later`. Combine with `--sort roi` for a max-impact session. When both
  `--focus` and `--budget` are set, the budget packs by time but never exceeds
  the focus count.

A one-line plan summary prints to stderr, e.g.:

```text
[monday] plan: 4 now (~85m), budget 90m · 46 later. Start with the "now" bucket; the rest stay ranked for when you're ready.
```

When a rated run is large (>12 items) and neither knob is set, `monday` nudges
you toward them on stderr rather than silently dumping the backlog. The default
output is unchanged and fully backward-compatible — `bucket` only appears once
you opt into a plan.

## State: rating cache, done/ignore list, and signal trust

`monday` keeps a little persistent state under `$MONDAY_HOME` (default
`~/.monday`, or `/shared/monday` when there is no home dir):

**Rating cache** (`rating-cache.json`). Every rating is cached, keyed by the
item's content **and** the rating parameters and model. A rerun only pays for
new or changed items — an unchanged inbox re-rates for free. The key includes
the importance/urgency scales, summary length, effort flag, context path, and
resolved model, so changing any of them correctly invalidates. Bypass with
`--no-cache`; wipe with `monday cache-clear`.

**Done / ignore list** (`suppress.json`). Dismiss an item permanently so it
never resurfaces:

```bash
monday done   gh-notif-24826743046      # handled it
monday ignore gh-notif-24826743046      # never show me this again
monday mute   gh-notif-24826743046      # silence forever (alias of ignore)
monday ignored                          # list what's silenced (JSON on stdout)
monday restore gh-notif-24826743046     # bring it back
```

Suppressed items are filtered right after merge (before rating, so they cost
nothing). `--include-ignored` shows them anyway. The ids are the stable `id`
field from monday's output — the same ones the dip's Done / Later buttons send
back via `slicc.lick`, so the presentation loop can call `monday done <id>`
directly.

**Signal trust.** Sources may tag items with relationship metadata
(`meta.authored_by_you`, `meta.relationship` = `review_requested` / `mention` /
`assign`, `meta.state`). When present, `monday` trusts these over the rater: an
item you were asked to review, or authored and left open, stays **actionable**
even if the rater guessed `fyi` (it is retagged `category: review` and marked
`reclassified_by_signal`). Merged/closed items are never resurfaced. Disable the
override with `--no-trust-signals`. The `github` source populates these fields
for notifications, review requests, and assigned issues.



## Presentation: render as a dip, not a wall

`monday` emits data; **how that data reaches the human decides whether it feels
like a plan or a defeat.** When you (the cone) surface a triage run to the user,
do not paste the raw JSON array. Render it as a [dip](../dips/SKILL.md) — an
inline, ephemeral chat widget.

**The turnkey path is the bundled `monday-dip` renderer** — it is the canonical
presentation template, so you never hand-assemble the widget:

```bash
monday gh --rate-importance 9-1 --rate-urgency 8-1 --rate-effort --budget 90m \
  > /tmp/plan.json 2>/dev/null
monday-dip /tmp/plan.json          # prints the dip shtml; emit it in chat
```

`monday-dip` reads a `monday` JSON plan and prints a `.sprinkle-action-card`
`shtml` block to stdout. Emit that block verbatim in your reply. It encodes the
principles below so they stay consistent:

1. **Three lists, in priority order.** The `now` bucket (the doable to-do slice)
   is shown big and first; `later` collapses behind a count; **`fyi`** (merged
   PRs, closed issues, build notifications — awareness only, marked
   `actionable: false`) is a separate collapsed list that never competes for
   attention.
2. **Bang-for-buck order.** `now` is presented in monday's ROI order (impact per
   minute), so the best-value work leads.
3. **No meaningless numbers.** Items show a priority *word* (Critical / High /
   Medium / Low) and the effort/time — never the raw importance×urgency score,
   which means nothing to a human.
4. **Icons, not emoji.** All glyphs are Lucide (`<i data-lucide="…"
   class="sprinkle-icon">`), per the S2 style guide's "NO EMOJIS" rule.
5. **A loop, not a report.** Each to-do has Open (`url`) plus Done / Later
   buttons that `slicc.lick({action, data})` back; card-level Start / Re-plan
   actions let the user drive the next step. Handle those licks (mark done,
   re-run with a wider `--budget`, etc.).

If you must build the widget by hand (e.g. a bespoke layout), read
[`scripts/monday-dip.jsh`](scripts/monday-dip.jsh) as the reference structure.
Keep the JSON contract intact for scripts; the dip is a presentation layer on
top, not a replacement.


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
| `--sort roi` had no effect / warned | `--sort roi` needs effort estimates | Add `--rate-effort`; without it monday falls back to `--sort value` |
| `--budget` put everything in `later` | Budget smaller than the cheapest item's effort, or no `--rate-effort` (items assumed 30m) | Raise the budget, add `--rate-effort` for real estimates, or use `--focus N` instead |
| Still feels like a wall | Presented raw JSON instead of a plan | Use `--focus`/`--budget` and render the `now`/`later` buckets as a dip — see [Presentation](#presentation-render-as-a-dip-not-a-wall) |

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

**Rated item example** (with `--rate-importance 9-1 --rate-urgency 8-1 --rate-summary 200 --rate-effort --budget 90m`):
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
    "summary": "Security-critical PR awaiting your review; blocks the 2.4 release.",
    "category": "review",
    "actionable": true,
    "effort_minutes": 20,
    "effort_band": "short",
    "bucket": "now"
  }
]
```

`category` (`fyi`/`confirm`/`review`/`respond`/`act`) and its derived
`actionable` flag appear on every rated item; `effort_minutes` / `effort_band`
appear only with `--rate-effort`; `bucket` (`now` | `later` | `fyi`) appears
once a plan is active. Without those flags the output is unchanged from the
plain rated shape (`importance` / `urgency` / `summary`).

```bash
monday gh slack --date 2d | jq '.[0:5] | .[] | {id, ts, title}'
```

## References

- [`references/SOURCE_PROTOCOL.md`](references/SOURCE_PROTOCOL.md) — the full
  source contract: invocation flags, item schema, dedup/sort semantics, a
  reference handler, and how to register a new source for auto-discovery.

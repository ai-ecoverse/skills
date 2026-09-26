# The poller: interval and failure behaviour

Detail behind the "Keeping the snapshot fresh" section of SKILL.md: why the
default interval is 30 minutes, and what the unit does when a fetch fails. The
commands to start, inspect and stop the unit are in SKILL.md.

## The interval, and why it is 30 minutes

Measured, not guessed (two consecutive real runs against two repositories, ~100
records):

| run | wall | agent calls | status cache | GitHub requests |
| --- | --- | --- | --- | --- |
| 20 hours stale | 761 s | 21 | 10 hits / 21 misses | 187 |
| warm, ~35 min later | 388 s | 9 | 25 hits / 9 misses | 185 |

The status cache is keyed on each record's `lastActivityAt`, so a record costs an
agent call only when it has **new activity**. That is the whole cost argument:

- **Model spend tracks repository activity, not poll frequency.** Polling twice as
  often does not double the agent calls; it splits the same work into smaller
  runs. If anything, a longer interval is marginally cheaper, because several
  changes to one record coalesce into a single call.
- **What frequency multiplies is the fixed per-run cost**: ~185–190 GitHub
  requests and the non-agent wall time. At 30 minutes that is ~380 requests/hour
  against a 5,000/hour limit (~8%; measured 4,366/5,000 remaining after a run).
- A warm run takes 6.5 minutes, so a 30-minute interval leaves the unit idle ~78%
  of the time. Shorter intervals start eating their own tail for freshness the
  panel cannot use — it already notices a new snapshot within five seconds.

Override for a short proving run (the default stays 30 minutes):

```sh
jshd start -n github-dashboard-poll --enable --restart on-failure \
  --env GHD_POLL_INTERVAL_MS=60000 /shared/sprinkles/github-dashboard/poll.jsh
```

## Failure behaviour

A failing **fetch** cannot spin the unit: the fetch runs inside a try/catch, a
non-zero exit is logged and counted, and after three consecutive failures the
interval backs off to two hours until one succeeds. So a broken config or an
expired credential cannot burn requests overnight. `--restart on-failure`
therefore applies only to the unit script itself dying — which has been observed
once, when a transient runtime asset-load failure killed a run after nine
seconds. That run left the previous snapshot and its version file untouched.

A cycle also refuses to start while the previous one is still running: they share
the status cache and the output files.

## Agent-spend ledger

Each cycle the fetcher records its status-model calls in the snapshot's
`meta.agentLedger` and appends one JSON line to `data/agent-ledger.jsonl`, capped
at the newest 2000 lines and 1,000,000 bytes (if the append fails, the cycle's
spend is still in `meta.agentLedger`). `poll.jsh` logs it as one line per cycle:

```
  agents: 5 calls (haiku-4-5), 514.9 s agent time (max 103.6 s), 70 cached, 0 failed
```

`agent` exposes no token counts, so there is no cost figure: `tokens` and
`costEstimate` are `null`, with the reason in `tokensWhy` and `costWhy`. Tests:
`tests/agent-ledger.test.js` (the ledger) and `tests/poll-ledger.test.js` (the
log line).

## Fast thread state

`scripts/thread-poll.jsh` (unit `github-dashboard-threads`) lists the live bb
threads of every configured project once a minute and writes
`data/threads.json`: for each thread, the fields the panel needs (`state`, `live`,
`archived`, `busy`, `hasPendingInteraction`, `queuedWork`, `updatedAt`). `live`
and `busy` are decided once, from the raw thread, by `thread-stage-shared.cjs`.
The file is rewritten only when that content changes (a hash without timestamps),
through a temporary file and a rename, so the panel never reads half a file.

The panel reads the file on its five-second tick and overlays the state onto
threads the snapshot already links; it never adds a link. An entry older than the
snapshot's copy of the thread is ignored, and a thread missing from the file
keeps its snapshot state. Open issues then take their stage from the fresh state:

| thread | open issue |
| --- | --- |
| waiting on the operator (pending interaction) | needs attention |
| busy (running, queued, or with active background work) | active |
| **settled**: live, nothing in flight, nothing pending (idle or error) | needs attention, "thread settled" |
| archived | the snapshot's stage, on the usual clock |

A settled issue stalls after five working days without activity, counted from the
later of the thread's `updatedAt` and the issue's own activity. Pull requests keep
their GitHub-driven stages; the overlay does not change them.

bb reports a running thread as status `active` (as well as through its activity
counts), so `active` counts as busy. The fetcher and the panel share one copy of
the stage mapping: `thread-stage-shared.cjs`, embedded in the panel by
`scripts/embed-thread-stage.js`; `tests/thread-stage-drift.test.js` fails if the
copies diverge.

Cost: one bb list call per project per minute (about 5 to 20 seconds per run
measured), no GitHub requests and no model calls. Unchanged runs are folded into
one log line per 30 minutes.

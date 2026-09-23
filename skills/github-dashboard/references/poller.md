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

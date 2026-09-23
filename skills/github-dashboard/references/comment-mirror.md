# The comment mirror: what it publishes, and why

Detail behind the "Mirroring your marks back onto the card" section of
SKILL.md: the publishing rules, snooze expiry, why the mirror is a reconciler,
what the sweep costs, and why the poller leaves it off by default. The commands
and the example body are in SKILL.md.

## It publishes the fact, never the prose

`data/user-state.json` holds free-text `snoozeReason` notes you wrote to
yourself. **Those never leave the machine.** Only four fields are publishable —
`snoozedUntil`, `doneAt`, `scoopRequestedAt`, `actionsDispatched` — and each
renders as a fixed sentence plus a **date**; no stored string is ever
interpolated into a body. `actionsDispatched` keys carry a model-generated
label, so only the *kind* and the date are published, never the label.

Two independent mechanisms enforce this, because a GitHub comment cannot be
un-published: the field allowlist above, and a runtime **prose gate** that
compares the composed body against every withheld value and aborts with exit 3,
writing nothing, if any 16-character window of one appears. The gate has been
proven to fire by deliberately adding `snoozeReason` to the allowlist in a copy.

## An expired snooze is not published

`snoozedUntil` is the only mark that points at the future, so it is the only one
that can go stale: the day after "Snoozed until 2026-09-22" that comment asserts
a filing state that has lapsed, on a public card, maintained by a bot. Once the
instant passes, the fact is **dropped**; if that leaves nothing true, the comment
is **deleted** — the same path as a cleared mark, and it needs no `--sweep`
because the mark is still in `user-state.json` for the reconciler to find.

The other three marks are historical — "marked done on", "handed to an agent on",
"dispatched on" — and are as true next month as the day they happened, so they
never expire.

The boundary is the **exact instant**, reusing the panel's own test
(`snoozeState`: `expired: until <= now`), not end-of-day. The mirror must never
contradict the panel; `snoozedUntil` is computed as *click time + N days* so
there is no day boundary to honour; and no user timezone is recorded anywhere, so
an end-of-day rule would have to guess one. The body prints the date only
(minimal disclosure), so on the final day the comment disappears part-way through
a day it still names — correct, because the filing really has lapsed, and the
panel remains the precise view, showing `2026-09-22 20:09Z`.

> **`lastCommentAt` must ignore the mirror's own comment.** The panel treats a
> snooze as cancelled when a comment postdates it, so the fetcher excludes
> comments that carry the `ghd-mirror` marker and were written by the
> authenticated user, and Bot-authored comments. Without that, the mirror's own
> post would make every snooze it publishes look cancelled in the panel, and
> re-snoozing would restart the backoff. The damage stays local: the mirror
> decides a snooze from its expiry alone, never from comments, so it neither
> deletes nor re-posts.

## Why a reconciler and not a button

The comment is not posted by the panel's snooze button. This runtime delivers a
lick more than once, so a write in the button path double-posts, and it would do
nothing while the panel is closed. Instead the program compares desired state
(your marks) with observed state (the card) and issues only the difference:

| state | action |
| --- | --- |
| marks, no mirror | create (`gh issue comment`, which serves PRs too) |
| marks, mirror differs | `PATCH /repos/:o/:r/issues/comments/:id` (no edit verb exists in `gh`) |
| marks, mirror matches | nothing — no request |
| no marks, mirror present | delete |

Running it twice is indistinguishable from running it once, so a crash mid-write,
a re-run and a replayed lick all converge. **There is no new local state**: the
mirror is found by the invisible `<!-- ghd-mirror:v1 -->` marker plus the author
login, read back from the API, so nothing can drift out of sync. Every write is
verified by re-reading the card, because `gh` here can exit 0 while failing.

The body is a **pure function of the marks** — deliberately no "last synced"
timestamp, or a 30-minute poller would PATCH it for ever and notify everyone
watching each time.

Only marks are mirrored. Stage, CI and review state are derived and would rot on
a public card unattended; attachments belong to the `github` skill.

## The sweep, and what it costs

When you clear the last mark the panel deletes the whole entry, so nothing local
remembers where that mirror went — the common case, since a mark cleared at
10:05 is already gone when the poller runs at 10:30. Finding those orphans needs
a remote sweep, bounded to snapshot records with `commentsCount > 0` minus the
marked keys. It is **off by default** because it was measured:

| run | requests | wall |
| --- | --- | --- |
| marks only (5 marks) | 6 | 27 s |
| with `--sweep` (87 candidate cards of 108) | 93 | 367 s |

13.6x the cost, six minutes of a thirty-minute interval, to catch a rare event
whose cost when missed is one stale "snoozed until …" comment. Re-measure if the
repo set grows: it is linear in commented cards and latency-bound at ~4 s/GET.

## Turning it on in the poller

The poller runs the reconciler after each successful fetch, but **it is dormant
unless asked**:

```
jshd start -n github-dashboard-poll --enable --restart on-failure \
  --env GHD_MIRROR=dry ...          # reconcile and log the plan, write nothing
  --env GHD_MIRROR=live ...         # write
  --env GHD_MIRROR_SWEEP_EVERY=48   # sweep every N successful cycles (default 48 = daily)
```

Off by default on purpose: enabling it means an unattended unit writes to public
cards, which should be a deliberate act by whoever starts the unit rather than a
consequence of deploying a file. A mirror failure never fails the cycle — the
fetch is the unit's job, and a GitHub hiccup must not trip the fetch backoff.

Writes are confined to the repos in your config; a mark for any other repo is
refused before a single request is made.

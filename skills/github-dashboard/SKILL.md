---
name: github-dashboard
description: >
  Installs and opens the `github-dashboard` sprinkle — a persistent panel showing
  GitHub work as cards in five derived groups: needs attention, actively being
  worked on, snoozed (with Fibonacci backoff), stalled, and done. Use when the
  user asks for a GitHub work dashboard, a triage panel for issues and PRs, "what
  needs my attention on GitHub", "what are my agents working on", "what is
  stalled", "what did I snooze", or wants to review the state model behind such a
  panel. Each card renders one pipeline state — open issue, draft PR, CI failing,
  in review, changes requested, merge queue, merged, released — as a coloured
  glyph and a coloured top border. The panel reads a snapshot file produced by
  `scripts/fetch-snapshot.mjs`, which calls the GitHub API; the panel itself
  makes no network calls. WORK IN PROGRESS on a draft PR: the pieces described
  below are implemented and tested, but this has only ever run against one
  operator's repositories, so treat the numbers, the stage table and the
  thread-linkage heuristics as provisional.
allowed-tools: bash
---

# github-dashboard

A sprinkle panel that renders GitHub work as a card wall, plus the fetcher that
produces the data it reads. Two programs, one file each, deliberately separate:

- **`scripts/fetch-snapshot.mjs`** talks to GitHub (and optionally a bb server),
  derives a stage per record, writes `snapshot.json` and `version.json`.
- **`assets/sprinkle/github-dashboard.shtml`** is the panel. It reads those two
  files through the sprinkle VFS bridge, derives a category from stage plus
  timestamps, and writes only the operator's own marks. It makes no API calls.

## State of this skill

Implemented and exercised: the five groups and their derivation, live updates by
polling a hash file, markdown rendering of GitHub prose behind a sanitiser, a
per-card quick view in two modes, three per-card actions that write local marks,
a three-way Go control, and clickable follow-up actions that emit a lick to the
cone. What is *not* settled:

- it has run against one operator's repositories only, so the stage table and the
  thread-linkage rules are tuned to one working style;
- the status prose is model-written, and an action's stated evidence can be stale
  by the time a human clicks it (see "Known problems");
- nothing here has been reviewed by anyone but its author.

## Install

```sh
# 1. put the built panel where sprinkles live, and its data alongside
mkdir -p /shared/sprinkles/github-dashboard/data
cp assets/sprinkle/github-dashboard.shtml /shared/sprinkles/github-dashboard/
cp assets/sprinkle/data-example/*.json     /shared/sprinkles/github-dashboard/data/

# 2. say which repositories to follow (REQUIRED — there are no defaults)
mkdir -p /shared/github-monitor
cat > /shared/github-monitor/config.json <<'JSON'
{
  "version": 1,
  "bbOrigin": "https://bb.example.invalid",
  "repos": [{ "slug": "owner/repo", "bbProject": null }]
}
JSON

# 3. open it
sprinkle open github-dashboard
```

The example data in step 1 is a hand-written fixture with four invented records:
it exists so the panel renders something on first open. Replace it by running the
fetcher:

```sh
node scripts/fetch-snapshot.mjs                 # writes snapshot.json + version.json
node scripts/fetch-snapshot.mjs --check-config  # resolve config and exit
```

The fetcher needs a GitHub token in the environment it runs in. It refuses to
start when `/shared/github-monitor/config.json` is missing rather than following
repositories nobody chose.

## Keeping the snapshot fresh (the poller)

The fetcher is a one-shot program. `scripts/poll.jsh` is the durable unit that
runs it on a schedule, supervised by `jshd`:

```sh
jshd start -n github-dashboard-poll --enable --restart on-failure \
  /shared/sprinkles/github-dashboard/poll.jsh

jshd ls                                  # note: ls, not list
jshd status github-dashboard-poll
jshd logs   github-dashboard-poll -n 40  # one line per cycle
```

**Turning it off** — whoever installs this needs both:

```sh
jshd stop github-dashboard-poll   # stop now; the unit record and log remain,
                                  # and --enable means a reload starts it again
jshd disable github-dashboard-poll # leave it running but do not restore on reload
jshd rm   github-dashboard-poll   # stop AND delete the unit record and its log
```

`stop` alone is not permanent while the unit is enabled: on the next reload the
supervisor starts it again. Use `rm` (or `disable`) to mean it.

### The interval, and why it is 30 minutes

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

### Failure behaviour

A failing **fetch** cannot spin the unit: the fetch runs inside a try/catch, a
non-zero exit is logged and counted, and after three consecutive failures the
interval backs off to two hours until one succeeds. So a broken config or an
expired credential cannot burn requests overnight. `--restart on-failure`
therefore applies only to the unit script itself dying — which has been observed
once, when a transient runtime asset-load failure killed a run after nine
seconds. That run left the previous snapshot and its version file untouched.

A cycle also refuses to start while the previous one is still running: they share
the status cache and the output files.

## Mirroring your marks back onto the card (the comment mirror)

`scripts/mirror-comments.mjs` publishes **your own marks** onto the GitHub item
they belong to, as a single comment it keeps converged:

```
node scripts/mirror-comments.mjs                 # dry run: prints the plan and the exact bodies
node scripts/mirror-comments.mjs --live          # apply
node scripts/mirror-comments.mjs --live --sweep  # also remove mirrors whose marks are gone
```

A mirrored comment looks like this, and this is the whole of it:

```markdown
<!-- ghd-mirror:v1 -->
**Filed on my dashboard**

- Snoozed until 2026-10-03
- Handed to an agent from my dashboard on 2026-09-22
- 1 follow-up dispatched from my dashboard, most recently 2026-09-22 (1 nudge)

<sub>Posted and kept up to date automatically by my own GitHub dashboard. ...</sub>
```

### It publishes the fact, never the prose

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

### An expired snooze is not published

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

### Why a reconciler and not a button

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

### The sweep, and what it costs

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

### Turning it on in the poller

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

## Build

The panel is a **built artifact**. Its markdown renderer is bundled from
`src/markdown.js` plus two vendored libraries:

```sh
./scripts/build.sh
```

That is the whole command: no network, no package install (the dependencies are
vendored under `src/vendor/`, with versions and hashes in `src/vendor/VENDOR.md`).
The script detects whether it is running in this repository or next to a deployed
panel, and is idempotent — run it twice and the artifact is byte-identical. It
splices the bundle between the `GHD-BUNDLE` markers in the `.shtml`; never
hand-edit that region.

Do not edit `assets/sprinkle/github-dashboard.shtml` outside those markers
expecting the build to preserve it — the rest of the file *is* the source and is
edited directly; only the marked region is generated.

## Security: the markdown renderer is the sharp edge

The panel renders issue bodies and comments — text written by anyone who can
comment on a followed repository. A sprinkle panel is **not** sandboxed from the
filesystem: the bridge can enumerate sibling scoop folders, run shell commands,
and read and write files. So script execution inside this panel is arbitrary
command execution, and `marked(text)` into `innerHTML` would be a
remote-code-execution path.

What the renderer does instead, argued at length in the header of
`src/markdown.js`:

- marked → DOMPurify with an explicit tag/attribute allowlist → a DOM fragment
  that is appended; untrusted HTML is never assigned to `innerHTML`;
- links are restricted to http/https/mailto and forced to
  `target="_blank" rel="noopener noreferrer"`;
- **images render only from `github.com` and `*.githubusercontent.com`, over
  https**, with the host decided by the URL API rather than a regex. `img` is
  deliberately *not* in the sanitiser allowlist: the renderer emits an inert
  placeholder and builds the `<img>` itself, so no unvetted `src` ever reaches an
  image element. A trusted host can still redirect, so the allowlist bounds who
  is asked, not who answers.

The acceptance gate is 66 fixtures — `<script>`, `<img onerror>`, `<svg onload>`,
`javascript:`/`data:`/`vbscript:` URLs, mXSS, host-lookalikes, credentials in the
authority, attributes the policy does not allow:

```sh
./scripts/build.sh                                   # regenerates the gate page
open tests/xss-gate.html                             # verdict on the page and in the tab title
```

It must read `GATE GREEN — 66 passed, 0 failed, window.__xssFired = never set`.
Re-run it after any change to the renderer. The gate has been demonstrated to go
**red** (a naive `innerHTML` build fails 25 of the 29 pre-image fixtures and
executes; trusting any image host fails 14), which is the only reason to believe
it works.

## What the panel does

- **Five groups**, derived — never stored: needs attention, stalled, actively
  being worked on, snoozed, done. A sixth outcome, aged-out, is counted and
  hidden. The derivation is one pure function (`categorize`) over stage plus
  timestamps plus the operator's own marks.
- **Live updates**: the panel polls a small `version.json` every five seconds and
  reads the snapshot only when its content hash changes, then reconciles card by
  card instead of re-rendering.
- **Quick view**, in two modes from one resolver: hovering a card's status line
  opens a non-modal view that takes no focus and closes shortly after the pointer
  leaves both surfaces; clicking or pressing Enter opens a modal one that stays
  until dismissed. Markdown is rendered lazily here and cached per record and
  content hash.
- **Three per-card actions**, all local: snooze (Fibonacci backoff, and in the
  snoozed column the same control un-snoozes), done (a local mark; nothing is
  written to GitHub), and a Go control with three destinations — the bb thread if
  one is attached or linked, "start a scoop" for live work with no thread, or the
  item on GitHub for finished work. A finished item never offers to start work.
- **Follow-up actions** from the snapshot render as buttons in the quick view: a
  *nudge* dispatches its instruction to the cone; a *clarification* is raised as a
  question instead, because an agent cannot answer it.
- Nothing the panel does writes to GitHub. Its only writes are
  `data/user-state.json` (the operator's marks) and licks to the cone.

## Suggested follow-ups: which kinds get a control

The fetcher's agents attach `actions` to a record, each with a `kind`. The panel
renders one control per action, and **a kind must be registered to get one**:

| kind | glyph | control | lick |
| --- | --- | --- | --- |
| `nudge` | `send` | Dispatch this instruction | `do-nudge` |
| `clarify` | `message-circle-question` | Raise with the cone | `clarify-question` |
| `approve` | `scan-eye` | Ask for a safety check | `review-before-approval` |
| anything else | `circle-dashed` | **none** — an inert chip | none |

`approve` actions in live data say "Approve and merge" and "Merge when ready".
The panel performs no GitHub writes, and handing the write to an agent would be
worse rather than better — it moves an irreversible act further from the person
answerable for it. So the button asks for the work that stops SHORT of the write:
read the item now and report whether approving looks safe. That is worth asking
precisely because the grounds attached to the action ("All 2 CI checks passing")
come from a snapshot, and a stale CI summary is a mistake this project has
already made once. **The lick is named for what it asks** —
`review-before-approval`, never `do-approve`: a name that reads as an imperative
to approve is how a mislabelled instruction becomes an unwanted write at the
other end, and the note repeats the prohibition in words.

An **unregistered kind renders inert**: a chip saying "No action for “<kind>” in
this panel", no button, no listener, nothing dispatchable. This is the important
half. Before this, the code asked `kind === 'clarify' ? … : …` in four places, so
every unrecognised kind fell through to NUDGE — wrong glyph, wrong copy, and a
`do-nudge` lick that offered to dispatch a GitHub write as an instruction. The
kinds are model-generated, so the next unknown one is a matter of time; the
fall-through now points at "do nothing and say so".

Adding a kind is one entry in `ACTION_KINDS` and no other edit.

## Known problems

- **An action's evidence can be false.** Follow-up actions are generated with the
  snapshot and are not re-checked at click time, so an instruction can describe a
  state that has since changed — including work that has already merged. Treat
  the button as a request to look, not as a fact.
- **Thread linkage is heuristic.** Linking a bb thread to a record requires an
  explicit `#N` in the thread title; branch-name digits are rejected because they
  truncate and collide. Expect misses rather than wrong links.
- **Status prose is model-written** and cached per record and last-activity time.
  It can be confidently wrong.
- The panel holds an operator's marks in a plain JSON file with no schema
  migration beyond a version field.

## Files

```
SKILL.md                                  this file
references/domain-model.md                stages, categories, and the derivation
assets/sprinkle/github-dashboard.shtml    the panel (BUILT — see Build)
assets/sprinkle/data-example/             synthetic snapshot + version, 4 records
scripts/build.sh                          the one build command
scripts/fetch-snapshot.mjs                the fetcher (GitHub + optional bb)
scripts/poll.jsh                          the durable poller unit (jshd)
scripts/mirror-comments.mjs               mirrors your marks onto the card (opt-in)
src/markdown.js                           sanitising markdown renderer (bundled)
src/vendor/                               pinned marked + DOMPurify, with hashes
tests/xss-fixtures.json                   66 acceptance fixtures (data)
tests/gate-runner.js                      the gate's assertions
tests/xss-gate.html                       GENERATED by build.sh — open to run
```

## Colours

Every colour is a design-system token or a token pair; there are no literal
colour values and no `prefers-color-scheme` rules. Group tone, card border and
state glyph all come from the same derived state, so a card cannot disagree with
its column.

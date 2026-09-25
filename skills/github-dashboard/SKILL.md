---
name: github-dashboard
description: >
  Installs and runs the `github-dashboard` sprinkle, a panel showing GitHub
  issues and PRs as cards in five derived groups: needs attention, actively
  being worked on, snoozed (Fibonacci backoff), stalled, and done. Each card
  renders one pipeline state (open issue, draft PR, CI failing, in review,
  changes requested, merge queue, merged, released) as a coloured glyph and top
  border. Covers the fetcher that calls the GitHub API and writes the snapshot
  the panel reads (the panel makes no network calls), the poller that refreshes
  it, and an opt-in mirror of the operator's own marks onto GitHub comments. Use
  when the user asks for a GitHub work dashboard, a triage panel for issues and
  PRs, "what needs my attention on GitHub", "what are my agents working on",
  "what is stalled", "what did I snooze", or wants to review the state model
  behind such a panel. Work in progress, run against one operator's repositories
  only: treat its numbers, stage table and thread-linkage rules as provisional.
allowed-tools: bash
---

# github-dashboard

A sprinkle panel that renders GitHub work as a card wall, plus the fetcher that
produces the data it reads. Two programs, one file each, deliberately separate:

- **`scripts/fetch-snapshot.mjs`** talks to GitHub (and optionally a bb server),
  derives a stage per record, writes `snapshot.json` and `version.json`.
- **`github-dashboard.shtml`**, in `assets/sprinkle/`, is the panel. It reads
  those two files through the sprinkle VFS bridge, derives a category from stage
  plus timestamps, and writes only the operator's own marks. It makes no API
  calls.

How stage and category are modelled, and why, is in `references/domain-model.md`.

## State of this skill

Implemented and exercised: the five groups and their derivation, live updates by
polling a hash file, markdown rendering of GitHub prose behind a sanitiser, a
per-card quick view in two modes, three per-card actions that write local marks,
a three-way Go control, and clickable follow-up actions that emit a lick to the
cone. What is not settled is the provisional caveat in the description and the
list under "Known problems"; nothing here has been reviewed by anyone but its
author.

## Install

```sh
# 1. put the built panel where sprinkles live, and its data alongside
mkdir -p /shared/sprinkles/github-dashboard/data
( cd assets/sprinkle &&
  cp github-dashboard.shtml /shared/sprinkles/github-dashboard/ &&
  cp data-example/*.json    /shared/sprinkles/github-dashboard/data/ )

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

**Check:** the panel opens showing the example data — a hand-written fixture with
four invented records that exists so the panel renders something on first open.

Replace the fixture by running the fetcher:

```sh
node scripts/fetch-snapshot.mjs --check-config  # resolve and print the config, fetch nothing
node scripts/fetch-snapshot.mjs                 # writes snapshot.json + version.json
```

Run `--check-config` first: it prints the resolved repository list, so you can
confirm what will be followed before anything is fetched. The fetcher obtains
its own GitHub credential (`oauth-token github`, or `GH_TOK` for a foreground
run), keeps it in memory and prints it nowhere; with no credential it refuses to
run anonymously.
It also refuses to start when `/shared/github-monitor/config.json` is missing
rather than following repositories nobody chose. **Check:** within five seconds
of a successful run the panel replaces the fixture with your records.

## Keeping the snapshot fresh (the poller)

The fetcher is a one-shot program. `scripts/poll.jsh` is the durable unit that
runs it on a schedule, supervised by `jshd`. The unit runs the fetcher and the
mirror from the deployed sprinkle directory, so copy all five there first (the fetcher loads `workdays-shared.cjs` and `thread-stage-shared.cjs` from beside itself):

```sh
cp scripts/poll.jsh scripts/fetch-snapshot.mjs scripts/workdays-shared.cjs scripts/thread-stage-shared.cjs scripts/mirror-comments.mjs \
   /shared/sprinkles/github-dashboard/

jshd start -n github-dashboard-poll --enable --restart on-failure \
  /shared/sprinkles/github-dashboard/poll.jsh

jshd ls                                  # note: ls, not list
jshd status github-dashboard-poll
jshd logs   github-dashboard-poll -n 40  # one line per cycle
```

**Check:** `jshd logs` shows one line per cycle, and `data/version.json` gets a
new `generatedAt` each time a cycle writes a snapshot.

**Turning it off** — whoever installs this needs both:

```sh
jshd stop github-dashboard-poll   # stop now; the unit record and log remain,
                                  # and --enable means a reload starts it again
jshd disable github-dashboard-poll # leave it running but do not restore on reload
jshd rm   github-dashboard-poll   # stop AND delete the unit record and its log
```

`stop` alone is not permanent while the unit is enabled: on the next reload the
supervisor starts it again. Use `rm` (or `disable`) to mean it.

**Fast thread state (optional).** A second unit refreshes linked bb threads
every minute, so a card follows its agent without waiting for the next cycle:

```sh
cp scripts/thread-poll.jsh /shared/sprinkles/github-dashboard/
jshd start -n github-dashboard-threads --enable --restart on-failure --cwd /tmp \
  /shared/sprinkles/github-dashboard/thread-poll.jsh \
  --out /shared/sprinkles/github-dashboard/data/threads.json
```

What it writes and how the panel uses it: [references/poller.md](references/poller.md#fast-thread-state).

The default interval is 30 minutes. Model spend tracks repository activity, not
poll frequency, because the status cache is keyed on each record's
`lastActivityAt`; what polling more often multiplies is the fixed per-run cost,
GitHub requests and non-agent wall time. Override it only for a short proving
run (the default stays 30 minutes):

```sh
jshd start -n github-dashboard-poll --enable --restart on-failure \
  --env GHD_POLL_INTERVAL_MS=60000 /shared/sprinkles/github-dashboard/poll.jsh
```

A failing fetch cannot spin the unit: it is logged and counted, and after three
consecutive failures the interval backs off to two hours until one succeeds. A
cycle refuses to start while the previous one is still running. The
measurements behind the interval, the full failure behaviour and the per-cycle
agent-spend ledger (`data/agent-ledger.jsonl`) are in `references/poller.md`.

## Mirroring your marks back onto the card (the comment mirror)

`scripts/mirror-comments.mjs` publishes **your own marks** onto the GitHub item
they belong to, as a single comment it keeps converged:

```
node scripts/mirror-comments.mjs                 # dry run: prints the plan and the exact bodies
node scripts/mirror-comments.mjs --live          # apply
node scripts/mirror-comments.mjs --live --sweep  # also remove mirrors whose marks are gone
```

Read the dry-run plan before the first `--live`: a GitHub comment cannot be
un-published. A mirrored comment looks like this, and this is the whole of it:

```markdown
<!-- ghd-mirror:v1 -->
**Filed on my dashboard**

- Snoozed until 2026-10-03
- Handed to an agent from my dashboard on 2026-09-22
- 1 follow-up dispatched from my dashboard, most recently 2026-09-22 (1 nudge)

<sub>Posted and kept up to date automatically by my own GitHub dashboard. ...</sub>
```

The rules it keeps, each argued in `references/comment-mirror.md`:

- **It publishes the fact, never the prose.** Only `snoozedUntil`, `doneAt`,
  `scoopRequestedAt` and `actionsDispatched` are publishable, each as a fixed
  sentence plus a date. Your free-text `snoozeReason` notes never leave the
  machine. A runtime prose gate aborts with exit 3, writing nothing, if any
  16-character window of a withheld value appears in a composed body.
- **An expired snooze is not published.** Once `snoozedUntil` passes (the exact
  instant, the panel's own test), that fact is dropped; if nothing true is left,
  the comment is deleted. The other three marks are historical and never expire.
- **`lastCommentAt` ignores the mirror's own comment**, and Bot-authored
  comments, so a published snooze does not look cancelled in the panel.
- **It is a reconciler, not a button**: it compares your marks with the card and
  issues only the difference (create, `PATCH`, delete, or nothing), so a re-run,
  a crash mid-write and a replayed lick all converge. The mirror is found by its
  marker plus the author login; there is no new local state, and every write is
  verified by re-reading the card.
- **`--sweep` is off by default** because it was measured at more than ten times
  the cost of a marks-only run, to catch a rare stale comment.
- Only marks are mirrored — never stage, CI or review state. Writes are confined
  to the repos in your config.

### Turning it on in the poller

The poller runs the reconciler after each successful fetch, but **it is dormant
unless asked**:

```
jshd start -n github-dashboard-poll --enable --restart on-failure \
  --env GHD_MIRROR=dry ...          # reconcile and log the plan, write nothing
  --env GHD_MIRROR=live ...         # write
  --env GHD_MIRROR_SWEEP_EVERY=48   # sweep every N successful cycles (default 48 = daily)
```

Start with `dry` and read the logged plan. Enabling `live` means an unattended
unit writes to public cards, which should be a deliberate act by whoever starts
the unit. A mirror failure never fails the cycle.

## Build (needs the source tree)

The panel is a **built artifact**, committed built: installing never needs this
step. Rebuild after changing the renderer, from a checkout of the skill's
repository: `src/` and `tests/` are not in Tessl's skill-review bundle, and
without `src/` the build stops with `build: src/markdown.js missing`. The
renderer is bundled from `src/markdown.js` plus two vendored libraries:

```sh
./scripts/build.sh
```

That is the whole command: no network, no package install (the dependencies are
vendored under `src/vendor/`, with versions and hashes in `src/vendor/VENDOR.md`).
The script detects whether it is running in this repository or next to a deployed
panel, and is idempotent — run it twice and the artifact is byte-identical. It
splices the bundle between the `GHD-BUNDLE` markers in the panel's
`github-dashboard.shtml`: only that marked region is generated, so never
hand-edit it. The rest of the file *is* the source and is edited directly.

## Security: the markdown renderer is the sharp edge

The panel renders issue bodies and comments — text written by anyone who can
comment on a followed repository — and a sprinkle panel is **not** sandboxed
from the filesystem: the bridge can run shell commands and read and write files.
So script execution inside this panel is arbitrary command execution. The rules
any change to `src/markdown.js` must keep:

- marked → DOMPurify with an explicit tag/attribute allowlist → a DOM fragment
  that is appended; untrusted HTML is never assigned to `innerHTML`;
- links only http/https/mailto, forced to `target="_blank" rel="noopener noreferrer"`;
- images only from `github.com` and `*.githubusercontent.com` over https, host
  decided by the URL API; `img` is not in the allowlist — the renderer builds
  the `<img>` itself from an inert placeholder.

After any change to the renderer, rebuild and run the 66-fixture gate from the
repository checkout (`tests/xss-gate.html` is generated, not committed):

```sh
./scripts/build.sh                                   # regenerates the gate page
open tests/xss-gate.html                             # verdict on the page and in the tab title
```

It must read `GATE GREEN — 66 passed, 0 failed, window.__xssFired = never set`.
If it is red, fix the renderer and repeat both steps; never ship a panel built
from a red gate. What the fixtures cover, and the evidence that the gate can go
red, are in `references/security.md`.

## What the panel does

- **Five groups**, derived — never stored: needs attention, stalled, actively
  being worked on, snoozed, done (aged-out records are counted and hidden). One
  pure function, `categorize(item, now)`, derives them from stage, timestamps
  and the operator's own marks.
- **Live updates**: polls `version.json` every five seconds and reads the
  snapshot only when its content hash changes.
- **Quick view** of a card's status, non-modal on hover, modal on click or Enter.
- **Three per-card actions**, all local: snooze (Fibonacci backoff), done, and a
  Go control (the bb thread, "start a scoop", or the item on GitHub).
- Nothing the panel does writes to GitHub. Its only writes are
  `data/user-state.json` (the operator's marks) and licks to the cone.

The behaviour of each piece is in `references/panel.md`; the stage table, the
precedence between overlapping groups, snooze semantics and the open design
questions are in `references/domain-model.md`.

## Suggested follow-ups: which kinds get a control

The fetcher's agents attach `actions` to a record, each with a `kind`. The panel
renders one control per action, and **a kind must be registered to get one**:

| kind | glyph | control | lick |
| --- | --- | --- | --- |
| `nudge` | `send` | Dispatch this instruction | `do-nudge` |
| `clarify` | `message-circle-question` | Raise with the cone | `clarify-question` |
| `approve` | `scan-eye` | Ask for a safety check | `review-before-approval` |
| anything else | `circle-dashed` | **none** — an inert chip | none |

`approve` never approves: the panel performs no GitHub writes, so the button asks
for the work that stops short of the write — read the item now and report whether
approving looks safe — and the lick is named for what it asks. An unregistered
kind renders as an inert chip ("No action for “<kind>” in this panel") with no
button and nothing dispatchable, because the kinds are model-generated and the
next unknown one is a matter of time. Adding a kind is one entry in
`ACTION_KINDS` and no other edit. The reasoning behind both rules is in
`references/action-kinds.md`.

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

Everything the panel, fetcher, poller and mirror need at run time, and all that
Tessl's skill-review bundle contains:

```
SKILL.md                      this file
references/
  domain-model.md             stages, categories, and the derivation
  poller.md                   interval measurements, failure behaviour, spend ledger
  comment-mirror.md           the mirror's publishing rules and their reasons
  action-kinds.md             why approve asks for a check; unknown kinds inert
  panel.md                    the panel's behaviour, piece by piece
  security.md                 the renderer's threat model and the gate's evidence
assets/sprinkle/
  github-dashboard.shtml      the panel (BUILT — see Build)
  data-example/               synthetic snapshot + version, 4 records
scripts/
  build.sh                    the one build command (needs src/, see Build)
  fetch-snapshot.mjs          the fetcher (GitHub + optional bb)
  workdays-shared.cjs         working-day arithmetic the fetcher loads from beside itself
  poll.jsh                    the durable poller unit (jshd)
  mirror-comments.mjs         mirrors the operator's marks onto the card (opt-in)
```

Repository checkout only, for building and testing:

```
src/
  markdown.js                 sanitising markdown renderer (bundled into the panel)
  vendor/                     pinned marked + DOMPurify; versions and hashes in VENDOR.md
tests/
  xss-fixtures.json           66 acceptance fixtures (data)
  gate-runner.js              the gate's assertions
  xss-gate.html               GENERATED by build.sh (git-ignored) — open to run
  *.test.js                   unit tests, one file per behaviour — for example
                              last-comment (lastCommentAt ignores the mirror),
                              mirror-exclusion, mirror-retry, poll-summary (the
                              poller's failure summary), snapshot-age, live-clock,
                              agent-ledger and poll-ledger (the spend ledger)
  qv-fake-dom.js              fake DOM the quick-view test drives
```

## Colours

Every colour is a design-system token or a token pair; there are no literal
colour values and no `prefers-color-scheme` rules. Group tone, card border and
state glyph all come from the same derived state, so a card cannot disagree with
its column.

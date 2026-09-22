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

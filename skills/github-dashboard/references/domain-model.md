# Domain model, and what will make wiring awkward

This is the part of `github-dashboard` worth reviewing. The panel is an unwired
draft; the model below is the actual proposal.

## Stage is stored, category is derived

An item record carries a stage. Nothing stores a category — `categorize(item,
now)` recomputes it on every render from `(stage, substage, lastActivityAt,
snoozedUntil, snoozedAt, lastCommentAt, thread)`. That split is deliberate: a
stored category drifts the moment a timestamp moves, and "stalled" is a
statement about the clock, not about the item.

The function is pure and takes `now` as an argument, so it is testable without
mocking a clock. The draft freezes `NOW` to a constant to keep the sample stable.

## One record, per stage

```js
{
  id, repo, kind: 'issue' | 'pr' | 'thread', title, url,
  stage: 1..11, substage: '5a' | '5b' | '6a' | '6b' | '8a' | '8b' | undefined,
  bounceTo,                  // where a failure substate returns work to
  thread: { id, provider, state } | null,
  openedAt, lastActivityAt, mergedAt, lastCommentAt,
  snoozedAt, snoozedUntil, snoozeCount, snoozeReason,
  blockedOn, labels, reviewers, ci,
  producedPrs, fixedBy, fromThread,
  status, statusSource,      // one human sentence, and its provenance
  synthetic                  // fixture bookkeeping, never rendered
}
```

## Snooze semantics

- A human snoozes an item for a day. If it comes back unchanged, the next
  snooze is the next Fibonacci step: `FIB_BACKOFF_DAYS[snoozeCount]`, clamped at
  21 days.
- **A comment cancels the snooze.** `snoozeState()` treats the snooze as void
  when `lastCommentAt > snoozedAt`, so PR chatter re-surfaces the item
  immediately, regardless of `snoozedUntil`. The fixture has one item
  (`example-org/example-repo#107`) in exactly that state.
- Stage 9 — merged but not released — is treated as snoozed without anyone
  typing a snooze (`RELEASE_WAIT_IS_SNOOZE`): waiting on a release train is
  waiting on something else.

## Open questions for the wiring job

These are the reasons a naive GitHub API mapping will not fit, in rough order
of how much they will hurt.

### 1. Stages 10 and 11 have no home in the four categories

The four categories describe live work. A released PR or a closed issue is
neither active, snoozed, stalled, nor in need of attention. The draft invents a
fifth `done` group. Alternatives: drop terminal items from the panel, keep a
"recently shipped" window, or accept the fifth group. Needs a decision before
wiring, because it determines whether the panel needs any history at all.

### 2. A thread's stage disagrees with its PRs' stages

Stage is per-record, but work is a chain across several records. In the fixture,
one bb thread produced two PRs; both shipped, while the thread itself sits at
stage 2 and is therefore reported as **stalled** — which is arguably wrong, and
is what the panel currently shows. Two candidate fixes:

- roll a parent up to the maximum stage of its children, so a thread whose PRs
  released counts as released; or
- keep one card per artefact and accept that the same work appears twice.

Either way, the parent/child edge is not something the GitHub API gives you:
the thread↔PR link lives in the agent runtime, not on GitHub.

### 3. `lastActivityAt` is not one field

Every stall threshold depends on it, and it has to be synthesised:

- for an issue, `updated_at` is close enough;
- for a PR it is the maximum of pushes, review submissions, comments and **CI
  completions** — and a check-run finishing does **not** touch the PR's
  `updated_at`. A PR whose CI went red an hour ago can look untouched for a day.
- for a thread it is a timestamp from the agent runtime, not GitHub at all.

Get this wrong and the stalled category is quietly meaningless.

### 4. Snooze needs state GitHub cannot store

`snoozedAt`, `snoozedUntil`, `snoozeCount`, `snoozeReason` are ours. The
Fibonacci step is only meaningful if we also persist "nothing changed since the
last round", which means remembering a per-item fingerprint. And "a comment
cancels the snooze" needs an event stream or a polled `updated_at` per item —
the one place where the no-polling rule will have to bend.

### 5. Substate 6b's bounce target is unknowable from the API

"Changes requested" returns work either to stage 4 (mechanical fix) or stage 3
(a design question for the human). Only a human — or a model reading the review
comment — can tell which. The record has an optional `bounceTo` for this and
the fixture fills it in by hand.

### 6. "Released" is a repo-wide event, not an item property

The `released` label in the fixture is a stand-in. Stage 9 → 10 really means
"was this merge commit in a release cut", which needs tag/release data plus
commit membership, and flips for many items at once.

### 7. Stages 1 and 3 are skippable, so absence is ambiguous

A stage-1 issue with no thread and a stage-1 issue whose thread has not
registered yet are indistinguishable in one record. The fixture papers over
this with an explicit `thread: null`.

## UI decisions that came out of review, and what they cost

- **No visible stage numbers.** State is a distinct lucide glyph plus a colour,
  with the name in `title`/`aria-label`. Four failure states share the red tone,
  so they are shape-coded — circle, triangle, octagon, square — because colour
  cannot separate them. Cost: a sighted user who does not know the glyph set has
  to hover.
- **Equal card heights everywhere.** `grid-auto-rows: 1fr` only equalises rows
  within one grid, and each accordion group is its own grid, so the geometry is
  made deterministic instead: title clamped to two lines, status clamped to two,
  a three-line reservation for the body, `nowrap` on the identifier row. Cost: a
  wasted line on cards with a short title, and truncation (with the full text in
  `title`) on long ones.
- **The progress bar is the card's top border.** Negative margins cancel the
  card's padding and border; `width: auto` is required because the framework
  sets `width: 100%` on `.sprinkle-progress-bar`, which otherwise ignores the
  negative margins.
- **Explainers live in `title` only.** No group renders prose, and there is no
  footer note; panel space goes to cards.

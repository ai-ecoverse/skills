# Domain model

The part of `github-dashboard` most worth reviewing. The panel is wired now: the
fetcher derives a stage per record, the panel derives a category from it, and the
open questions that were listed here before wiring have answers — recorded below
with what the answer cost.

## Stage is stored, category is derived

An item record carries a stage. Nothing stores a category — `categorize(item,
now)` recomputes it on every render from `(stage, substage, lastActivityAt,
snoozedUntil, snoozedAt, lastCommentAt, thread)`. That split is deliberate: a
stored category drifts the moment a timestamp moves, and "stalled" is a
statement about the clock, not about the item.

The function is pure and takes `now` as an argument, so it is testable without
mocking a clock. The panel reads a live clock at load: with a frozen `NOW`, idle
times went negative against real data and the stalled group under-reported.

**A consequence worth stating plainly: the group partition is time-dependent.**
Done retention is two *working* days from last activity, so records cross that
edge continuously — in one measured window, 42 of about a hundred records sat
within twelve hours of ageing out, and the aged-out count moved from 3 to 4 to 16
over two hours. A count of the columns is only meaningful with the timestamp at
which it was taken; two counts an hour apart can both be right.

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
  statusLong, statusCached,  // the longer prose, and when it was cached
  bodyExcerpt,               // untrusted markdown from the issue/PR body
  recentComments: [{ at, text }],   // untrusted markdown
  commentsCount, hasClosingPr, stageWhy,
  actions: [{ kind: 'nudge' | 'clarify', label, because, grounds,
              target: { type, ref, url } }],
  secondary                  // artefacts this card also covers
}
```

`bodyExcerpt` and `recentComments[].text` are attacker-controlled: anyone who can
comment on a followed repository writes them. They reach the DOM only through the
sanitising renderer described in SKILL.md.

## Snooze semantics

- A human snoozes an item for a day. If it comes back unchanged, the next
  snooze is the next Fibonacci step: `FIB_BACKOFF_DAYS[snoozeCount]`, clamped at
  21 days.
- **A comment cancels the snooze.** `snoozeState()` treats the snooze as void
  when `lastCommentAt > snoozedAt`, so PR chatter re-surfaces the item
  immediately, regardless of `snoozedUntil`.
- **In the snoozed column the snooze control un-snoozes**, clearing all four
  snooze fields and resetting the backoff; elsewhere it advances the backoff. The
  mode is decided by the column the card is rendered in, not by whether a mark
  exists — a marked card can still be rendered in needs-attention (a blocked
  human outranks a snooze), and a card can sit in the snoozed column with no mark
  at all (merged, waiting on a release).
- Stage 9 — merged but not released — is treated as snoozed without anyone
  typing a snooze (`RELEASE_WAIT_IS_SNOOZE`): waiting on a release train is
  waiting on something else.

## Questions that were open before wiring, and how they were answered

These were the reasons a naive GitHub API mapping would not fit. Each is now
decided; the decision and its cost are recorded so a reviewer can disagree with
the reasoning rather than guess at it.

### 1. Stages 10 and 11 have no home in the four categories — ANSWERED: fifth group, with retention

A released PR or a closed issue is neither active, snoozed, stalled, nor in need
of attention, so there is a fifth `done` group with a two-working-day retention
window; past that, a record ages out of the panel entirely and is counted rather
than reclassified. The cost is that the done column dominates the card count (it
routinely holds four fifths of the records) and that the partition moves with the
clock, as described above.

### 2. A thread's stage disagrees with its PRs' stages — ANSWERED: one card, PR leads

Stage is per-record, but work is a chain. The answer is absorption: the PR leads,
its number is the card identifier and its stage is the card stage, and the issue
or thread it covers is listed on a secondary line rather than getting its own
card. Precedence is PR, then issue, then thread.

The cost is that the absorbed record's labels are NOT shown as the PR's labels —
attributing them to the PR was wrong, so they stay reachable only in the card's
secondary line. The parent/child edge still does not come from GitHub: the
thread↔record link is matched by an explicit `#N` in the thread title, and branch
digits are refused because they truncate (a slug ending `-331` meant #3310) and
can name an unrelated record.

### 3. `lastActivityAt` is not one field — ANSWERED: synthesised, and `updated_at` is not used

It is the maximum of pushes, review submissions, comments and **CI completions**,
because a check-run finishing does not touch a PR's `updated_at`. Measured while
wiring: one PR had `updated_at === created_at` while a labelling event existed two
seconds later, and on another `updated_at` tracked a label change exactly — so it
is not a faithful activity signal and the fetcher ignores it.

Get this wrong and the stalled category is quietly meaningless, which is why the
fetcher records *why* it chose each stage (`stageWhy`) and the panel shows it.

### 4. Snooze needs state GitHub cannot store — ANSWERED: a local marks file

`snoozedAt`, `snoozedUntil`, `snoozeCount`, `snoozeReason`, `doneAt`,
`scoopRequestedAt` and per-action dispatch marks live in `data/user-state.json`,
which only the panel writes and the fetcher never touches. "Nothing changed since
the last round" is answered by comparing `lastCommentAt` with `snoozedAt` rather
than by fingerprinting, so no extra polling is needed: the fetcher already carries
the comment timestamp.

The marks file is the one piece of operator-private state in the system. It stays
out of this repository.

### 5. Substate 6b's bounce target is unknowable from the API — STILL OPEN

"Changes requested" returns work either to a mechanical fix or to a design
question for a human, and only a reader of the review comment can tell which. The
record keeps an optional `bounceTo`; nothing populates it from the API. In
practice the panel leans on the follow-up actions instead, which is weaker: those
are model-written and can be stale.

### 6. "Released" is a repo-wide event, not an item property — PARTLY ANSWERED

Stage 9 → 10 means "was this merge commit in a release cut", which needs
tag/release data plus commit membership and flips for many records at once. The
fetcher approximates it; merged-but-unreleased is treated as snoozed
(`RELEASE_WAIT_IS_SNOOZE`) so a release train reads as waiting on something else
rather than as stalled work. A repository that does not cut releases will see this
approximation differently.

### 7. Stages 1 and 3 are skippable, so absence is ambiguous — ANSWERED: an explicit exception

A stage-1 issue with no thread and one whose thread has not registered yet are
indistinguishable in a single record, so untouched open issues get their own rule:
no closing PR, no thread, no comments, and five *working* days of silence before
they count as stalled. Everything else at stage 1 stays in needs-attention.

## UI decisions that came out of review, and what they cost

- **No visible stage numbers.** State is a distinct lucide glyph plus a colour,
  with the name in `title`/`aria-label`. Four failure states share the red tone,
  so they are shape-coded — circle, triangle, octagon, square — because colour
  cannot separate them. Cost: a sighted user who does not know the glyph set has
  to hover.
- **Equal card heights were tried and REVERTED.** `grid-auto-rows: 1fr` only
  equalises rows within one grid, and each accordion group is its own grid, so the
  first attempt made the geometry deterministic by clamping the title and status to
  two lines each and reserving three lines for the body. That traded away the
  content: long titles truncated and short cards wasted a line. The panel now has
  no clamp and no `min-height` on card text — cards are as tall as their content,
  and a row of unequal cards is accepted as the cheaper cost.
- **The progress bar is the card's top border.** Negative margins cancel the
  card's padding and border; `width: auto` is required because the framework
  sets `width: 100%` on `.sprinkle-progress-bar`, which otherwise ignores the
  negative margins.
- **Explainers live in `title` only.** No group renders prose, and there is no
  footer note; panel space goes to cards.
- **One control, two modes, from one resolver.** Both the quick view (hover vs
  click) and the snooze button (snoozed column vs elsewhere) resolve their mode in
  a single function that returns appearance *and* behaviour together. The rule
  learned the hard way: a control whose behaviour depends on context but whose
  appearance does not is the bug.
- **The quick view's scroll container is the dialog itself**, with
  `overscroll-behavior: contain`, because a nested scroller and chained scrolling
  together made a long quick view look unscrollable while the page moved behind
  it. The modal case also locks the page — the browser does not do it for a modal
  `<dialog>` — and restores both the overflow and the scroll position on close.
- **Dispatch is confirmed by colour and `aria-pressed`, never by new copy.** A
  label that changes to "requested" competes with the card's own status line.

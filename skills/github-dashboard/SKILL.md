---
name: github-dashboard
description: >
  Installs and opens the `github-dashboard` sprinkle — a persistent panel
  showing GitHub work as cards in four derived categories: needs attention,
  actively being worked on, snoozed (with Fibonacci backoff), and stalled. Use
  when the user asks for a GitHub work dashboard, a triage panel for issues and
  PRs, "what needs my attention on GitHub", "what are my agents working on",
  "what is stalled", "what did I snooze", or wants to review the state model
  behind such a panel. Each card renders one pipeline state — open issue, draft
  PR, CI failing, in review, changes requested, merge queue, merged, released —
  as a coloured glyph and a coloured top border. THIS SKILL SHIPS AN UNWIRED DRAFT:
  it renders a hardcoded sample fixture, makes no GitHub API or `gh` calls,
  does not poll, and its three per-card actions (snooze, done, jump-in) and its
  add-project button are inert. Install it to review the domain model, not to
  see your real backlog.
allowed-tools: bash
---

# github-dashboard

A sprinkle panel that renders GitHub work as a card wall. The point of this
skill, in its current state, is **the domain model** — how work is staged, and
how a category is derived from a stage plus timestamps — not the data.

## State of this skill: UNWIRED DRAFT

Read this before installing, and do not describe it to a user as a live
dashboard:

- **No network access of any kind.** No GitHub API, no `gh`, no `fetch`, no
  polling, no `slicc.*` bridge calls. The panel is a single self-contained
  `.shtml` file that renders one hardcoded array.
- **The data is a fixture.** Twenty items: eleven are real public issues and
  PRs from `ai-ecoverse/slicc` and `ai-ecoverse/skills` as they stood on
  2026-09-18, and nine are synthetic records in `example-org/example-repo`,
  fabricated to populate every category and state. Synthetic records carry
  `synthetic: true` and a `// ---- SYNTHETIC` comment. All `thr_example*`
  thread ids are placeholders.
- **The three per-card buttons and the `+` are inert.** They render, they carry
  `aria-label` and a `title` describing exactly what they will do once wired,
  and they have no click handlers. Nothing in the panel can change anything.
- **What does work**: the project filter chips (local filtering), the accordion
  groups, and the category derivation, which runs for real over the fixture.
- Wiring it to live data is a separate job. Until then the sample clock is
  frozen (`NOW` is a constant) so the grouping is stable whenever you open it.

## Install

There is no install script yet — it would be the first piece of wiring, and
this draft deliberately stops short. Copy the asset into the sprinkle directory
and open it:

```bash
mkdir -p /shared/sprinkles/github-dashboard
cp assets/sprinkle/github-dashboard.shtml /shared/sprinkles/github-dashboard/
sprinkle open github-dashboard
```

SLICC discovers sprinkles from `/shared/sprinkles/`, not from a skill's own
directory, which is why the copy is required. To pick up an edit, run
`sprinkle close github-dashboard` then `sprinkle open github-dashboard` — never
`sprinkle reload`, which leaves the iframe viewport at 0x0 (slicc#2942).

The panel is single-column safe but shows up to three cards abreast; pop it
out to full screen from the rail header to see the three-column layout.

## The domain model

### Stages

Work moves through a pipeline. A stage is **stored on the item** — it is what
the item *is*. Stages 1 and 3 can be skipped.

| # | Stage | Substates |
| --- | --- | --- |
| 1 | open issue | |
| 2 | thread started (a bb thread or a scoop) | |
| 3 | thread needs guidance | |
| 4 | thread is working | |
| 5 | draft PR, waiting for CI | `5a` CI failing, `5b` merge conflicts — both bounce back to 4 |
| 6 | full PR, waiting for reviews | `6a` approving reviews, `6b` changes requested — bounces back to 3 or 4 |
| 7 | all-green PR: reviews addressed, CI green | |
| 8 | PR in merge queue | `8a` queue conflicts, `8b` queue checks failed — both bounce back to 4 |
| 9 | PR merged, not yet released | |
| 10 | PR released | |
| 11 | issue closed | |

**Stage numbers are never shown in the UI.** Each state is rendered as a
distinct lucide glyph plus a colour, with the state name in `title` and
`aria-label`; the numeric stage is recoverable only from the progress bar's
tooltip, for debugging a miscategorised item.

### Categories

A category is **derived, never stored** — `categorize(item, now)` is a pure
function over one record, reading `(stage, substage, lastActivityAt,
snoozedUntil, snoozedAt, lastCommentAt, thread)`:

- **a. needs attention** — issues to dispatch and open questions aimed at the
  human: stage 1 with no thread, stage 3, substate 6b, stage 7.
- **b. actively being worked on** — an agent is busy and the human waits on the
  agent: stages 2, 4, 5, 6, 8 with recent activity.
- **c. snoozed** — both sides wait on something else: an external dependency,
  another human, an upstream release. A human snoozes for a day, with
  **Fibonacci backoff if nothing has changed**, and **a comment cancels the
  snooze**. Stage 9 (merged, awaiting release) is treated as snoozed without
  anyone typing a snooze.
- **d. stalled** — it looks like it is working, but nothing has moved for
  longer than the stage allows.

Stages 10 and 11 are terminal and have **no home in the four categories**, so
the panel gives them a fifth `done` group. See
`references/domain-model.md` — that mismatch is one of the open questions.

### Precedence, highest first

Categories overlap, so the order is explicit and deliberate:

1. **Done** (stage 10/11) beats everything: a released or closed item cannot be
   stalled or snoozed.
2. **A blocked human** beats a snooze — substate 6b, stage 3, stage 7. A snooze
   is a promise that nothing needs you yet; these falsify it.
3. **Snooze beats stalled.** An explicitly snoozed item is not stalled; silence
   is exactly what was asked for.
4. Undispatched issue (stage 1, no thread) → needs attention.
5. **Stalled** — a working stage idle past its limit.
6. **Active** — anything else in a working stage.
7. Fallback → needs attention. An unclassifiable item is a bug in the function,
   so it is surfaced rather than hidden.

### Threshold constants

All at the top of the script, named for tuning:

| Constant | Value | Applies to |
| --- | --- | --- |
| `STALL_AFTER_HOURS` | 6 | stages 2, 4, 5 — the stages an agent owns |
| `REVIEW_STALL_AFTER_HOURS` | 24 | stage 6 — reviewers are slower than agents |
| `MERGE_QUEUE_STALL_AFTER_HOURS` | 2 | stage 8 — the queue should move in minutes |
| `STALL_AFTER_HOURS_BY_STAGE` | `{6, 8}` | per-stage overrides of the default |
| `FIB_BACKOFF_DAYS` | `[1,1,2,3,5,8,13,21]` | indexed by `snoozeCount`, clamped |
| `WORKING_STAGES` | `[2,4,5,6,8]` | stages eligible for stalled/active |
| `DONE_STAGES` | `[10,11]` | terminal stages |
| `RELEASE_WAIT_IS_SNOOZE` | `true` | treat stage 9 as snoozed |

### The status line

Each card shows one plain sentence of status. In the fixture every record
carries `statusSource: 'placeholder'` because the sentences are hand-written.
When wired, they are intended to be generated per item from the item's timeline
by a cheap model such as `claude-haiku` — pick whatever small, fast model your
own provider offers — and such records should carry `statusSource: 'agent'` so
the two can be told apart.

## Colours

State colours come from the hue-specific `--uxc-<hue>-subtle-text` tokens
through a `--gh-*` alias layer, chosen to match GitHub's own conventions:
green for open/approved/released, red for CI failure and conflicts and changes
requested, yellow for CI pending and the merge queue, purple for merged and
closed-as-completed, grey for draft, blue for in-progress. Each alias falls
back to an `--s2-*` token. Everything that is not a state colour — surfaces,
text, borders, radii, spacing, type — uses `--s2-*` only. There are no literal
colour values in the file, and no `@media (prefers-color-scheme)`: the host
toggles a `.theme-light` class and the tokens swap.

Measured contrast of the state colours against the card background is 4.60:1 to
9.51:1 across both themes, so the identifier text clears 4.5:1 everywhere.

## Files

- `assets/sprinkle/github-dashboard.shtml` — the whole panel: markup, CSS, the
  state model, `categorize()`, and the fixture, in one self-contained file. It
  deliberately uses no ES module imports: a sprinkle renders in an
  `about:srcdoc` iframe, so relative specifiers resolve against the SPA shell
  and silently return `index.html`.
- `references/domain-model.md` — the state and category model in detail, plus
  the open questions that will make wiring awkward.

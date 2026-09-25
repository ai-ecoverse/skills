# What the panel does

Detail behind the "What the panel does" section of SKILL.md: the groups, live
updates, the quick view, the per-card actions and follow-up actions.


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
- **Adding a repository**: the `+` at the end of the project chips opens an
  `owner/repo` field in place. Enter runs `gh monitor add <owner/repo>`, which
  checks the repository on GitHub, resolves its bb project and adds it to the
  watch list; the repository appears after the next poll. When no bb project
  resolves, append a `proj_` id or `none` to the same field and press Enter
  again. The text is validated against a strict `owner/repo` pattern and quoted
  before anything runs. This needs a github skill that provides `gh monitor`.
- Nothing the panel does writes to GitHub. Its only writes are
  `data/user-state.json` (the operator's marks), licks to the cone, and the watch
  list, through `gh monitor add`.

The stage table, the precedence between overlapping groups, snooze semantics
and the answered and open design questions are in domain-model.md, alongside
this file.

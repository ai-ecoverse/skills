# Follow-up action kinds

Detail behind the "Suggested follow-ups" section of SKILL.md: why `approve`
asks for a safety check instead of approving, and why an unregistered kind
renders inert. The kind table itself is in SKILL.md.

## Why `approve` asks for a safety check

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

## Why an unregistered kind is inert

An **unregistered kind renders inert**: a chip saying "No action for “<kind>” in
this panel", no button, no listener, nothing dispatchable. This is the important
half. Before this, the code asked `kind === 'clarify' ? … : …` in four places, so
every unrecognised kind fell through to NUDGE — wrong glyph, wrong copy, and a
`do-nudge` lick that offered to dispatch a GitHub write as an instruction. The
kinds are model-generated, so the next unknown one is a matter of time; the
fall-through now points at "do nothing and say so".

Adding a kind is one entry in `ACTION_KINDS` and no other edit.

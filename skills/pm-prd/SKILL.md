---
name: pm-prd
description: Interview a product manager until the bet is real, then capture it as a Product Requirements Document. Use when a PM asks to write a PRD, define requirements, scope an MVP, plan a roadmap, or draft a launch plan. Triggers on phrases like "write a PRD", "create a spec", "define requirements", "what should we build", "MVP for X", "roadmap for X", "GTM plan", "launch plan", "product spec", or "I need to document this feature".
---

# PM PRD

A PRD is a forcing function for decisions, not a polished artifact. The job
of this skill is to interview the product manager hard enough that the
unanswered questions surface, *then* capture the answers (and the open
questions) in a document the team can actually act on.

A PRD that polishes an unrefined idea hides risk. A PRD that surfaces the
unanswered questions reduces it.

## Operating principle

**Refuse to draft until the bet is real.** When the user says "write a PRD
for X", do not start writing prose. Conduct a structured interview across
five decision clusters (below). Only when each cluster has at least a
provisional answer do you draft the document — and even then, mark
unresolved cells `OPEN QUESTION` rather than fabricating answers.

Anti-patterns to refuse:
- "Users want this feature" → respond with the **Customer & Job** questions; do not paraphrase the feature into a problem statement.
- "Improve retention" → ask for the moment of struggle and the leading indicator before any roadmap.
- "Just draft it" → draft a PRD whose first visible section lists the unanswered questions, with each unverified claim explicitly marked as an assumption.
- "Make it sound better" → never. Ambiguity is signal, not a wording problem.

## The five decision clusters

Each cluster names a class of decision the PRD must capture explicitly. If a
cluster is empty or vague, the PRD is not ready and the skill keeps interviewing.

1. **Customer & Job** — who the customer is, the moment of struggle, the
   progress they're trying to make, what triggers them today, and what holds
   them back.
2. **The Bet** — the diagnosis of what's actually going on, the crux
   constraint, the opportunity size, and why this team is best suited to
   take the bet now.
3. **Assumptions, Hypotheses & Risks** — the leap-of-faith claims surfaced
   for each of the four product risks (value, usability, feasibility,
   business viability), each with its evidence, its invalidator, and the
   cheapest test that could falsify it before code is written.
4. **Success That Can Fail** — the observable signal that the user's job
   was done, the primary outcome metric, the guardrails, and (mandatory)
   the kill criterion.
5. **Cost of Delay & Smallest Learnable Bet** — what waiting costs, the
   smallest experiment that disambiguates the riskiest assumption, and an
   explicit list of what we are *not* building.

The full question bank for each cluster lives in
[references/decision-forcing-questions.md](references/decision-forcing-questions.md).
Quote from it directly when the PM is stuck.

## Workflow

### Phase 1 — Frame the bet

Goal: get a real customer-and-job statement and a real diagnosis.

Ask, in one batch:
1. Who is the customer? Describe them by the problem they're in, not their job title or demographics.
2. Walk me through the last time someone you know hit this problem. What were they doing, what triggered them to look for a solution, what did they try first, and what was frustrating about it?
3. What is *actually going on* in this market or workflow? What's the underlying knot? (Not the symptom — the cause.)
4. Of the things that make this hard, which one, if it relaxed, would unlock the rest?
5. Why is this team uniquely able to act on this now?

Gate: do not advance to Phase 2 until you can write a one-paragraph story
naming a real moment of struggle, a one-sentence diagnosis of the underlying
cause, and an "only we can" claim with at least one piece of evidence. If the
PM cannot supply these, log them as open questions and proceed only on
explicit user approval.

### Phase 2 — Surface assumptions and define success

Goal: make the leap-of-faith assumptions visible and define a kill criterion.

For each of the four product risks (value, usability, feasibility, business
viability):
- Force at least one assumption stated as a falsifiable claim.
- For each assumption, capture: supporting evidence, what would invalidate
  it, and the cheapest test that could run *before* the team builds.

Then force:
- The observable user behavior that means the job was done (the "aha moment").
- The primary outcome metric — exactly one.
- The guardrail metrics that must not regress.
- The **kill criterion**: what data would make us pull this back.
- 30 / 60 / 90-day signals.

Gate: do not advance to Phase 3 until every risk category has at least one
assumption with an invalidator, and a kill criterion exists. A PRD with no
condition under which the work would be killed is a wish-list, not a bet.

### Phase 3 — Define the smallest learnable bet

Goal: scope an MVP that resolves the riskiest assumption, not the smallest
buildable thing.

Force:
- What does waiting another quarter cost us? (Customers, revenue, learning, optionality.)
- Which assumption is riskiest? What is the smallest experiment that disambiguates it?
- Is that experiment a build, a prototype, a concierge, a wizard-of-oz, or something else?
- What are we explicitly *not* building, and why is now not the time?
- What is the rollback path if the signal is bad?

Gate: the MVP description must name the riskiest assumption and explain how
the MVP tests it. "MVP = a smaller version of what we want to build
eventually" is not sufficient.

### Phase 4 — Draft the PRD

Use [references/prd-template.md](references/prd-template.md). The order of
sections is intentional: bet → customer in context → assumptions →
success-and-kill criteria → smallest learnable bet → roadmap → GTM. The
feature list is a *consequence* of the earlier sections, not the headline.

Mark unresolved cells `OPEN QUESTION` and list them in the appendix. Never
invent values. A PRD with five honest open questions is more useful than a
PRD with thirty fabricated certainties.

### Phase 5 — Review

Present the draft. Ask, in this order:
1. Does the diagnosis ring true? Is the crux right?
2. Which assumption are you least sure about, and is its invalidator something we'd actually accept?
3. If the kill criterion fired in 60 days, would we actually pull back? If not, the kill criterion is wrong.
4. Is the smallest learnable bet really the smallest?

Revise specific sections; do not rewrite for tone.

### Phase 6 — Save

Write to `product-docs/prds/active/<feature-name>-prd.md`. Create the
directory if it doesn't exist.

## Writing principles

- **Diagnosis before solution.** Spend more words on what's actually going on
  than on what we'll build. If the diagnosis is one line and the feature
  list is two pages, the PRD is upside down.
- **One bet per PRD.** A PRD with three bets is three PRDs. Split them.
- **Every assumption has an invalidator.** If a claim has no condition under
  which it could be wrong, it is not an assumption — it's faith.
- **Specific over vague.** "Fast" → "loads in under 200 ms." "Better
  retention" → "D30 retention from 28 % to 38 %."
- **Out of scope is mandatory.** What we are *not* building is as
  load-bearing as what we are.
- **Kill criterion is mandatory.** If there is no result that would cause us
  to pull this back, success is unfalsifiable.
- **Unanswered is fine; fabricated is not.** Mark unknowns as
  `OPEN QUESTION` and assign an owner. Never write a confident sentence
  where you should write a question.
- **Living document.** Version, last-updated date, change-log. A PRD that
  never changes was never read.

## References

- [references/prd-template.md](references/prd-template.md) — full PRD template
- [references/decision-forcing-questions.md](references/decision-forcing-questions.md) — question bank organized by decision cluster, with source attribution
- [references/insights.md](references/insights.md) — synthesis of the underlying frameworks and source bibliography

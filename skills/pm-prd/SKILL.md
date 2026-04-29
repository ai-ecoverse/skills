---
name: pm-prd
description: Interview a product manager until the bet is real, then capture it as a Product Requirements Document. Use when a PM asks to write a PRD, define requirements, scope an MVP, plan a roadmap, or draft a launch plan. Triggers on phrases like "write a PRD", "create a spec", "define requirements", "what should we build", "MVP for X", "roadmap for X", "GTM plan", "launch plan", "product spec", or "I need to document this feature".
allowed-tools: bash
---

# PM PRD

Treat the PRD as a forcing function for decisions. Interview the PM until
the bet is real, then capture answers and open questions.

## Operating principle

**Refuse to draft until the bet is real.** Conduct a gated interview across
the six decision clusters below. Mark unresolved cells `OPEN QUESTION`
rather than fabricating answers.

**Use above everything (meta-gate).** Success must be expressible as
*unprompted use*. A PRD whose definition of done would still be a win when
shipped-but-unused is not a PRD.

Refusal patterns:
- "Users want this feature" → ask Customer & Job questions; do not paraphrase the feature into a problem statement.
- "Improve retention" → demand the moment of struggle and the leading indicator before any roadmap.
- "Just draft it" → draft, but prepend an `Open Questions & Unverified Claims` callout before section 1 and tag unverified claims as assumptions (Phase 4).
- "Make it sound better" → never. Ambiguity is signal, not wording.

## The six decision clusters

If a cluster is empty or vague, the PRD is not ready — keep interviewing.

1. **Customer & Job** — who the customer is, the moment of struggle, the progress they're making, the trigger, and what holds them back.
2. **The Bet** — diagnosis of what's actually going on, the crux constraint, opportunity size, why this team can act now.
3. **Assumptions, Hypotheses & Risks** — for each of the five product risks (value, usability, feasibility, business viability, **adoption / org readiness**): a falsifiable claim, its evidence, its invalidator, and the cheapest test. Adoption is distinct from feasibility and viability — see [references/decision-forcing-questions.md](references/decision-forcing-questions.md).
4. **Success That Can Fail** — aha moment as unprompted use, one primary usage metric, guardrails, and a mandatory kill criterion.
5. **Cost of Delay & Smallest Learnable Bet** — what waiting costs, the smallest experiment that disambiguates the riskiest assumption, and an explicit not-building list.
6. **Pricing & Value Capture** — the willingness-to-pay shape and where it breaks: price-to-value, hard choices, customer → segmentation → self-segmentation, point of diminishing returns. Cost-plus and competition-minus are disqualified.

Full question bank: [references/decision-forcing-questions.md](references/decision-forcing-questions.md). Quote it when the PM is stuck.

## Workflow

### Phase 1 — Frame the bet

Ask in one batch:
1. Who is the customer? Describe by problem, not job title or demographics.
2. Walk me through the last time someone hit this problem. What were they doing, what triggered them, what did they try first, what was frustrating?
3. What is actually going on in this market or workflow? What's the underlying knot, not the symptom?
4. Of the things that make this hard, which one, if relaxed, unlocks the rest?
5. Why is this team uniquely able to act on this now?

**Gate**: a one-paragraph moment-of-struggle story, a one-sentence diagnosis, and an "only we can" claim with at least one piece of evidence. Otherwise log as open questions and only proceed with explicit user approval.

### Phase 2 — Surface assumptions, define success, set price

For each of the **five** product risks (value, usability, feasibility, business viability, **adoption / org readiness**), force one falsifiable claim with evidence, invalidator, and cheapest test.

Then force the aha moment (unprompted use, not a notification click), one primary usage metric, guardrails, the **kill criterion**, 30 / 60 / 90-day signals, and the pricing shape (cluster 6).

**Gate**: 5/5 risks have an assumption with an invalidator; kill criterion exists; price is tied to value (not cost-plus, not competition-minus); success metric measures *use*.

### Phase 3 — Define the smallest learnable bet

Force:
- What does waiting another quarter cost (customers, revenue, learning, optionality)?
- Which assumption is riskiest? What's the smallest experiment that disambiguates *it*?
- What form: build, prototype, concierge, wizard-of-oz, landing page?
- What are we explicitly *not* building, and why now is not the time?
- Rollback path if the signal is bad?

**Gate**: the MVP names the riskiest assumption and explains how it tests it. "Smaller version of the eventual product" is not sufficient.

### Phase 4 — Draft

Use [references/prd-template.md](references/prd-template.md). Section order is intentional: bet → customer → assumptions (5 risks) → success-and-kill → smallest learnable bet → roadmap → requirements (FFOB) → pricing → GTM. Features are a *consequence*, not the headline. Each requirement is rendered as Feature → Function (proof) → Outcome (first-order quantified) → Benefits (plural). Mark unresolved cells `OPEN QUESTION`; never invent values. The full list of open questions also lives in the appendix.

**If the user bypassed the gates** ("just draft it"): keep the template's section order, but prepend an `## Open Questions & Unverified Claims` callout *before* section 1 that lists every gate that wasn't passed and every fabricated value. The reader must see the gaps before the bet.

### Phase 5 — Review

Ask in order:
1. Does the diagnosis ring true? Is the crux right?
2. Which assumption are you least sure about, and is its invalidator one we'd actually accept?
3. If the kill criterion fired in 60 days, would we actually pull back? If not, the kill criterion is wrong.
4. Is the smallest learnable bet really the smallest?
5. **Use above everything check**: if this shipped exactly as written but no customer used it on their own initiative, would we still call it a win? If yes, the success definition is wrong.
6. Pricing check: is the price tied to value or to cost? If cost, redo cluster 6.

Revise specific sections; do not rewrite for tone.

### Phase 6 — Save

Ask the user where to save before writing any files. Suggest, in order:
1. `product-docs/prds/active/<feature-name>-prd.md` if the repo already has a `product-docs/` convention.
2. `docs/prds/<feature-name>-prd.md` if the repo has a `docs/` directory.
3. Otherwise `<feature-name>-prd.md` in the current working directory.

Create the target directory only after the user confirms the location.

## Writing principles

- **Diagnosis before solution.** If the diagnosis is one line and the feature list is two pages, the PRD is upside down.
- **One bet per PRD.** Three bets = three PRDs.
- **Specific over vague.** "Fast" → "loads in under 200 ms." "Better retention" → "D30 from 28 % to 38 %."
- **Unanswered is fine; fabricated is not.** Mark unknowns `OPEN QUESTION` with an owner.

## References

- [references/prd-template.md](references/prd-template.md) — full PRD template
- [references/decision-forcing-questions.md](references/decision-forcing-questions.md) — question bank organized by decision cluster, with source attribution
- [references/insights.md](references/insights.md) — synthesis of the underlying frameworks and source bibliography

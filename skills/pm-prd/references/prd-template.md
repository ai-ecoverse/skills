# [Product / Feature Name] — PRD

**Version**: 1.0
**Status**: DRAFT
**Author**: [Name]
**Last Updated**: [Date]
**Stakeholders**: [Names & roles]

> Section order is intentional: the bet, the customer, and the assumptions
> come *before* the feature list. Mark unresolved cells `OPEN QUESTION`
> rather than fabricating answers.

---

## 1. The Bet

> The diagnosis, the crux, the opportunity, and why now.

**Diagnosis** — one paragraph. What is actually going on in this market or
workflow? What is the underlying knot, not the symptom?

**Crux** — one sentence. Of the things that make this hard, which single
constraint, if relaxed, unlocks the rest?

**Opportunity size** — populate concretely:

| Dimension | Value | Source |
|---|---|---|
| Segment size | [N customers / users] | |
| Frequency of the job | [per day / week / year] | |
| Willingness to pay or switch | [signal] | |
| Cost of the workaround today | [time / money / effort] | |

**Why us, why now** — one paragraph. What is our unfair advantage, and what
window are we acting inside?

**Out of scope for this PRD** — what this PRD explicitly does NOT address.

---

## 2. The Customer in Context

> A real human in a real moment, not a persona slide.

**Moment of struggle** — a one-paragraph story. Who, when, where, while
doing what, with what trigger, with what frustration.

**The job they're hiring this product to do**

- Functional progress: [what they're trying to accomplish]
- Emotional progress: [how they want to feel]
- Social progress: [how they want to be perceived]

**Forces of progress**

| Force | Description |
|---|---|
| Push of the situation | What about today is unacceptable? |
| Pull of the new | What is appealing about a different solution? |
| Anxiety of the new | What worries them about switching? |
| Habit of the present | What is comfortable about the status quo? |

**Workaround today** — what are they doing now? Cobbling together what?

**How they measure success** — in their own words, not ours.

---

## 3. Assumptions, Hypotheses & Risks

> Every claim has an invalidator and a cheapest test. Faith is not an assumption.

For each of the **five** product risks, list at least one assumption.

### Value risk — will customers buy or use this?

| # | Claim | Evidence today | Invalidator | Cheapest test |
|---|---|---|---|---|
| V1 | [falsifiable claim] | [what we know] | [what would prove it wrong] | [experiment runnable before code] |

### Usability risk — can users figure out how to use it?

| # | Claim | Evidence today | Invalidator | Cheapest test |
|---|---|---|---|---|
| U1 | | | | |

### Feasibility risk — can our engineers build this with the time, skills, and tech we have?

| # | Claim | Evidence today | Invalidator | Cheapest test |
|---|---|---|---|---|
| F1 | | | | |

### Business viability risk — does this work for sales, marketing, finance, legal, partners, support?

| # | Claim | Evidence today | Invalidator | Cheapest test |
|---|---|---|---|---|
| B1 | | | | |

### Adoption / Org-readiness risk — who has to change behavior post-launch?

> Distinct from feasibility (eng can build) and viability (we can sell).
> Names the procurement / sales / support / ops / partner / customer-side
> behavior shift required for the bet to pay off. Technology alone does
> not deliver outcomes; the cultural shift is usually the harder part.

| # | Who must change behavior | What must change | Evidence they will | Invalidator | Enablement plan |
|---|---|---|---|---|---|
| A1 | | | | | |

---

## 4. Success That Can Fail

> If there's no result that would cause us to abandon this work, the success
> definition is unfalsifiable. **Use above everything**: success is measured
> in unprompted use, not ship dates and not click-throughs on our own
> notifications.

**Aha moment** — the observable user behavior that signals the job was done, performed *on the customer's own initiative*.

**"Shipped but unused" check** — if this shipped exactly as written but no customer used it without being prompted by us, would we still call it a win? If yes, redo this section. (The answer should be no.)

**Primary outcome metric** — exactly one. Must measure use, not ship.

**Guardrail metrics** — must not regress.

**30 / 60 / 90-day signals**

| Timeframe | Metric | Target | What it tells us |
|---|---|---|---|
| 30 days | | | |
| 60 days | | | |
| 90 days | | | |

**Kill criterion** — *mandatory*. The data that would cause us to pull this back.

**Rollback plan** — how we pull back, and what we tell affected customers.

---

## 5. The Smallest Learnable Bet (MVP)

> The smallest experiment that disambiguates the riskiest assumption — not
> the smallest buildable thing.

**Riskiest assumption** — name it (refer to a row in section 3).

**Why an MVP and not a prototype** — or vice versa. What form (build,
prototype, concierge, wizard-of-oz, landing page, sales pitch) actually tests
the assumption fastest?

**MVP definition** — 2 to 3 sentences describing the minimum viable scope.

**What the MVP tests, exactly** — the falsifiable claim it resolves.

**What we are explicitly NOT building in v1**

- [Excluded item] — [why now is not the time]
- [Excluded item] — [why now is not the time]

**Cost of delay** — what does waiting another quarter cost us in customers,
revenue, learning, or optionality?

---

## 6. Roadmap

> Phases, not dates. Each phase has an entry point, exit criteria, and a
> rollback trigger.

### Phase 1 — Validate

**Scope**: [what's included]
**Target users**: [internal / closed beta / N customers]
**Exit criteria**: [the assumption that must be confirmed before Phase 2]
**Rollback trigger**: [data that would cause us to pull back]

### Phase 2 — Expand

**Scope**: [what's included; what we learned from Phase 1]
**Target users**: [feature flag %, segment]
**Exit criteria**: [what must be true to move to Phase 3]
**Rollback trigger**: [data that would cause us to pull back]

### Phase 3 — Scale

**Scope**: [polish, integrations, GA readiness]
**Target users**: [full GA]
**Exit criteria**: [GA launch criteria]
**Rollback trigger**: [data that would cause us to pull back post-GA]

---

## 7. Requirements (FFOB)

> Listed *after* the bet, the customer, and the assumptions — because
> requirements are a consequence of those, not the headline.
>
> Each requirement is structured as **Feature → Function → Outcome →
> Benefits**. Skipping the Function column collapses to FAB and lets
> "advantage" become a watered-down benefit; skipping the Outcome column
> collapses to FFB and hides the first-order quantifiable result. Both
> columns are load-bearing.

### Must-have (MVP blockers)

| # | Feature | Function (proof of viability) | Outcome (first-order, quantified) | Benefits (higher-order, plural) | Acceptance | Tied to assumption |
|---|---|---|---|---|---|---|
| R1 | [short customer-facing name] | [demo / diagram / screenshot / 1-line technical proof] | [measurable result, e.g. "page loads ≤ 200 ms"] | [stack of higher-order desirables, e.g. better SEO → more organic traffic → more revenue] | [verifier] | [V1 / U1 / F1 / B1 / A1] |

### Should-have (v1.1+)

| # | Feature | Function | Outcome | Rationale for deferral |
|---|---|---|---|---|
| S1 | | | | |

### Won't-have (explicit out of scope)

- [Capability] — [why not now]

---

## 8. Pricing & Value Capture

> Pricing is a decision cluster, not a footnote in business viability.
> Cost-plus and competition-minus are explicitly disqualified. Force the
> hard choices early; pricing without hard choices is a wish-list.

**Price-to-value statement** — one sentence: "[customer] pays [amount / structure] because they get [quantified outcome from section 7] worth [value]."

**Willingness-to-pay shape**

| Segment | What they hire this to do | Willingness to pay (signal) | Where it breaks |
|---|---|---|---|
| | | | |

**Hard choices**

- Which segment are we deliberately *not* serving at this price, and why?
- Which feature(s) we could charge for separately, but won't, and why?
- Where is the point of diminishing returns — and is the price set there?

**Pricing model** — choose and justify

- [ ] Per-seat / per-user
- [ ] Per-usage / metered (define the unit and why it tracks customer value)
- [ ] Tiered (define the *self-segmenting* feature gate, not just feature count)
- [ ] Flat / subscription
- [ ] Outcome / gain-sharing — *only if* this is an established solution and the data is already in the system. Define the upside split and the floor.
- [ ] Other: [specify]

**Disqualified by default**

- ❌ Cost-plus (price = cost × markup)
- ❌ Competition-minus (price = competitor price - δ)
- ❌ "Freemium" without a defined paid-upgrade trigger

**Open pricing questions**

| # | Question | Owner | Due |
|---|---|---|---|

---

## 9. Go-to-Market

### Target segment

> Who are the first 10 customers or users? Describe by problem and
> circumstance, not demographics.

### Channel

How does the segment find out?

- [ ] In-product (in-app, onboarding flow)
- [ ] Sales-led (AE outreach, demo)
- [ ] Content (blog, SEO, social)
- [ ] Partner-led
- [ ] Other: [specify]

### Message

One sentence: what problem this solves, for whom, and what's now possible.

*"[Product / feature] helps [user in circumstance] [solve problem] so they
can [achieve outcome]."*

### Launch motion

- [ ] Internal dogfood → closed beta → GA
- [ ] Big-bang public launch
- [ ] Soft launch (no announcement)
- [ ] Partner / co-marketing launch

**Beta plan**: who's in beta, how they're selected, feedback mechanism.

### Launch success metrics

| Timeframe | Metric | Target |
|---|---|---|
| 30 days | | |
| 60 days | | |
| 90 days | | |

---

## Appendix

### Open questions

| # | Question | Owner | Due | Blocks which decision |
|---|---|---|---|---|
| Q1 | | | | |

### Change log

| Version | Date | Author | Changes |
|---|---|---|---|
| 1.0 | [Date] | [Name] | Initial draft |

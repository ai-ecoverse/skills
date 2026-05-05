# Decision-Forcing Questions

Question banks for each of the six decision clusters. Use these to
interview the PM when the answers in a draft PRD are vague. Quote the
questions in this document directly when the user is stuck; do not quote
the original sources verbatim.

The questions are paraphrased and grouped by decision cluster. Original
sources are listed at the end of each section so the PM can read further.

**Meta-gate — "Use above everything" (Nuescheler)**

Before any cluster passes review, ask:
- Would we still call this a win if it shipped exactly as written but no
  customer used it on their own initiative? If yes, the bet is not real.
- Is the success metric in cluster 4 a *use* metric or a *ship* metric?
- Does the aha moment require us to push, prompt, or notify the user — or
  is it something they do unprompted?

---

## Cluster 1 — Customer & Job

### Who, in context

- Who exactly is the customer? Describe them by the problem and circumstance, not demographics or job title.
- What progress are they trying to make — functionally, emotionally, and socially?
- In what circumstance does the struggle show up? When, where, while doing what?
- Who else is in the room when the struggle happens? What are they saying?

### The trigger

- What triggered them *today* to start looking for a solution?
- What was the moment they said "Today is the day I'm going to do something about this"?
- Was the trigger a one-time event, a slow build-up, or a recurring frustration?

### The forces of progress

- What is unacceptable about the situation today? (Push of the old.)
- What is appealing about a different way? (Pull of the new.)
- What worries them about switching? (Anxiety of the new.)
- What is comfortable about staying put? (Habit of the present.)

### The workaround

- What are they doing today? Cobbling together which products?
- What do they wish would just go away?
- Where are they spending effort that creates no value for them?

### Their measure of progress

- In their own words, how would they know this got better?
- What would they tell a friend they're now able to do?
- What would they stop saying or doing if this worked?

### Test

If the PRD doesn't tell a one-paragraph "moment of struggle" story with a
real person, a real time, and a real frustration, this cluster is empty.

**Sources**: Christensen — *Competing Against Luck*; Ulwick — *Jobs to Be
Done: Theory to Practice*; Moesta — *Demand-Side Sales 101*; Cagan —
*Inspired*; Jiwa — *Meaningful*.

---

## Cluster 2 — The Bet

### The diagnosis

- What is *actually going on* in this market or workflow? What is the underlying knot?
- Why has this not been solved already? What did previous attempts get wrong?
- What is changing right now that makes this addressable when it wasn't before?
- What are the competing solutions actually doing well? (Don't dismiss them — diagnose them.)

### The crux

- Of the things that make this hard, which one, if it relaxed, would unlock the rest?
- What is the keystone constraint that, if broken, makes the rest tractable?
- Are we sure the crux is real, or are we attacking a symptom?

### The opportunity

- Exactly what problem will this solve, and for whom, in what circumstance?
- How big is the segment? How often does the job arise?
- What are people willing to pay or do today to get this job done — even badly?
- How will we measure that the opportunity is real?

### Why us, why now

- Why is *this* team uniquely able to act on this? What is our unfair advantage?
- What window are we acting inside? What changes if we wait a year?
- What can we do that competitors structurally cannot?
- What would the most credible challenge to "we are the right team" sound like?

### Coherent action

- Which actions follow from this diagnosis?
- Which possible actions are explicitly *not* part of our policy, even though they're tempting?
- Are the actions reinforcing, or do they pull in different directions?

### Test

If "the bet" reduces to "users want this feature", this cluster is empty.
A good bet names a diagnosis, a crux, an opportunity, and an unfair advantage.

**Sources**: Rumelt — *Good Strategy / Bad Strategy* and *The Crux*; Cagan —
*Inspired* (opportunity assessment); McGrath — *Product Strategy for High
Technology Companies*; Reeves — *Building Products for the Enterprise*;
Neumeier — *ZAG*.

---

## Cluster 3 — Assumptions, Hypotheses & Risks

Use Cagan's four product risks **plus a fifth axis (adoption / org
readiness)** to force at least one assumption per category.

### Value risk — will customers buy or use this?

- What is our specific, falsifiable claim about why customers will choose this over the alternatives (including "do nothing")?
- What evidence do we have today that this is true?
- What evidence would prove us wrong?
- What is the cheapest experiment that could test it before we build code?
- Are we testing a value hypothesis (does it deliver value when used?) or a growth hypothesis (will adoption spread?) — and is this PRD clear about which?

### Usability risk — can users figure out how to use it?

- What is the specific path the user must walk to get value? Is it discoverable, learnable, recoverable?
- Where are users most likely to get stuck or drop off?
- What evidence do we have that this path is intuitive — and what would prove it isn't?
- What is the cheapest usability test we can run before building?

### Feasibility risk — can our engineers build this with the time, skills, and tech we have?

- What is technically novel about this, and what is well-trodden?
- What unknowns about latency, scale, integrations, data, or compliance could blow up the schedule?
- What spike or prototype could resolve the largest technical unknown in a week?
- What would we ship if the hardest technical bet didn't work?

### Business viability risk — does this work for our business?

- Does this fit our business model, or does it require a new one?
- What does sales, marketing, finance, legal, support, and partner functions need to have in place?
- What is the unit economics story, and where is it most fragile?
- *(Pricing decisions are their own cluster — see Cluster 6. Don't collapse them into a single B-row.)*

### Adoption / Org-readiness risk — who has to change behavior post-launch?

> Distinct from feasibility (engineering can build it) and business
> viability (the company can sell it). Names the behavior shift required
> on the customer side and inside our own org for the bet to pay off.
> Technology alone does not deliver outcomes — the cultural shift is
> usually the harder part.

- Who has to change behavior for this to deliver the outcome — procurement, sales, support, ops, partners, the customer's IT, the customer's end users?
- For each group: what specifically has to change, what's in it for them, and what is the cost of staying with the current behavior?
- What evidence do we have that they actually will change, and what would invalidate that evidence?
- What enablement is required — training, documentation, change management, incentive realignment? Who owns it, and is it staffed?
- What second- and third-order effects of the new behavior could surprise us? (E.g. higher organic traffic that drops conversion rate because the new traffic doesn't come for the niche product.)

### Cross-cutting questions for every assumption

- Stated as a falsifiable claim, what is the assumption?
- What evidence — actual evidence, not vibes — supports it today?
- What specific, observable thing would invalidate it?
- What is the cheapest experiment that could falsify it before we commit engineering resources?
- Who owns the experiment, and by when does it deliver a verdict?

### Test

If every assumption reads as "we're confident", this cluster is empty.
"Confident" is not an assumption — it's a claim that there is no risk, which
is almost never true.

**Sources**: Cagan — *Inspired* (four product risks); Ries — *The Lean
Startup* (leap-of-faith assumptions, value vs growth hypothesis,
build-measure-learn); Christensen — *The Innovator's Dilemma*. Adoption /
org-readiness risk is added as a fifth axis from Trieloff,
*Performance Culture* (CMS Summit 2025) — "technology alone doesn't
deliver outcomes; the cultural shift is the harder part."

---

## Discovery Artifact — designing the experiment

> Building is now cheap; shipping is still expensive. Each Cluster 3
> assumption — except those in the *what vibe coding cannot test* set
> below — should be tested by a vibe-coded artifact before the PRD is
> written. The artifact is a discovery instrument, not the product.

### Choosing the form

- Can the riskiest assumption be tested by a runnable artifact (web app, script, API stub, data pipeline) that could be vibe-coded in under one day?
- If yes: vibe-code it. The artifact replaces wishful claims in the Cluster 3 *Cheapest test* column with actual observed behavior.
- If no (hardware, regulated, compliance, network-effects-only-at-scale, on-prem deployment): fall back, in order, to concierge → wizard-of-oz → landing page → sales pitch.

### Designing the experiment

- For each Cluster 3 assumption, what observable user behavior in the artifact would invalidate the claim? Be specific — "they don't use it" is too vague; "5/5 fail to complete the primary action without prompting" is testable.
- What is the minimum artifact that could surface that observable behavior? Strip everything else.
- Who will see it — three to five named real customers, or the hardest internal critic of the bet? Neither one alone will produce honest signal.
- What is the *what surprised me* log going to capture? If the answer is "we'll know when we see it", you will only see what you already expected.

### Reading the artifact

- For each assumption, did the artifact validate it (Y), refute it (N), partially address it (partial), or sit in the *cannot test* set (not testable)?
- Three things must have surprised you. If nothing surprised, the artifact wasn't probing the right edge — redesign and re-run.
- Distinguish "users smiled" from "users used unprompted." A polite reaction is not validation; unprompted return on day 2 is.

### What vibe coding cannot test

> A working artifact validated by five happy users does NOT validate the
> following. Treat each as ship debt (Cluster 5), not as validated.

- **Scale** — concurrent users, p95 latency under load, queue depth, tail behavior.
- **Security** — attack surface, secrets handling, auth bypass, multi-tenant isolation, supply chain.
- **Long-term retention** — anything beyond the artifact's observation window (typically <2 weeks).
- **Network effects** — cold-start dynamics, marketplace liquidity, two-sided incentive alignment.
- **Compliance / regulatory** — GDPR, HIPAA, SOC2, FedRAMP, accessibility (WCAG), regional law, financial reporting.
- **Edge-case data** — Unicode pathologies, time zones, large file sizes, malformed inputs at scale.
- **Operations & observability** — logging, metrics, alerting, on-call rotation, SLO budgets, change management.
- **Billing & support** — refunds, dunning, fraud, dispute resolution, support escalation paths, knowledge-base coverage.

For an assumption that falls into any of these categories, mark Cluster 3's *Artifact-validated?* column as **not testable** and move the validation work to Cluster 5's ship-debt list with a real owner and a real cost.

### Test

If the PRD doesn't link a runnable artifact (or a recorded concierge run), Cluster 3's *Artifact-validated?* column will be empty across the board, and the bet is being validated on vibes.

**Sources**: Karpathy, Andrej. *Vibe Coding* (X.com, 2025-02-02) — "fully give in to the vibes, embrace exponentials, and forget that the code even exists." Huesler, Cedric. *Build first, then align* (Slack, AEM PM thread, 2026-04-29) — alignment is downstream of evidence, not upstream of it.

---

## Cluster 4 — Success That Can Fail

### Observable behavior

- What user-visible behavior should we see in real usage data when this works?
- What is the "aha moment" — the single observable signal that the job was actually done?
- Which behavior, if absent, tells us users got the feature but not the value?
- **Use above everything**: Is the aha moment something the customer does *on their own initiative*, or something we have to push, prompt, or notify them into?
- If we removed every notification, banner, and email about this feature, would usage still grow? If no, we're measuring obedience, not value.

### Metrics

- What is the primary outcome metric — exactly one? Why this one?
- What guardrail metrics must *not* regress for this work to count as a win?
- Are these metrics measurable today? If not, what instrumentation has to ship before launch?

### Time horizons

- What does success look like at 30 days, 60 days, 90 days?
- What signals at each horizon would distinguish "this is working" from "we got lucky" or "we got unlucky"?
- What is the minimum useful sample size at each horizon? Will we have it?

### The kill criterion

- What data would cause us to pull this back?
- If that data showed up in 60 days, would we *actually* pull back? If not, the kill criterion is wrong — pick one we'd actually honor.
- Who has the authority to pull the kill?
- What is the rollback plan, and what do we tell affected customers?

### Learning even on failure

- If we kill this, what will we know that we didn't know before?
- Is the learning worth the cost of running the experiment, even if we fail?

### Test

A PRD with no condition under which the work would be killed is a wish-list,
not a bet. If success is unfalsifiable, this cluster is empty.

**Sources**: Olson — *The Product-Led Organization* (aha moment, observable
usage); Reeves — *Building Products for the Enterprise* (rollout
sequencing); Ulwick — *Jobs to Be Done: Theory to Practice* (outcomes); Ries
— *The Lean Startup* (innovation accounting). The "use above everything"
meta-gate is Nuescheler's Helix design principles, captured 2024-11-04.

---

## Cluster 5 — Cost of Delay & Smallest Shippable Bet

> The discovery artifact (preceding section) already did the *learning*.
> This cluster answers: given the artifact's evidence, what's the
> smallest *shippable* version, and what new risks does shipping
> introduce that the artifact did not test?

### Cost of delay

- What does waiting another quarter cost us in customers, revenue, learning, or optionality?
- Is the cost of delay linear, accelerating, or step-shaped (a window we miss)?
- What is the cheapest unit of progress we can ship this week?

### Smallest shippable bet

- Of the assumptions the artifact validated, which one(s) make a shippable bet?
- What is the smallest *shippable* version that captures the validated value at ship-quality? Not the artifact in production; not the artifact plus everything else.
- What new risks does shipping introduce that the artifact did not test? List them as **ship debt** — see *what vibe coding cannot test* above.
- For each ship-debt item: who owns paying it down, by when, and at what cost? Or — explicitly — is it being shipped as known risk?

### Sequencing & queues

- Is this the highest-value thing this team can do right now? What did it displace from the queue?
- What is the next bet in the queue if this one fires the kill criterion?
- What batch size of work can ship this week? What's keeping us from shipping smaller?

### Explicit deferrals

- What are we explicitly *not* shipping in v1, and why is now not the time?
- Which capabilities will be tempting to add mid-flight? What's our rule for resisting them?

### Test

If "shippable bet" is "the artifact, in production", this cluster is empty.
The shippable bet must (a) capture the artifact-validated value and (b)
name the ship debt that shipping introduces, with owners.

**Sources**: Reinertsen — *The Principles of Product Development Flow*
(cost of delay, queues, batch size); Ries — *The Lean Startup* (MVP,
build-measure-learn); Pichler — *Agile Product Management with Scrum*.
The smallest-*shippable* (vs. learnable) framing follows from Karpathy +
Huesler — the artifact does the learning, the shippable bet captures
the value, and ship debt is what's left to pay before launch.

---

## Cluster 6 — Pricing & Value Capture

> Pricing is decision-forcing in the same shape as Rumelt's
> diagnosis-crux-action: it requires hard choices and disqualifies
> defaults. Collapsing it into a row in business-viability risk reduces
> pricing to "fits our model y/n". The cluster-level question is: what's
> the willingness-to-pay shape of this bet, and where does it break?

### Price-to-value

- What is the quantified outcome (from Cluster 4 and the Outcome column of section 7) that justifies the price?
- Stated as one sentence: "[customer] pays [amount] because they get [outcome] worth [value]."
- If we couldn't quantify the outcome, we cannot price to value. What's the experiment that would let us quantify it?

### Hard choices

- Which segment are we deliberately *not* serving at this price, and why is that the right trade?
- Which feature(s) we could legitimately charge for separately, but won't — and why?
- Where is the **point of diminishing returns** for the customer? Have we set the price *at* that point, or somewhere arbitrary?

### Segmentation ladder

- Customer pricing → segmentation → self-segmentation: which level are we at? What gets us to the next?
- If tiered, what is the *self-segmenting* feature gate (a feature only the higher-need segment will care about), not just feature count or volume cap?
- Are we accidentally training every customer to land on the lowest tier?

### Disqualified defaults

- Are we cost-plus (price = cost × markup)? If yes, redo from price-to-value.
- Are we competition-minus (price = competitor − δ)? If yes, redo from price-to-value.
- Are we "freemium" without a defined paid-upgrade trigger? If yes, define the trigger or drop the free tier.

### Gain-sharing — only if all five are true

- Is this an established solution (not a platform, not a v1 bet)?
- Is the data we'd measure outcomes against *already in our system*?
- Can we agree with the customer on the baseline before we start?
- Is there a defined upside split (e.g. % of profit lift, % of revenue lift)?
- Is there a price-tier-relief floor so the customer doesn't lose on the upside path?

If any answer is no, gain-sharing is the wrong model right now.

### Test

If "pricing" reduces to "matches what competitors charge" or "covers our
costs", this cluster is empty. The PRD is selling on price, not on value.

**Sources**: Trieloff, *Eleven Pricing Aphorisms* (ProductCamp Berlin,
2014-09-13) and *Gain-Sharing Pricing* (2014-10-29). Specific aphorisms
referenced: price-to-value (#1), no-pricing-without-hard-choices (#10),
customer-pricing → segmentation → self-segmentation (#8), point of
diminishing returns (#9), cost-plus / competition-minus disqualified (#7),
gain-sharing constraints (#11 + 2014-10-29 model).

---

## Quick reference — when the user gets stuck

| If the PM says… | Quote back this question |
|---|---|
| "Users want this." | "Walk me through the last time someone you know hit this problem. What triggered them, what did they try first, and what was frustrating?" |
| "Everyone needs this." | "Who is the first ten customers? Name them by problem and circumstance, not demographics." |
| "It will improve retention." | "What user-visible behavior should we see in real usage data when this works? What's the aha moment?" |
| "We're confident." | "Stated as a falsifiable claim, what is the assumption? What would invalidate it?" |
| "We'll measure success." | "What is the primary outcome metric — exactly one? And what data would cause us to pull this back?" |
| "MVP is just fewer features." | "Which assumption is riskiest? What is the smallest experiment that disambiguates *that* assumption?" |
| "We don't have time to test it." | "What does waiting cost us? And what is the cheapest experiment that could run this week?" |
| "Just draft it." | "I'll draft it — but every unverified claim will be marked as an assumption with an open invalidator. Is that OK?" |
| "Engineering can build it." | "That's feasibility — fine. Who has to *change behavior* post-launch for the bet to pay off? That's adoption / org-readiness, a separate axis." |
| "We'll just match the competitor's price." | "That's competition-minus, which is disqualified. What is the quantified outcome and what is it worth to the customer?" |
| "Pricing is sales' problem." | "Pricing is the willingness-to-pay shape of the bet. Which segment do we deliberately not serve at this price, and why?" |
| "Success = launch." | "Use above everything: would we still call this a win if it shipped exactly as written but no customer used it on their own initiative?" |
| "We'll requirement it as 'support feature X'." | "That's a Feature with no Function and no Outcome. Show me the proof of viability (demo / diagram) and the first-order quantified result." |
| "We need an eng estimate first." | "The build estimate is for shipping. Vibe-code an artifact this afternoon to test the assumption — that's a different cost." |
| "Let's spec it first." | "The spec emerges from the artifact. Build a discovery version, then write the spec around what it surprised you with." |
| "The prototype validated it, ship it." | "The artifact tested value and usability. Did it test scale, security, retention, compliance, billing, or support? Those are ship debt — list them with owners." |
| "We need cross-functional alignment first." | "Alignment is downstream of evidence. Show the artifact, then align." |

---

## Bibliography

### In-house frameworks

- Trieloff, Lars. *FFOB — Feature / Function / Outcome / Benefits* (Apple Notes, 2014-06-17). Distinguishes Function (proof-of-viability — demo, diagram, screenshot) from Outcome (first-order quantifiable result), preventing the FAB→FFB collapse where "advantage" becomes a watered-down benefit.
- Trieloff, Lars. *Eleven Pricing Aphorisms* (ProductCamp Berlin, 2014-09-13) and *Gain-Sharing Pricing Model* (Apple Notes, 2014-10-29). Pricing as a decision cluster: price-to-value, hard choices, segmentation ladder, disqualified defaults, gain-sharing constraints.
- Trieloff, Lars. *Performance Culture* (CMS Summit, 2025). Source for the adoption / org-readiness risk axis: technology alone does not deliver outcomes; the organizational and cultural shift is the harder part.
- Nuescheler, David. *Helix Design Principles* (captured 2024-11-04). Source for the "use above everything" meta-gate: usage trumps everything, including theoretical correctness.
- Huesler, Cedric. *Build first, then align* (Slack, AEM PM thread, 2026-04-29). Source for the "build before align, ship after learn" operating principle: alignment artifacts (decks, sign-offs, SLC checklists) are downstream of the discovery artifact's evidence, not upstream of it.

### Canonical bibliography

- Karpathy, Andrej. *Vibe Coding* (X.com, 2025-02-02). The frame for treating coding agents as a discovery instrument. Building becomes cheap; shipping remains expensive. Source for the Phase 2 vibe-coded artifact and for the *what vibe coding cannot test* set.
- Cagan, Marty. *Inspired: How to Create Products Customers Love.*
- Christensen, Clayton M., Taddy Hall, Karen Dillon, and David S. Duncan. *Competing Against Luck: The Story of Innovation and Customer Choice.*
- Christensen, Clayton M. *The Innovator's Dilemma: When New Technologies Cause Great Firms to Fail.*
- Eyal, Nir. *Hooked: How to Build Habit-Forming Products.*
- Horowitz, Ben. *The Hard Thing About Hard Things.*
- Jiwa, Bernadette. *Meaningful: The Story of Ideas That Fly.*
- Lawley, Brian, and Pamela Schure. *42 Rules of Product Management* (2nd ed.).
- McGrath, Michael E. *Product Strategy for High Technology Companies.*
- Moesta, Bob, with Greg Engle. *Demand-Side Sales 101: Stop Selling and Help Your Customers Make Progress.*
- Neumeier, Marty. *ZAG: The #1 Strategy of High-Performance Brands.*
- Olson, Todd. *The Product-Led Organization: Drive Growth by Putting Product at the Center of Your Customer Experience.*
- Pichler, Roman. *Agile Product Management with Scrum: Creating Products that Customers Love.*
- Pragmatic Marketing. *Strategic Role of Product Management.*
- Reeves, Blair, and Benjamin Gaines. *Building Products for the Enterprise: Product Management in Enterprise Software.*
- Reinertsen, Donald G. *The Principles of Product Development Flow: Second Generation Lean Product Development.*
- Ries, Eric. *The Lean Startup: How Today's Entrepreneurs Use Continuous Innovation to Create Radically Successful Businesses.*
- Rumelt, Richard P. *Good Strategy / Bad Strategy: The Difference and Why It Matters.*
- Rumelt, Richard P. *The Crux: How Leaders Become Strategists.*
- Ulwick, Anthony W. *Jobs to Be Done: Theory to Practice.*

# Insights & Synthesis

This skill is built on the conviction that a PRD is a forcing function for
decisions, not a polished artifact. It is informed by recurring patterns
across the canonical product-management bookshelf and four in-house
frameworks.

The synthesis below explains *why* the skill is structured around six
decision clusters and a "use above everything" meta-gate, and credits the
frameworks each cluster draws from.

## The "use above everything" meta-gate

Before any cluster passes review, the skill applies a meta-gate drawn from
**Nuescheler's Helix design principles** (captured 2024-11-04): "Use above
everything." A PRD whose success condition reduces to "shipped" is not a
PRD. Every cluster must express success as observed *usage on the
customer's own initiative*. If a draft would still be considered a win when
shipped-but-unused, the bet is not real yet.

This converts ship metrics, click-through rates on our own notifications,
and adoption forced by rollout policy into red flags. The aha moment must
be something the customer does without prompting from us.

## The build-before-align, ship-after-learn principle

A second principle, drawn from **Cedric Huesler's "build first, then
align"** (Slack, AEM PM thread, 2026-04-29) and **Andrej Karpathy's
*Vibe Coding*** (X.com, 2025-02-02), inverts the canonical bookshelf's
implicit assumption that *building is expensive*.

For most of product management's history, building was expensive — weeks
of engineering time, queues, and hand-offs — and the canonical texts
(Cagan, Ulwick, Ries, Christensen, Reinertsen) accordingly optimized the
discovery process around *not building*. Concierge, wizard-of-oz,
landing pages, and prototypes were a hierarchy of not-building, ordered
by cost.

Vibe coding inverts that economics. Building is now cheap — a working
artifact is one afternoon away — while *shipping* (auth, billing, scale,
security, support, compliance, ops) remains expensive. The skill
therefore inserts **Phase 2: Build the discovery artifact** before risk
articulation. The artifact is a discovery instrument, not the product.
The act of building it surfaces assumptions the PM could not articulate
alone, and gives Cluster 3 a real validation column instead of a
wish-list of "cheapest tests".

This produces three downstream consequences:

1. **Cluster 5 is renamed** from *Smallest Learnable Bet* to
   *Smallest Shippable Bet*. The discovery artifact already did the
   learning; Cluster 5's job is to identify what shipping introduces
   that the artifact did not test (ship debt) and what the smallest
   shippable version of the validated value is.
2. **Cluster 3's risk weights shift.** Cagan's feasibility risk ("can
   engineering build it?") shrinks dramatically — the answer is
   usually yes, by Tuesday. What replaces it is a *shipping* risk:
   scale, security, retention >30 days, network effects, compliance,
   ops. These remain off-limits to the artifact and become first-class
   items in Cluster 5's ship-debt list.
3. **Cross-functional alignment becomes downstream of evidence.**
   Alignment artifacts (decks, sign-offs, SLC checklists) sit *after*
   the artifact's evidence, not *before* it. Treating alignment as
   upstream of evidence is the failure mode Huesler's principle
   diagnoses: elaborate stakeholder rituals conducted on a bet that no
   one has touched in any reality-checking way.

The skill enforces this by refusing to draft the PRD until either (a) a
runnable artifact exists with a *what surprised me* log of at least
three items, or (b) the bet is explicitly in the not-vibe-codable set
(hardware, regulated, network-effects-only-at-scale, on-prem) and a
fallback discovery instrument (concierge, wizard-of-oz, landing page,
sales pitch) has run.

## The six decision clusters and where they come from

### Cluster 1 — Customer & Job

The most consistent failure mode in product work is naming a "user"
abstractly and a "feature" concretely. The fix is to invert the order:
name the *moment of struggle* concretely, and let the feature follow.

- Christensen (*Competing Against Luck*) — customers don't buy products;
  they hire them to make progress in specific circumstances.
- Ulwick (*Jobs to Be Done: Theory to Practice*) — the customer's job has
  functional, emotional, and social dimensions, and is measured by
  *desired outcomes* the customer can articulate.
- Moesta (*Demand-Side Sales 101*) — purchases are caused by four forces
  (push of the situation, pull of the new, anxiety of the new, habit of
  the present) and a specific trigger event.
- Cagan (*Inspired*) — discovery is the work of distinguishing the right
  problem from the right solution; "users want this" is not a problem
  statement.
- Jiwa (*Meaningful*) — the customer's *worldview* matters more than the
  product feature set.

### Cluster 2 — The Bet

A PRD is, fundamentally, a wager about a market. The wager has to be made
explicit or the team is gambling without knowing it.

- Rumelt (*Good Strategy / Bad Strategy* and *The Crux*) — the kernel of
  strategy is **diagnosis, guiding policy, coherent action**, with the
  *crux* being the keystone constraint that, if relaxed, makes the rest
  tractable. Most "strategy" documents skip the diagnosis.
- Cagan (*Inspired*) — opportunity assessment forces the questions:
  exactly what problem, for whom, how big, how to measure, what
  alternatives, why us, how to market, what's critical, recommendation.
- McGrath (*Product Strategy for High Technology Companies*) — the
  market window and platform position determine which bets are even
  available.
- Reeves (*Building Products for the Enterprise*) — in B2B, the bet
  also includes who buys, who deploys, who operates, and who renews.
- Neumeier (*ZAG*) — the onliness statement: who, where, why, when —
  and why no one else.

### Cluster 3 — Assumptions, Hypotheses & Risks

The core cognitive move of modern product work is making leaps of faith
*visible* and *falsifiable* before committing engineering resources.

- Cagan (*Inspired*) — every product faces four risks: **value risk**
  (will customers buy or use this?), **usability risk** (can users figure
  it out?), **feasibility risk** (can engineering build it?), and
  **business viability risk** (does it work for sales, marketing,
  finance, legal, support, partners?).
- **Trieloff, *Performance Culture* (CMS Summit 2025)** — adds a fifth
  axis: **adoption / org-readiness risk**. Technology alone does not
  deliver outcomes. The behavior shift required of procurement, sales,
  support, ops, partners, and the customer's own organization is a
  distinct risk from feasibility (engineering can build it) and from
  business viability (the company can sell it). The "fast-fashion site
  case" — where moving from middling to high performance dropped
  conversion rate because the new organic traffic didn't come for the
  niche product — is a textbook example of adoption-risk surprise.
- Ries (*The Lean Startup*) — **leap-of-faith assumptions** are
  identified explicitly and tested with the cheapest experiment that
  disambiguates them; **value hypothesis** vs **growth hypothesis** must
  be distinguished.
- Christensen (*The Innovator's Dilemma*) — incumbent assumptions about
  who the customer is and what they value are exactly the assumptions
  most likely to be wrong.

### Cluster 4 — Success That Can Fail

A success criterion that cannot fail is not a criterion. The kill
criterion is the load-bearing element.

- Olson (*The Product-Led Organization*) — the **aha moment** is the
  observable user behavior that signals the job was actually done.
  Without it, "engagement" is theatre.
- Ries (*The Lean Startup*) — innovation accounting and the **pivot or
  persevere** decision both require pre-committed metrics and pre-defined
  thresholds.
- Reeves (*Building Products for the Enterprise*) — rollout phases,
  exit criteria, and rollback triggers turn one big bet into a sequence
  of smaller, observable bets.
- Ulwick (*Jobs to Be Done*) — the customer's outcome statements are
  the right unit of success, not internal feature deltas.

### Cluster 5 — Cost of Delay & Smallest Shippable Bet

The discovery artifact (Phase 2) already did the *learning*. This
cluster answers: given the artifact's evidence, what is the smallest
*shippable* version, and what risks does shipping introduce that the
artifact could not test?

- Reinertsen (*The Principles of Product Development Flow*) — **cost of
  delay** quantifies what waiting costs; **queues** and **batch size**
  govern how fast a team learns; small batches are economically
  superior under uncertainty.
- Ries (*The Lean Startup*) — the canonical MVP framing assumed
  building was expensive; with vibe coding, the MVP becomes the
  smallest *shippable* unit, while Ries's original learning purpose
  moves upstream into the discovery artifact.
- Pichler (*Agile Product Management with Scrum*) — release plans and
  sprint goals are the operational unit of "smaller, sooner".

The cluster's load-bearing decisions: what was validated by the
artifact, what's on the ship-debt list (scale, security, retention >30
days, network effects, compliance, billing, support, ops, edge-case
data), who owns paying it down, and what's explicitly not shipping in
v1.

### Cluster 6 — Pricing & Value Capture

Pricing is decision-forcing in the same shape as Rumelt's
diagnosis-crux-action: it requires hard choices and disqualifies defaults.
Collapsing it into one row in business-viability risk reduces pricing to
"fits our model y/n". The cluster-level question is the willingness-to-pay
shape of the bet and where it breaks.

- **Trieloff, *Eleven Pricing Aphorisms* (ProductCamp Berlin,
  2014-09-13)** — price-to-value (#1); freemium is neither a word nor a
  strategy (#2); the price list is the bad cop to the AE's good cop (#3);
  start small to get a foot in the door (#4); be the filet mignon, not
  the steak knife (#5); good pricing is data-driven (#6, #11);
  cost-plus and competition-minus are a rock and a hard place (#7);
  customer-pricing → segmentation → self-segmentation (#8); find the
  point of diminishing returns and price to it (#9); no pricing without
  hard choices (#10).
- **Trieloff, *Gain-Sharing Pricing Model* (Apple Notes, 2014-10-29)** —
  concrete model: 10 % of profit lift, 1 % of revenue lift, price-tier
  relief on the upside, *only* for established solutions (not platforms),
  *only* on data already in the system. Five operative rules, all
  disqualifying.

The cluster's load-bearing decisions: which segment we deliberately don't
serve at this price, which adjacent feature we could legitimately charge
for separately but won't, where the point of diminishing returns is, and
which segmentation level (customer / segmentation / self-segmentation)
we're operating at.

### Requirements: FFOB

Once the six clusters pass review, requirements render as **Feature →
Function → Outcome → Benefits**, not as a flat capability list.

- **Trieloff, *FFOB Framework* (Apple Notes, 2014-06-17)** —
  - **Feature** is the short customer-facing name.
  - **Function** is the proof of viability — demo, diagram, screenshot,
    or one-line technical proof. *Skipping the Function column collapses
    to FAB and lets "advantage" become a watered-down benefit.*
  - **Outcome** is the first-order quantified result that solves the
    customer's problem (what FAB calls "advantage", but with a clearer
    name aligned to job-stories and product discovery).
  - **Benefits** are higher-order, plural, stacking up through Maslow-
    style chains toward wealth, power, or status.

Function and Outcome are two distinct bridge pillars between Feature and
Benefits — the "how" and the "and then". Both are load-bearing in
high-technology products. Skipping either column produces a FAB-shaped
requirements list that hides risk.

## How the workflow operationalises this

The skill is structured as a gated interview:

- **Phase 1** gates on a real Customer & Job and a real Bet (Clusters 1 and 2).
- **Phase 2** gates on a runnable discovery artifact with a *what surprised me* log of at least three items — the build-before-align principle in operating form.
- **Phase 3** gates on assumptions per risk (5/5), each with the artifact-validated column filled, a kill criterion measured in *use*, and the pricing shape (Clusters 3, 4, and 6).
- **Phase 4** gates on the smallest *shippable* bet, naming the artifact-validated value and the ship debt that shipping introduces (Cluster 5).
- **Phases 5–7** draft, review (with explicit "use above everything", pricing-not-cost-plus, and ship-debt checks), and save.

The "use above everything" meta-gate runs across every phase: success
that isn't measured in unprompted use is treated as success-theatre.
The "build before align, ship after learn" principle runs alongside it:
a PRD whose Cluster 3 was filled without an artifact's evidence is
being validated on vibes.

The gates are the point. A PRD that is "polished" past empty clusters
or an empty Phase 2 is worse than a PRD that names them as open. The
whole skill is a refusal to help the user feel finished before the
team is actually informed.

## Anti-patterns the skill is specifically designed to refuse

- "Just draft it" — the skill drafts, but every unverified claim is marked
  as an assumption with an open invalidator. The user gets a draft *and*
  the open questions, not a confidence-laundering exercise.
- "Make it sound better" — wording is not the problem when the bet is
  vague. The skill never re-words; it surfaces the underlying decision.
- "Users want this feature" — the skill does not paraphrase the feature
  into a problem statement. It asks the Cluster 1 questions until a real
  moment of struggle exists.
- "Improve retention" — the skill asks for the aha moment and the leading
  indicator before any roadmap.
- "We're confident" — the skill rephrases as a falsifiable claim with an
  invalidator. "Confident" is not an assumption.
- "Engineering can build it" — that's feasibility, fine; but the skill
  separately demands an adoption / org-readiness assumption naming who
  has to change behavior post-launch.
- "Match the competitor's price" — competition-minus is disqualified;
  the skill demands a price-to-value statement.
- "Success = launch" — fails the "use above everything" meta-gate. The
  skill demands an unprompted-use metric.
- "Support feature X" as a requirement — that's a Feature with no
  Function and no Outcome. The skill demands proof of viability and the
  first-order quantified result.
- "We need an eng estimate first" — the skill flips it: the eng
  estimate is for *shipping*, not for learning. Vibe-code an artifact
  this afternoon to test the assumption.
- "We need cross-functional alignment first" — alignment is downstream
  of evidence. The skill refuses to draft alignment-shape artifacts
  until a discovery artifact exists.
- "Five users said they liked it, ship it" — five happy users do not
  validate scale, security, compliance, or retention. The skill
  demands ship-debt items with owners.
- "Let's spec it first" — the spec emerges from the artifact. The
  skill refuses to write a forward-spec without the artifact's
  surprises.

## Bibliography

### In-house frameworks

- Trieloff, Lars. *FFOB — Feature / Function / Outcome / Benefits* (Apple Notes, 2014-06-17).
- Trieloff, Lars. *Eleven Pricing Aphorisms* (ProductCamp Berlin, 2014-09-13) and *Gain-Sharing Pricing Model* (Apple Notes, 2014-10-29).
- Trieloff, Lars. *Performance Culture* (CMS Summit, 2025).
- Nuescheler, David. *Helix Design Principles — "Use above everything / Uptime / Simple, fast, reliable, secure / Less is more"* (captured 2024-11-04).
- Huesler, Cedric. *Build first, then align* (Slack, AEM PM thread, 2026-04-29). Operating principle: alignment artifacts (decks, sign-offs, SLC checklists) sit downstream of the discovery artifact's evidence, not upstream of it.

### Canonical bibliography

- Karpathy, Andrej. *Vibe Coding* (X.com, 2025-02-02). The frame for treating coding agents as a discovery instrument: building becomes cheap, shipping remains expensive.
- Cagan, Marty. *Inspired: How to Create Products Customers Love.*
- Christensen, Clayton M., Taddy Hall, Karen Dillon, and David S. Duncan. *Competing Against Luck.*
- Christensen, Clayton M. *The Innovator's Dilemma.*
- Eyal, Nir. *Hooked.*
- Horowitz, Ben. *The Hard Thing About Hard Things.*
- Jiwa, Bernadette. *Meaningful.*
- Lawley, Brian, and Pamela Schure. *42 Rules of Product Management.*
- McGrath, Michael E. *Product Strategy for High Technology Companies.*
- Moesta, Bob. *Demand-Side Sales 101.*
- Neumeier, Marty. *ZAG.*
- Olson, Todd. *The Product-Led Organization.*
- Pichler, Roman. *Agile Product Management with Scrum.*
- Pragmatic Marketing. *Strategic Role of Product Management.*
- Reeves, Blair, and Benjamin Gaines. *Building Products for the Enterprise.*
- Reinertsen, Donald G. *The Principles of Product Development Flow.*
- Ries, Eric. *The Lean Startup.*
- Rumelt, Richard P. *Good Strategy / Bad Strategy.*
- Rumelt, Richard P. *The Crux.*
- Ulwick, Anthony W. *Jobs to Be Done: Theory to Practice.*

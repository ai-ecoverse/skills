# Storytelling Frameworks for Presentation Design

Reference for an LLM agent generating reveal.js slide decks. Three narrative shapes, when to use each, and how each beat maps to slide types. Consult this before drafting deck outlines.

---

## 1. Joseph Campbell — The Hero's Journey

> "The cave you fear to enter holds the treasure you seek."

The 17 stages of the monomyth collapse into 3 acts (Departure / Initiation / Return) and, for talks, into 8 practical beats. The hero is rarely the speaker — usually it's the audience, the customer, the company, or the idea.

### The 8 beats, mapped to slide types

| # | Beat | Act | One-line definition | Slide type | Example phrase |
|---|------|-----|---------------------|------------|----------------|
| 1 | Ordinary World | Departure | The status quo before the story starts; familiar, slightly stale. | Section divider or title slide with a single grounding image | "In 2019, our team was shipping one release a quarter." |
| 2 | Call to Adventure | Departure | The disturbance — a problem, opportunity, or signal that won't go away. | Content slide with a sharp question or one statistic | "Then we got the email no founder wants to read." |
| 3 | Refusal / Threshold | Departure | Why the journey looked impossible; the cost of starting. | Quote slide or a single-bullet content slide | "We didn't have the team. We didn't have the budget. We went anyway." |
| 4 | Mentor | Initiation | The guide, framework, tool, or insight that made it tractable. | Quote slide (attributing the mentor) or a diagram of the framework | "An engineer on the team showed us a paper from 2017." |
| 5 | Trials | Initiation | Three concrete obstacles, in escalating order. | A 3-up content slide or three short consecutive slides | "First the data was wrong. Then the model was wrong. Then we were wrong." |
| 6 | Revelation | Initiation | The moment the worldview flips; the insight earned through trials. | Single full-bleed slide — image, quote, or one sentence | "The bug wasn't in the code. It was in the question." |
| 7 | Transformation | Return | What the hero/audience/product became after the revelation. | Before/after content slide or a paired-image slide | "We stopped shipping features. We started shipping outcomes." |
| 8 | Return with Elixir | Return | The gift the audience takes home — a principle, tool, or invitation. | Closing title slide with a single takeaway and a CTA | "Here's the playbook. Take it." |

### When this shape fits

- Keynotes (20+ minutes) where you have time to set scene, descend, return.
- Founder stories, origin talks, mission framings.
- Education and onboarding — the audience is the hero learning a craft.
- Conference talks built around a single transformation.

### When it overshoots

- 5-minute status updates (no time for descent and return; just give the update).
- Technical deep-dives where the audience wants depth, not arc.
- Sales pitches with a concrete ask — Duarte's contrast model converts better.
- Any talk where the speaker is tempted to cast themselves as the hero rather than the audience.

---

## 2. Nancy Duarte — The Sparkline / Resonate Model

> "The contrast between what is and what could be is what creates the narrative gap."

A great talk oscillates between **what is** (current reality) and **what could be** (the better future the audience could inhabit). Tension lives in the gap between them. The talk climbs through alternating contrast until it lands a **S.T.A.R. moment** (Something They'll Always Remember), then closes on **new bliss** — a vivid picture of the audience's life after they adopt the proposal.

### Slide-sequence pattern

| Position | Phase | Slide type |
|----------|-------|------------|
| 1 | Title — the call | Title slide naming the stakes |
| 2 | What is #1 | Content slide: the painful current state, with one stat or anecdote |
| 3 | What could be #1 | Vision slide: a future-tense headline, image-led |
| 4 | What is #2 | Content slide: a deeper layer of the problem |
| 5 | What could be #2 | Vision slide: a sharper picture of the upside |
| 6 | (repeat as needed) | Alternate; each cycle should escalate |
| 7 | S.T.A.R. moment | Full-bleed: one image, one phrase, one stat, or one demo |
| 8 | Call to action | Content slide with a concrete, single ask |
| 9 | New bliss | Closing slide painting the audience's post-adoption life |

The cadence matters more than the count. Two cycles is enough for a 10-minute talk; four for a 30-minute one. Each "what is" slide should feel slightly heavier than the last; each "what could be" slightly more vivid.

### The four S.T.A.R. variants

| Variant | What it is | Example |
|---------|-----------|---------|
| Memorable dramatization | A live demo, prop, or staged moment | Pulling a working prototype out of a backpack mid-talk |
| Repeatable sound bite | A short phrase engineered to be quoted | "Software is eating the world." |
| Evocative visual | A single image that does the argument's work | A photograph of one user's handwritten note |
| Shocking statistic | A number that reframes the room | "73% of the data we collect is never read by anyone." |

Pick exactly one. Two S.T.A.R. moments cancel each other out.

### When this shape fits

- Pitches, fundraising, sales decks with an ask.
- Persuasion and change-initiative talks (re-orgs, strategy shifts).
- Vision and product-launch talks.
- Any talk where the speaker needs the audience to *do* something on Monday.

---

## 3. Kurt Vonnegut — Shapes of Stories

> "The shape of a story is at least as interesting as the shape of a pot."

Vonnegut graphed stories on a fortune Y-axis (good fortune up, ill fortune down) against a time X-axis. Six shapes recur. For decks, the curve is the spine of the talk; section dividers sit at the inflection points.

### Man in Hole — down then up

```
fortune
  |    ___________
  |   /
  |  /
  | /
  |/_____
  |     \    /
  |      \__/
  |________________ time
```

Suits post-mortems, incident reviews, lessons-learned talks, recovery stories, "we almost died and here's what we learned."

### Boy Meets Girl — up, down, up

```
fortune
  |     ___        ___
  |    /   \      /
  |   /     \    /
  |  /       \  /
  | /         \/
  |________________ time
```

Suits customer testimonials, "romance with the product" stories, partnership announcements, anything with a near-loss and reconciliation.

### Cinderella — rise, fall, rise to greater heights

```
fortune
  |              _____
  |             /
  |     ___    /
  |    /   \  /
  |   /     \/
  |  /
  | /
  |/_______________ time
```

Suits product launches, success stories, turnaround narratives, IPO talks. The most crowd-pleasing shape and therefore the most over-used.

### From Bad to Worse — gradual decline

```
fortune
  |\
  | \___
  |     \__
  |        \___
  |            \__
  |               \
  |________________ time
```

Suits warnings, pre-mortems, climate/security/risk talks, wake-up calls. Use sparingly — audiences resist 30 minutes of decline unless the close pivots to agency.

### Which Way Is Up — ambiguous oscillation

```
fortune
  |   _   _   _
  |  / \_/ \_/ \
  | /           \_
  |/______________ time
```

Suits research talks, philosophical or exploratory pieces, Kafka-esque industry analyses, "it's complicated" updates. Honest but hard to land — pair with a strong closing frame.

### Creation Story — steps up

```
fortune
  |              ___
  |          ___|
  |      ___|
  |  ___|
  |_|______________ time
```

Suits roadmap talks, capability-building stories, "how we got here" company narratives, milestone reviews.

---

## 4. Picking the Right Shape

Ask the user three questions in Phase 1 (content discovery): **Purpose? Audience? Time budget?** Then consult the matrix.

| Purpose | Audience | Time | Recommended shape |
|---------|----------|------|-------------------|
| Persuade / get a concrete ask | External or executive | 5–15 min | Duarte sparkline |
| Inspire / share a journey | Conference, broad | 20–45 min | Campbell hero's journey |
| Retrospective / lessons learned | Internal team | 10–20 min | Vonnegut Man-in-Hole |
| Launch / unveil success | Customers, press | 10–30 min | Vonnegut Cinderella |
| Customer story / testimonial | Sales, marketing | 5–15 min | Vonnegut Boy-Meets-Girl |
| Wake-up call / risk warning | Leadership, policy | 10–25 min | Vonnegut Bad-to-Worse + Duarte close |
| Roadmap / capability review | Internal, investors | 15–30 min | Vonnegut Creation Story |
| Status update | Internal | <10 min | None — just structured headers |
| Technical deep-dive | Specialists | Any | None — use a logical, not narrative, structure |
| Founder / mission talk | Mixed | 20+ min | Campbell |
| Vision / strategy shift | Org-wide | 15–30 min | Duarte |

If purpose is unclear, default to Duarte — contrast structure works for the widest range of business presentations and degrades gracefully.

---

## 5. Anti-Patterns in AI-Generated Decks

Three slop patterns to detect and refuse.

### (a) Hero's Journey Lite

Every section divider is labeled with a Campbell stage ("The Call," "The Trials," "The Return") but the content underneath has no actual transformation — same tone, same register, no descent, no revelation.

**Test from a draft deck:** read only the first sentence of each section. If you cannot identify which beat *changed* the protagonist, the labels are decoration. Strip them.

### (b) Duarte Cosplay

Every other slide alternates "current state" / "future state" headlines, regardless of whether the content actually contrasts. The structure becomes a tic; the audience stops feeling the gap because the gap is mechanical.

**Test from a draft deck:** count consecutive "what is / what could be" pairs. More than three cycles without escalation, or any pair where the two slides could be swapped without changing the argument, indicates cosplay. Collapse adjacent pairs into one substantive contrast.

### (c) Vonnegut Overlay

A fortune curve is drawn or implied over content that doesn't actually rise or fall. The deck claims a Cinderella shape but every slide sits at the same emotional altitude.

**Test from a draft deck:** rate the emotional valence of each section on a -3 to +3 scale. If the variance is under 2 points across the whole deck, there is no curve — remove the shape language and present the content as structured information.

---

## 6. Notes for the Agent

- Pick one framework per deck. Mixing Campbell and Duarte produces mush.
- The S.T.A.R. moment, the Revelation beat, and the inflection point of a Vonnegut curve are the same slide in different vocabularies — there should be exactly one per deck.
- Section dividers in reveal.js are the natural home for act/phase transitions; use vertical slides for the beats inside an act.
- If the user cannot articulate a transformation, a contrast, or a curve in one sentence, the deck does not need a narrative framework — it needs a clean outline.

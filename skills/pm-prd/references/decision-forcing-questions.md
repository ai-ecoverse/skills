# Decision-Forcing Questions

Question banks for each of the five decision clusters. Use these to
interview the PM when the answers in a draft PRD are vague. Quote the
questions in this document directly when the user is stuck; do not quote
the original sources verbatim.

The questions are paraphrased and grouped by decision cluster. Original
sources are listed at the end of each section so the PM can read further.

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

Use Cagan's four product risks to force at least one assumption per category.

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
- What pricing or packaging would make this economically rational? What would invalidate it?
- What is the unit economics story, and where is it most fragile?

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
build-measure-learn); Christensen — *The Innovator's Dilemma*.

---

## Cluster 4 — Success That Can Fail

### Observable behavior

- What user-visible behavior should we see in real usage data when this works?
- What is the "aha moment" — the single observable signal that the job was actually done?
- Which behavior, if absent, tells us users got the feature but not the value?

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
— *The Lean Startup* (innovation accounting).

---

## Cluster 5 — Cost of Delay & Smallest Learnable Bet

### Cost of delay

- What does waiting another quarter cost us in customers, revenue, learning, or optionality?
- Is the cost of delay linear, accelerating, or step-shaped (a window we miss)?
- What is the cheapest unit of progress we can make this week?

### Smallest learnable bet

- Of the assumptions in Cluster 3, which is the riskiest right now?
- What is the smallest experiment that disambiguates *that* assumption — not the smallest buildable thing?
- Is the right form a build, a prototype, a concierge, a wizard-of-oz, a landing page, or a sales pitch?
- What is the *learning goal*, stated as the question the experiment answers?

### Sequencing & queues

- Is this the highest-value thing this team can do right now? What did it displace from the queue?
- What is the next bet in the queue if this one fires the kill criterion?
- What batch size of work can ship this week? What's keeping us from shipping smaller?

### Explicit deferrals

- What are we explicitly *not* building in v1, and why is now not the time?
- Which capabilities will be tempting to add mid-flight? What's our rule for resisting them?

### Test

If "MVP" is "fewer features", this cluster is empty. The MVP must be the
leanest experiment that disambiguates the riskiest assumption — and must
explain *which* assumption.

**Sources**: Reinertsen — *The Principles of Product Development Flow*
(cost of delay, queues, batch size); Ries — *The Lean Startup* (MVP,
build-measure-learn); Pichler — *Agile Product Management with Scrum*.

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

---

## Bibliography

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

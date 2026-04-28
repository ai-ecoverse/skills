---
name: pm-prd
description: Write a structured Product Requirements Document (PRD) for any product or feature. Use when a product manager needs to define objectives, gather requirements, set an MVP goal, plan a roadmap, or draft a go-to-market strategy. Triggers on phrases like "write a PRD", "create a spec", "define requirements", "what should we build", "MVP for X", "roadmap for X", "GTM plan", "launch plan", "product spec", or "I need to document this feature". Also use when the user wants to publish a PRD to GitHub.
---

# PM PRD

A structured workflow for writing PRDs that product managers actually use. Focused on five pillars: Objective, Requirements, MVP Goal, Roadmap, and Go-to-Market.

## Workflow

### Step 1: Gather context (keep it fast)

Ask these questions — all at once, not one at a time:

1. **What are we building?** (product name, feature, or initiative)
2. **Who is it for?** (target user segment — describe by problem, not demographics)
3. **Why now?** (what's the trigger — customer request, competitive pressure, strategic bet?)
4. **What does success look like?** (one metric, specific and measurable)
5. **Any known constraints?** (timeline, team size, technical limits, compliance)

If the user is in a hurry or says "just draft it", make reasonable assumptions, state them clearly at the top of the PRD, and proceed.

### Step 2: Draft the PRD

Use the template in `references/prd-template.md`. Always write all five sections. Mark unknowns as `TBD` rather than skipping them.

### Step 3: Review and iterate

Present the draft. Ask: "Does this capture what you had in mind? Anything to adjust in the objective, MVP scope, roadmap phasing, or GTM?" Revise specific sections based on feedback.

### Step 4: Save

Write to `product-docs/prds/active/<feature-name>-prd.md`. Create the directory if it doesn't exist.

### Step 5: Publish (optional)

If the user wants to publish to GitHub, read `references/github-publish.md` for instructions.

---

## The Five Pillars

### Objective
One sentence. One metric. Answers: "Why are we building this, and how will we know it worked?"
Format: *"Enable [user] to [do X] resulting in [measurable outcome] by [timeframe]."*
Bad: "Improve the product." Good: "Enable enterprise admins to provision users in under 2 minutes, reducing onboarding time by 40% within 90 days of launch."

### Requirements
Split into two tiers:
- **Must-have** (MVP blockers — the product cannot ship without these)
- **Should-have** (high value, but deferrable to v1.1)

For each requirement: one sentence describing the capability, one sentence describing the acceptance criterion.

### MVP Goal
The smallest version of the product that delivers real value to real users and lets you learn.
Three questions to define MVP:
1. What is the core job the user is hiring this product to do?
2. What is the minimum surface area to do that job adequately?
3. What are we explicitly NOT building in v1?

### Roadmap
Use phases, not dates. Three phases is usually right:
- **Phase 1 — MVP**: Core must-haves. Narrow user segment. Internal or beta only.
- **Phase 2 — Expand**: Should-haves + feedback loop. Broader rollout via feature flag.
- **Phase 3 — Scale**: Polish, integrations, GA. Full launch.

For each phase: scope, exit criteria (what has to be true before moving to the next phase), and rollback trigger.

### Go-to-Market
Five elements:
1. **Target segment** — who are the first 10 customers/users?
2. **Channel** — how do they find out? (in-product, sales-led, content, partner)
3. **Message** — one sentence: what problem does this solve and for whom?
4. **Launch motion** — beta → GA, or big-bang? Internal dogfood first?
5. **Success metrics** — what does a successful launch look like at 30/60/90 days?

---

## Writing Principles

- **Problem before solution.** Spend more time on the "why" than the "what". A PRD that jumps straight to features is a spec, not a PRD.
- **One objective.** A PRD with three objectives is three PRDs. Split them.
- **Specific over vague.** "Fast" → "loads in under 200ms". "Better retention" → "D30 retention up from 28% to 38%".
- **Explicit out-of-scope.** List what you are NOT building. This is as important as what you are building.
- **Assumptions visible.** State the top 3 assumptions. For each: what evidence supports it, and what would prove it wrong.
- **Living document.** Include version number and last-updated date. A PRD that never changes was never read.

---

## References

- `references/prd-template.md` — Full PRD template to copy and fill
- `references/github-publish.md` — How to push the PRD skill to a GitHub repo

---
name: presentations
description: Create interactive reveal.js presentations as sprinkles, with bespoke per-brand visual design via stardust
allowed-tools: bash
---

# Presentations

Create reveal.js slide decks as interactive SLICC sprinkles. Output is bespoke — never a templated preset. The skill leans on the **stardust** design system (when present) for distinctive, brand-aware visual direction; falls back to anchor moods otherwise. Every deck ships with the bespoke effects layer: SVG filters, CSS shader patterns, 3D animation. No bland AI-default look, ever.

**Trigger phrases:** "create a presentation", "make slides", "build a deck", "presentation about X", "slide deck", "make a pitch deck"

## Phase 0 — Stardust gate (run before discovery)

Before generating anything, check for stardust artifacts. Stardust is the design system that drives bespoke per-brand visual direction. Without it, presentations risk looking templated.

### 0.1 — Detect existing stardust output

Look for these files at the project root, in priority order:

```bash
test -f DESIGN.json   # impeccable/stardust target tokens (preferred)
test -f DESIGN.md     # impeccable/stardust target design system
test -f stardust/direction.md  # stardust direction trace
```

If `DESIGN.json` exists at the project root: **skip install prompts, go straight to Phase 2 with stardust-driven theme generation** (see `style-guide.md` § Stardust integration). Mention briefly to the user: "Found stardust DESIGN.json — generating theme from your brand tokens."

### 0.2 — Detect installed stardust skill

If no DESIGN.json exists, check whether the stardust *skill* is installed:

```bash
# Common skill install paths the SLICC/Claude Code harness uses
ls .claude/skills/stardust/SKILL.md  ~/.claude/skills/stardust/SKILL.md \
   .agents/skills/stardust/SKILL.md  .cursor/skills/stardust/SKILL.md \
   plugins/stardust/skills/stardust/SKILL.md 2>/dev/null
```

If installed: tell the user "stardust is installed — want me to run `$stardust extract <url>` first to capture brand surface, or proceed with anchor-mood themes?" and act on the answer. Stardust extract → direct → DESIGN.json gives the strongest result; skipping it just means anchor-mood mode.

### 0.3 — Offer to install stardust

If stardust is not installed AND no DESIGN.json exists, ask the user if they'd like to install it. Present these four install methods (pick whichever matches their harness):

| Method | Command | When |
|--------|---------|------|
| **Claude Code plugin (built-in)** | `/plugin marketplace add adobe/skills` then `/plugin install stardust@adobe-skills` | Running inside Claude Code. User runs the slash commands themselves. |
| **upskill (SLICC native)** | `upskill adobe/skills --skill stardust` | SLICC harness with the `upskill` CLI installed. |
| **gh upskill (extension)** | `gh upskill adobe/skills --skill stardust` | User has `trieloff/gh-upskill` gh extension installed. |
| **npx skills (Vercel)** | `npx skills add adobe/skills --skill stardust` | Generic — works anywhere npx runs. |

Phrase the offer concisely. Example:

> "Want me to install stardust first? It's Adobe's design system for brand-aware visual direction — without it, presentations fall back to anchor moods (still distinctive, but not specific to your brand). Install options:
>
> 1. **Claude Code (built-in):** run `/plugin marketplace add adobe/skills` then `/plugin install stardust@adobe-skills`
> 2. **upskill:** `upskill adobe/skills --skill stardust`
> 3. **gh upskill:** `gh upskill adobe/skills --skill stardust`
> 4. **npx skills:** `npx skills add adobe/skills --skill stardust`
>
> Or skip and use anchor-mood mode."

If the user picks 2, 3, or 4, run the command via bash. If they pick 1, print the slash commands for them to run (skills can't invoke slash commands). If they decline, proceed with anchor-mood mode — still applies the bespoke effects layer.

Stardust itself depends on **impeccable** (`pbakaus/impeccable`). If you install stardust, also offer to install impeccable the same way. Without impeccable, stardust will refuse to run and the user will hit a wall on first invocation. After install, stardust normally needs `$stardust extract <url>` and `$stardust direct` before DESIGN.json appears — surface that step explicitly.

## Phase 1 — Content Discovery

Gather requirements through quick questions. Skip questions the user already answered:

1. **Purpose** — pitch, teaching, conference talk, internal update, workshop
2. **Length** — 5–10 slides, 10–20, 20+
3. **Content readiness** — ready content, or just a topic?
4. **Brand context** — only if stardust is NOT in play: "any brand or URL this should evoke?" (a yes opens the door to running stardust)

Keep discovery conversational. If the user gives a clear brief ("10-slide pitch deck about our Q3 results"), skip redundant questions.

## Phase 2 — Style Discovery

Read the style guide:

```bash
read_file /workspace/skills/presentations/style-guide.md
```

### When stardust artifacts exist (DESIGN.json at project root)

Generate theme CSS dynamically from `DESIGN.json` tokens. The `style-guide.md` § *Stardust integration* section is the spec — follow it strictly:

- Map `colors.<role>` → `--r-background-color`, `--r-main-color`, `--r-heading-color`, `--r-accent-color`
- Map `typography.<headingRole>.fontFamily` + `.fontSize` → `--r-heading-font`, heading scale
- Map `typography.<bodyRole>.fontFamily` → `--r-main-font`
- Pull `extensions.divergence.font_deck` for the @import URL
- Honor `extensions.divergence.seed.ground_family` — it dictates whether the deck is dark, cream, saturated, etc.
- Layer the **bespoke effects** (SVG filters, shaders, 3D) keyed to the seed's `craft` tradition (letterpress → ink-bleed displacement; Riso → off-register dual-color; terrazzo → speckled radial; folded-paper → fold shadows).

Show ONE preview slide as an inline shtml card so the user can see the brand-derived theme. No "pick a preset" question — there is no preset.

### When no stardust artifacts (anchor-mood mode)

Pick an **anchor mood** from `style-guide.md` § *Anchor moods*. There are 8, and each is a *starting point*, not a finished design. Mandatory: layer the bespoke effects on top. Show 1–2 sample title slides as inline shtml cards with different moods. Let the user pick or ask for adjustments.

### Hard rules — no matter the mode

- **No bland output.** If a draft slide looks like a reveal.js default with nicer fonts, it has failed. Discard and retry.
- **No banned fonts.** Inter, Roboto, Arial, Helvetica, Open Sans, system-ui as primary heading or body face. Period.
- **No safe palettes.** No "navy + accent blue + white." No corporate gray-on-white. No generic gradient-on-white hero.
- **Effects layer is mandatory.** Every deck applies at least one SVG filter primitive AND one of {3D entrance, animated mask/clip, mix-blend layer, scanline/grain overlay} per the rules in `style-guide.md` § *Bespoke effects layer*.

## Phase 3 — Create the Presentation

### Scoop workflow

One scoop per presentation. The scoop owns the sprinkle and stays alive for edits.

**Creating:**
```
scoop_scoop("quarterly-review")
feed_scoop("quarterly-review", "You own the sprinkle 'quarterly-review'. Your job:
1. Read style guide: read_file /workspace/skills/presentations/style-guide.md
2. Read brand tokens if present: read_file DESIGN.json (skip if missing)
3. Create the .shtml file at /shared/sprinkles/quarterly-review/quarterly-review.shtml using the template from /workspace/skills/presentations/templates/presentation.shtml
4. Run: sprinkle open quarterly-review
5. Push initial content: sprinkle send quarterly-review '<slide-data-json>'
6. Stay alive — wait for lick events. Do NOT exit while the sprinkle is open.")
```

**The scoop must:**
- Write the `.shtml` to `/shared/sprinkles/<name>/<name>.shtml`
- Open it with `sprinkle open <name>`
- Push slide content via `sprinkle send <name> '<json>'`
- Listen for lick events and respond
- **Never exit** while the sprinkle is open

### Reveal.js CDN

The `.shtml` loads reveal.js from CDN:
- JS: `https://cdn.jsdelivr.net/npm/reveal.js@5/dist/reveal.js`
- CSS: `https://cdn.jsdelivr.net/npm/reveal.js@5/dist/reveal.css`

No local dependencies needed.

## Data Contract

Push slide content via `sprinkle send <name> '<json>'`:

```json
{
  "slides": [
    {"type": "title", "title": "...", "subtitle": "...", "background": "#hex", "effects": ["aurora-bg", "displaced-heading"]},
    {"type": "section", "title": "...", "subtitle": "...", "effects": ["3d-flip-in"]},
    {"type": "content", "title": "...", "bullets": ["..."], "notes": "speaker notes", "effects": ["mix-blend-headings"]},
    {"type": "code", "title": "...", "code": "...", "language": "js", "effects": ["scanlines"]},
    {"type": "quote", "quote": "...", "attribution": "...", "background": "#hex", "effects": ["chromatic-aberration"]},
    {"type": "image", "title": "...", "src": "url-or-description", "alt": "...", "effects": ["holographic"]}
  ],
  "theme": "stardust-derived",
  "themeCSS": "@import url(...); :root { ... } /* full theme CSS */",
  "transition": "slide"
}
```

The `effects` array is per-slide — values are CSS class hooks the template applies. See `style-guide.md` § *Effects vocabulary* for the full list.

Send the full slides array on every update — the sprinkle replaces all content on each push.

## Handling Lick Events

The sprinkle emits lick events via `slicc.lick({action, data})`. Handle these:

| Action | Data | Response |
|--------|------|----------|
| `edit-slide` | `{index, content}` | Ask user what to change, regenerate that slide, push full deck |
| `add-slide` | `{afterIndex}` | Generate new slide, insert, push full deck |
| `delete-slide` | `{index}` | Remove slide, push full deck |
| `change-theme` | `{theme}` | Update theme in data — regenerate from DESIGN.json (or pick a different anchor mood), push full deck |
| `export-html` | `{}` | Write standalone HTML to VFS, tell user the path |

**Modifying via cone:**
```
feed_scoop("quarterly-review", "Lick event on YOUR sprinkle: Action: 'edit-slide', data: {index: 2, instruction: 'Make it more concise'}. Update slide 2 and push the full deck.")
```

## Content Density Limits

Each slide type has strict content limits. Overfull slides look terrible at any viewport size — and the bespoke effects amplify that. Sparse beats clever every time.

| Slide Type | Max Content |
|-----------|-------------|
| **Title** | 1 heading + 1 subtitle |
| **Content** | 1 heading + 4–6 bullets OR 2 short paragraphs |
| **Code** | 1 heading + 8–10 lines of code |
| **Quote** | 1 quote (max 3 lines) + attribution |
| **Image** | 1 heading + 1 image |

If content exceeds these limits, split into multiple slides.

## Design Principles (enforce on every slide)

1. **Bespoke over preset.** Stardust drives uniqueness when present. Anchor moods are starting positions, not finished designs.
2. **Distinctive typography.** Banned: Inter, Roboto, Arial, Helvetica, Open Sans, system fonts. Use a stardust-derived font deck or pull from `style-guide.md` § *Font decks*.
3. **Bold color choices.** Dark with vibrant accents, or striking monochrome, or saturated ground. Never default blue-on-white. Cream-family grounds only when the brand category genuinely warrants it (printing/publishing/paper goods).
4. **Effects with purpose.** SVG filters, shaders, 3D animations are mandatory but must serve the slide's narrative. The effect tells you something about the brand or the moment — never decoration for its own sake.
5. **Viewport fitting.** Reveal.js handles scale, but keep content sparse enough that effects breathe.
6. **No AI tells.** Triplet-cadence headlines, "atelier"-style editorial vocabulary on non-editorial brands, stat-callout bars, generic-2026-SaaS hero silhouettes — all banned per stardust's divergence toolkit. See `style-guide.md` § *Anti-tells*.

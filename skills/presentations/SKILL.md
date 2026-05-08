---
name: presentations
description: Create reveal.js slide decks as standalone HTML, with brand-aware theming and bespoke visual effects. Use when the user asks for slides, a slide deck, a slideshow, an HTML presentation, a pitch deck, conference talk, keynote, lightning talk, or "make a deck about X". Handles content discovery, narrative shape, theme generation (via the stardust design system when present), per-slide SVG/CSS/3D effects, export, and live edits.
allowed-tools: bash
---

# Presentations

Output is bespoke, never templated. Slides render as a SLICC *sprinkle* — a standalone `.shtml` panel the harness opens and live-edits via the lick bridge. Brand-aware theming via Adobe's stardust design system when present (`references/stardust-setup.md`); anchor-mood fallback otherwise. The bespoke effects layer (SVG filters, CSS shaders, 3D animations) is mandatory in either mode.

## Phase 0 — Stardust gate

Before discovery, check for stardust artifacts (drives brand-specific theming). Full detection + install detail in `references/stardust-setup.md`.

```bash
test -f DESIGN.json && echo "stardust present"
```

- **`DESIGN.json` exists** → skip install, go to Phase 1. Mention "Found stardust DESIGN.json — generating theme from your brand tokens."
- **stardust skill installed but no DESIGN.json** → ask "run `$stardust extract <url>` first, or skip to anchor-mood mode?"
- **neither** → offer install via upskill / gh upskill / npx skills / Claude Code plugin marketplace (see `references/stardust-setup.md` for exact commands and `pbakaus/impeccable` dependency). If declined, proceed with anchor-mood mode — effects layer is still mandatory.

## Phase 1 — Content & narrative discovery

Conversational. Skip questions the user already answered.

1. **Purpose** — pitch, teaching, conference talk, internal update, workshop, retrospective, post-mortem
2. **Mode** — pick one:
   - **traditional** — paced sequence of slides (default). User advances manually.
   - **zoom** — big-picture-first; an overview slide names regions and each subsequent slide zooms into one. Uses vertical sub-slides under a `zoom-overview` parent.
   - **rapid** — Lessig-style. 100 slides, ≤20 sec each, single word or sentence per slide. Auto-advances. Most slides should be `big-word` type. Ban bullet lists.
3. **Length** — 5–10 slides, 10–20, 20+ (rapid implies 50+; warn if user pairs rapid with <30 slides)
4. **Content readiness** — ready content, or just a topic?
5. **Narrative shape** — pick from `references/storytelling.md`. Default by purpose:
   - Keynote, founder story, mission talk, education → **Hero's Journey** (Campbell)
   - Pitch, persuasion, vision talk, change initiative → **Sparkline / contrast** (Duarte)
   - Retrospective, post-mortem, lessons-learned → **Man-in-Hole** (Vonnegut)
   - Product launch, success story → **Cinderella** (Vonnegut)
   - Wake-up call, pre-mortem, risk talk → **From Bad to Worse** (Vonnegut)
   - Technical deep-dive with no narrative arc → no shape, just structure
6. **Brand context** (only if no stardust) — "any brand or URL this should evoke?" (a yes opens the door to running stardust)

If the user gives a clear brief ("10-slide pitch deck about our Q3 results"), pick the shape and mode from purpose without asking.

## Phase 2 — Style discovery

Read the style guide:

```bash
read_file /workspace/skills/presentations/style-guide.md
```

- **Stardust mode** — generate theme CSS dynamically from `DESIGN.json` per `style-guide.md` § *Stardust integration*. Show ONE preview slide.
- **Anchor-mood mode** — pick from `style-guide.md` § *Anchor moods* (8 starting points). Show 1–2 sample title slides as inline shtml cards. Let the user pick.

Either way, layer the bespoke effects (SVG filters, CSS shaders, 3D animations) per `style-guide.md` § *Bespoke effects layer*.

## Phase 3 — Create the presentation

### Scoop workflow

One scoop per presentation. The scoop owns the sprinkle and stays alive for edits.

```
scoop_scoop("quarterly-review")
feed_scoop("quarterly-review", "You own the sprinkle 'quarterly-review'. Your job:
1. Read style guide: read_file /workspace/skills/presentations/style-guide.md
2. Read brand tokens if present: read_file DESIGN.json (skip if missing)
3. Read narrative reference: read_file /workspace/skills/presentations/references/storytelling.md
4. Compose slides against the chosen narrative shape.
5. Write the .shtml file at /shared/sprinkles/quarterly-review/quarterly-review.shtml using the template from /workspace/skills/presentations/templates/presentation.shtml
6. Verify: test -f /shared/sprinkles/quarterly-review/quarterly-review.shtml — abort if missing.
7. Run: sprinkle open quarterly-review — confirm it reports open before pushing.
8. Push initial content: sprinkle send quarterly-review '<slide-data-json>'
9. Stay alive — wait for lick events. Do NOT exit while the sprinkle is open.")
```

### Validation checkpoints (mandatory)

- **After writing the .shtml**: `test -f <path>` — abort and re-write if missing.
- **After `sprinkle open`**: confirm the call returned without error before sending data. If open fails, surface the error to the user — don't retry blindly.
- **After `sprinkle send`**: if the harness reports a JSON parse error, validate the JSON locally (`echo '<json>' | jq .`) before re-sending.
- **On theme change**: verify `themeCSS` is non-empty before pushing the update — an empty themeCSS triggers the dark/light fallback.

### Reveal.js CDN

The `.shtml` loads reveal.js from CDN:
- JS: `https://cdn.jsdelivr.net/npm/reveal.js@5/dist/reveal.js`
- CSS: `https://cdn.jsdelivr.net/npm/reveal.js@5/dist/reveal.css`

No local dependencies needed.

## Data Contract

Push via `sprinkle send <name> '<json>'`. Top-level shape:

```json
{
  "mode": "traditional|zoom|rapid",
  "theme": "stardust-derived",
  "themeCSS": "@import url(...); :root { ... }",
  "transition": "slide|fade|convex|none",
  "slides": [ /* ... */ ]
}
```

Each slide is `{type, ...}`. The 16 types and their per-type fields are documented in `style-guide.md` § *Bespoke slide types* — `title`, `section`, `big-word`, `metric`, `comparison`, `process`, `timeline`, `definition`, `cards`, `diagram`, `quote`, `image`, `code`, `content`, `zoom-overview`, `zoom-detail`. Common per-slide fields:

- `effects` — array of class hooks. Renderer validates `/^effect-[a-z0-9-]+$/`. See `style-guide.md` § *Effects vocabulary*.
- `builds` — staged element reveals: `[{selector, stagger?, at?}]`. See `style-guide.md` § *Builds*.
- `autoslide` — ms before auto-advance. Rapid mode defaults to 20000ms.
- `background` — `"#hex"`, `"rgb(...)"`, or image URL.
- `notes` — speaker notes.

The full slides array replaces all content on every push.

## Lick events

The sprinkle emits `slicc.lick({action, data})`. Handle:

| Action | Data | Response |
|--------|------|----------|
| `edit-slide` | `{index, content}` | Ask user what to change, regenerate that slide, push full deck |
| `add-slide` | `{afterIndex}` | Generate new slide, insert, push full deck |
| `delete-slide` | `{index}` | Remove slide, push full deck |
| `change-theme` | `{theme}` | Regenerate from DESIGN.json or pick a different anchor mood, push full deck |
| `export-html` | `{}` | Write standalone HTML to VFS, tell user the path |

**Modifying via cone:**
```
feed_scoop("quarterly-review", "Lick event on YOUR sprinkle: Action: 'edit-slide', data: {index: 2, instruction: 'Make it more concise'}. Update slide 2 and push the full deck.")
```

## Content density limits

Sparse beats clever. Per-type maxima in `style-guide.md` § *Content Density Rules*. If content overflows, split into multiple slides — never shrink font size.

## Hard rules (single source of truth)

These are the only rules the skill enforces. The style guide elaborates; this list governs.

1. **Bespoke over preset.** Stardust drives uniqueness when present. Anchor moods are starting positions, not finished designs.
2. **Distinctive typography.** Banned as primary heading or body face: Inter, Roboto, Arial, Helvetica, Open Sans, system-ui. Use a stardust-derived font deck or one from `style-guide.md` § *Font decks*.
3. **Bold color.** Dark with vibrant accents, striking monochrome, or saturated ground. Never default blue-on-white. Cream-family grounds (HSL-L 80–97, R−B ≥ 5, S < 40%) only when the brand category is literally printing/publishing/paper goods.
4. **Effects layer is mandatory.** Every deck applies at least one SVG-filter or shader background AND one of {3D entrance, animated mask/clip, mix-blend layer, scanline/grain overlay} per `style-guide.md` § *Bespoke effects layer*.
5. **No bullet-list decks.** Bullet lists are one slide type among ~14, not the default. A deck where >40% of slides are `content` with bullets is wrong — replace bullet slides with `metric`, `comparison`, `process`, `timeline`, `definition`, `cards`, `diagram`, `big-word`, or `quote`. Full type catalog in `style-guide.md` § *Bespoke slide types*.
6. **Builds, not paragraphs.** Slides with multiple ideas reveal them in stages via the `builds` array (or per-slide `effects: ["effect-slide-stack"]`), not as a wall of text.
7. **Contrast guarantee.** Body text ≥4.5:1, large text ≥3:1 against the rendered background. The template auto-applies text-shadow plates over busy backgrounds (`effect-aurora-bg`, `effect-conic-bg`, `effect-speckled-bg`, `effect-blueprint-bg`); do not undo them. When using `effect-holographic` or `effect-chromatic-aberration` on a busy background, add `text-protect` to the heading container or pick a flat background.
8. **Narrative shape is mandatory** (except for technical-reference decks). Pick one from `references/storytelling.md` in Phase 1; compose slides to match its arc.
9. **No AI tells.** No triplet-cadence headlines beyond one per deck. No "atelier"/"the journal"/"dispatches" editorial vocabulary on non-editorial brands. No stat-callout bars, generic-2026-SaaS hero silhouettes, fabricated stats or named-person quotes. Full anti-tells list in `style-guide.md` § *Anti-tells*.
10. **No effects on the last slide.** Land softly — the audience is scanning for the takeaway, not admiring shaders.

### Mode-specific rules

- **rapid** — bullet lists are banned. Each slide is `big-word`, `metric`, single-image, or one-sentence `content`. No effects with entrance animations >0.3s. Total slides 50+ (warn user otherwise).
- **zoom** — every `zoom-detail` slide must reference a `regionId` that exists in the preceding `zoom-overview`. Use vertical sub-slides under reveal.js.
- **traditional** — no special constraints beyond the global rules.

## References

- `references/stardust-setup.md` — stardust detection, install methods, impeccable dependency
- `references/storytelling.md` — narrative shapes (Campbell, Duarte, Vonnegut), shape selection matrix, anti-patterns
- `style-guide.md` — stardust token mapping, anchor moods, effects vocabulary, anti-tells, density limits
- `templates/presentation.shtml` — the sprinkle template with inline SVG filter library and effect classes

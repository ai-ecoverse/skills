---
name: presentations
description: Create slide presentations as standalone, responsive HTML documents. No frameworks — just bespoke HTML, CSS, and minimal JS for navigation and animations. Use when the user asks for slides, a slide deck, a slideshow, a presentation, a pitch deck, conference talk, keynote, lightning talk, or "make a deck about X".
allowed-tools: bash
---

# Presentations

Build presentations as self-contained HTML documents. Each deck is a single `.shtml` file written from scratch — no reveal.js, no framework, no template. The agent composes raw HTML structure, writes all CSS inline (in a `<style>` block), and adds JavaScript only where interaction or animation demands it (slide navigation, animated counters, code highlighting transitions).

The output is a SLICC sprinkle — a standalone `.shtml` panel the harness opens in a side panel. The agent writes the full file, opens it with `sprinkle open`, and rewrites sections for edits.

## Why no framework

- Frameworks impose structure. A bespoke deck can use any layout CSS provides: grid, subgrid, scroll-snap, container queries, anchor positioning, view transitions.
- No CDN dependency. The only external loads are Google Fonts.
- The agent can write exactly the CSS it needs for the content at hand. A 6-slide pitch deck and a 60-slide conference talk need different approaches — not the same scaffold with different data.
- Modern CSS is expressive enough: `scroll-snap-type` for slide boundaries, `:target` or a small state machine for navigation, `@starting-style` and view transitions for morphs between states.

## Architecture

```
┌─────────────────────────────────────────────────┐
│  .shtml file (one per deck)                     │
│                                                 │
│  <style>  — all CSS: layout, typography,        │
│              effects, responsive breakpoints     │
│  </style>                                       │
│                                                 │
│  <main>   — semantic HTML: <section> per slide, │
│              accessible, keyboard-navigable      │
│  </main>                                        │
│                                                 │
│  <script> — navigation engine (~80 lines),      │
│             animation triggers,                  │
│             sprinkle bridge integration           │
│  </script>                                      │
│                                                 │
└─────────────────────────────────────────────────┘
```

## Phase 0 — Stardust gate

Before content discovery, check for brand tokens:

```bash
test -f DESIGN.json && echo "stardust present"
```

- **Found** → extract palette, typography, and brand personality. The deck inherits the brand's visual identity.
- **Not found** → ask "any brand or URL this should evoke?" or proceed with an original aesthetic.

When stardust is present, read `references/stardust-setup.md` for token extraction guidance.

## Phase 1 — Content & narrative discovery

Conversational. Skip questions already answered.

1. **Purpose** — pitch, teaching, conference talk, internal update, workshop, keynote, retrospective
2. **Length** — short (5–10 slides), medium (10–20), long (20+), or rapid (50+ single-beat slides)
3. **Content readiness** — ready content, or just a topic?
4. **Narrative shape** — pick from `references/storytelling.md`. Defaults by purpose:
   - Keynote, founder story → Hero's Journey (Campbell)
   - Pitch, persuasion → Sparkline / contrast (Duarte)
   - Retrospective, post-mortem → Man-in-Hole (Vonnegut)
   - Product launch → Cinderella (Vonnegut)
   - Technical deep-dive → no shape, structural progression

If the user gives a clear brief ("10-slide pitch about Q3"), infer the shape and skip questions.

## Phase 2 — Write the presentation

### Scoop workflow

One scoop per presentation. The scoop owns the sprinkle.

```
scoop_scoop("quarterly-review")
feed_scoop("quarterly-review", "<full prompt with all context, design tokens, content, narrative shape, and instructions to write the .shtml>")
```

The scoop's job:
1. Read `references/storytelling.md` and the style principles below.
2. If stardust is present, read `DESIGN.json` and derive the visual system.
3. Compose the full HTML document — structure, styles, content, navigation JS.
4. Write it to `/shared/sprinkles/<name>/<name>.shtml`
5. Run `sprinkle open <name>` to display it.
6. Stay alive for edit licks.

### What the scoop writes (the actual HTML)

The scoop writes a complete, valid HTML document. Not a template. Not a data blob. Every presentation is unique. Here is the structural pattern (not a template — adapt freely):

```html
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Presentation Title</title>
  <link rel="icon" href="presentation" />
  <!-- Google Fonts for the chosen type system -->
  <link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=...&display=swap">
  <style>
    /* === Reset + base === */
    /* === Typography === */
    /* === Layout: slides container, per-slide grid === */
    /* === Navigation controls === */
    /* === Per-slide styles (unique layouts, backgrounds, effects) === */
    /* === Animations & transitions === */
    /* === Responsive breakpoints === */
  </style>
</head>
<body>
  <main class="deck" role="region" aria-roledescription="slide deck" aria-label="...">
    <section class="slide" aria-roledescription="slide" aria-label="...">
      <!-- Slide content: headings, text, SVG, images, whatever serves the content -->
    </section>
    <!-- More slides -->
  </main>

  <!-- Navigation (adapt to the deck's needs) -->
  <nav class="controls" aria-label="Slide navigation">...</nav>

  <script>
    // Navigation state machine
    // Keyboard (←→, space), touch (swipe), click
    // Sprinkle bridge: slicc.on('update', ...) for live edits
    // Animation triggers on slide entry
  </script>
</body>
</html>
```

### Navigation engine requirements

The JS navigation must:
- Track current slide index
- Support keyboard (ArrowLeft, ArrowRight, Space, Escape for overview)
- Support touch/swipe on mobile
- Show a slide counter (e.g., "3 / 12")
- Integrate with the sprinkle bridge (`slicc.on('update', ...)`) for live content pushes
- Fire custom events on slide entry (for triggering CSS animations via class toggling)

This is roughly 60–100 lines of vanilla JS. No libraries.

### CSS approach

- Each slide is a viewport-filling `<section>` — use `width: 100%; height: 100vh` or equivalent.
- Navigation via `scroll-snap` (scroll mode) or `transform: translateX()` (traditional mode) or simple `display: none` toggling — whatever suits the deck.
- Typography: use `clamp()` for fluid sizing. Headings should be large and responsive.
- Effects: write CSS directly — gradients, filters, animations, blend modes. No class-name vocabulary to memorize. Just write the effect that serves the slide.
- Responsive: the deck must work from phone (320px) to projector (1920px+). Use container queries or media queries.

### JavaScript: only when CSS can't

Use JS for:
- Slide navigation (the state machine)
- Animated number counters
- Staggered entrance animations with precise timing control
- Code syntax highlighting transitions (Shiki Magic Move style)
- Complex SVG path animations
- Interactive diagrams

Do NOT use JS for:
- Static layouts (use CSS grid/flexbox)
- Hover effects (use CSS :hover)
- Simple fade-in animations (use CSS @keyframes + animation-delay)
- Scroll-triggered reveals (use `animation-timeline: view()`)

## Design Principles

1. **Every deck is bespoke.** No two presentations should share the same CSS. The visual system is derived from the content and brand, not from a preset.
2. **Typography is the primary design tool.** Font choice, size contrast, weight, spacing — these carry more design weight than color or effects.
3. **One idea per slide.** If it has two ideas, it's two slides.
4. **Effects serve narrative.** A blur transition means something. A color shift signals a mood change. Don't decorate — communicate.
5. **Contrast is non-negotiable.** Body text ≥4.5:1, large text ≥3:1 against the actual rendered background (including gradients and images).
6. **Responsive by default.** Presentations get shared as URLs. They must work on phones.
7. **Accessible.** Proper heading hierarchy, ARIA roles, keyboard navigation, reduced-motion media query.

## Font Selection

Banned as primary heading or body: Inter, Roboto, Arial, Helvetica, Open Sans, system-ui. These are defaults, not choices.

When stardust provides font tokens, use them. When it doesn't, choose typefaces that express the content's personality. A pitch for a luxury brand and a technical deep-dive on database internals should not look alike.

Good sources: Google Fonts. Pair a display face with a text face. One is enough for minimal decks.

## Effects & Visual Craft

No vocabulary to memorize. Write the CSS effect directly. Some techniques worth reaching for:

- **Animated gradients** — `conic-gradient` + `@property` for angle animation
- **SVG filters** — inline `<svg>` with `<filter>` elements: displacement maps, turbulence, color matrices
- **Blend modes** — `mix-blend-mode` on overlapping elements
- **Clip paths** — geometric or organic shapes to frame content
- **Backdrop filters** — glassmorphism, blur behind text
- **Text effects** — gradient fills (`background-clip: text`), stroke, shadow stacks
- **View Transitions** — morph elements between slide states
- **Scroll-driven animations** — `animation-timeline: scroll()` for scroll-mode decks
- **3D transforms** — perspective, rotateX/Y for entrance animations

Rules:
- Maximum one background effect per slide. Two competing backgrounds = chaos.
- Text must remain readable over any effect. Use scrim overlays or text-shadow if needed.
- The last slide has no entrance animation. Land clean.
- Respect `prefers-reduced-motion` — provide a `@media (prefers-reduced-motion: reduce)` block that disables animations.

## Anti-tells (banned patterns)

- **Bullet-list decks.** If >40% of slides are heading + bullet list, the deck is wrong. Use varied layouts: large numbers, two-column comparisons, process flows, card grids, big single statements, images, diagrams.
- **Wall of text.** If a bullet has >12 words, it's a sentence, not a bullet. Split or restructure.
- **Generic corporate blue gradient on white.** Every color choice should be intentional.
- **Stat-callout bars** — 3–4 large numbers in a horizontal strip is a cliché.
- **Fabricated data.** Don't invent statistics, quotes, or customer names. Use `[placeholder]` markers if real data isn't provided.
- **Triplet-cadence headlines** — "Not this. Not that. But this." — at most once per deck.
- **Cream/beige backgrounds** unless the brand is literally about paper/printing.

## Lick Events

The sprinkle bridge allows the user to interact:

| User action | Lick payload | Scoop response |
|---|---|---|
| Edit a slide | `{action:'edit-slide', data:{index, instruction}}` | Rewrite that `<section>`, push updated file |
| Add a slide | `{action:'add-slide', data:{afterIndex}}` | Insert new section, push updated file |
| Delete a slide | `{action:'delete-slide', data:{index}}` | Remove section, push updated file |
| Change style | `{action:'change-style', data:{instruction}}` | Revise CSS, push updated file |
| Export | `{action:'export-html'}` | Write standalone HTML to `/shared/exports/` |

For edits, the scoop rewrites the `.shtml` file (or the relevant section) and runs `sprinkle send <name> '{}'` to refresh the panel.

## References

- `references/stardust-setup.md` — how to read DESIGN.json tokens
- `references/storytelling.md` — narrative shapes and selection matrix

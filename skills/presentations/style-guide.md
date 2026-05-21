# Presentation Style Guide

Design reference for creating HTML presentations. Read this before writing any deck.

---

## Core Philosophy

A presentation is a sequence of visual moments. Each moment (slide) communicates one idea through the interplay of typography, space, color, and (sometimes) motion. The CSS you write is the design — there is no layer of abstraction between your intent and the output.

---

## Stardust Integration (preferred)

When `DESIGN.json` exists, derive the visual system from brand tokens rather than inventing one.

### Token Extraction

| DESIGN.json path | CSS custom property | Notes |
|---|---|---|
| `tokens.colors["primary-*"]` or background role | `--bg` | The brand's ground color |
| `tokens.colors["text-primary"]` | `--text` | Body text |
| `tokens.colors["text-heading"]` | `--heading` | Headings |
| `tokens.colors["accent-*"]` or link color | `--accent` | Accent / interactive |
| `tokens.typography.font-family-primary` | `--font-body` | Body typeface |
| `tokens.typography.font-family-primary` | `--font-heading` | Heading typeface (often the same) |
| `tokens.typography.weight-bold` | `--weight-heading` | Heading weight |

### Adapting brand tokens for presentations

Brand tokens are designed for websites (small body text, dense content). Presentations need:
- **Larger scale** — headings 3–5× larger than body. A website H1 at 48px becomes a slide heading at 6–10vw.
- **More whitespace** — websites fill space; slides breathe. 60–70% of a slide's area should be empty.
- **Bolder contrast** — what's subtle at 14px body text needs to be pronounced at presentation scale.
- **Fewer colors** — pick 2–3 from the brand palette. A website uses 8+; a deck uses a focused subset.

### When the brand font is proprietary

If the extracted font (e.g., "Gartner Sans Var") isn't publicly available:
- Pick a substitute with the same classification and feel. The `DESIGN.json` notes field often suggests one.
- Match the weight range and optical characteristics (geometric, humanist, grotesque, etc.)
- Good substitutes for common proprietary fonts:
  - Geometric sans → DM Sans, Plus Jakarta Sans, Outfit
  - Humanist sans → Source Sans 3, Nunito Sans
  - Neo-grotesque → Inter Tight, Albert Sans (note: Inter itself is banned as primary)
  - Serif → Source Serif 4, Literata, Lora

---

## Typography

### Scale

Use fluid typography with `clamp()`. Presentations span phone screens to projectors:

```css
--size-display: clamp(2.5rem, 6vw, 7rem);    /* Hero / title slides */
--size-heading: clamp(2rem, 4.5vw, 5rem);     /* Section headings */
--size-subhead: clamp(1.25rem, 2.5vw, 2.5rem); /* Subheadings */
--size-body:    clamp(1rem, 1.8vw, 1.5rem);    /* Body text */
--size-caption: clamp(0.75rem, 1.2vw, 1rem);   /* Captions, labels */
```

These are starting points. Adjust for the deck's personality.

### Pairing

Every deck needs at most two typefaces: one for headings, one for body. A monospace third for code is fine. Avoid:
- Two fonts of the same classification (two geometrics, two serifs)
- More than 3 font weights total
- Decorative fonts for body text

### Banned fonts (as primary face)

Inter, Roboto, Arial, Helvetica, Open Sans, system-ui, Segoe UI. These are system defaults, not design choices. They may appear in fallback stacks.

---

## Color

### Dark decks (default for most presentations)

Dark backgrounds with light text project better and feel more cinematic. Avoid pure black (#000) — use a deep tinted neutral (#0a0f1a, #1a1018, #0d1210).

### Light decks

Appropriate for: workshops, printed handouts, brands with light palettes. Never plain white (#fff) — use a tinted near-white.

### Accent usage

One accent color, used sparingly for emphasis: key numbers, links, the one word that matters, diagram highlights. If you need a second accent, it should be a tint/shade of the first or a deliberate complement.

### Gradient use

Gradients are backgrounds or text fills, never borders or small elements. One animated gradient per deck maximum. Static gradients are fine on multiple slides if they're the deck's signature look.

---

## Layout Patterns

Each slide is a full-viewport section. Common layout approaches:

### Centered single statement
```css
.slide { display: grid; place-items: center; text-align: center; }
```
For: title slides, big-word beats, quotes, section dividers.

### Left-heavy asymmetric
```css
.slide { display: grid; grid-template-columns: 2fr 1fr; align-items: center; padding: 8%; }
```
For: content with a supporting visual, metrics with context.

### Two-column comparison
```css
.slide { display: grid; grid-template-columns: 1fr 1fr; gap: 4vw; }
```
For: before/after, pros/cons, old way vs new way.

### Stacked cards (2×2 or 3×2)
```css
.slide .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(240px, 1fr)); gap: 2vw; }
```
For: feature grids, team intros, multi-point summaries.

### Full-bleed image + overlay text
```css
.slide { position: relative; }
.slide img { position: absolute; inset: 0; object-fit: cover; }
.slide .content { position: relative; z-index: 1; /* + scrim */ }
```
For: mood slides, chapter openers, visual storytelling.

### Process / timeline (horizontal or vertical)
Use flexbox or grid with connecting lines (borders or SVG paths).

---

## Slide Variety

A good deck mixes slide types. Rough distribution for a 12-slide deck:

| Type | Count | Purpose |
|---|---|---|
| Title | 1 | Opens the deck |
| Section divider | 1–2 | Marks narrative transitions |
| Large statement | 2–3 | Key insights, big numbers, quotes |
| Structured content | 3–4 | Comparisons, processes, card grids, diagrams |
| Supporting detail | 2–3 | Evidence, code, images, timelines |
| Close | 1 | Call to action, summary, contact |

If more than 40% of slides are "heading + bullet list," redesign. Use varied layouts.

---

## Motion & Animation

### Slide transitions

Keep simple. Options:
- **None** — slides snap. Clean for rapid/terse decks.
- **Fade** — `opacity` transition on slide change. Safe default.
- **Slide** — `translateX` for left-right movement. Directional.
- **Morph** — View Transitions API to morph matching elements between slides. Most sophisticated.

### Entrance animations (within a slide)

When a slide becomes active, animate its elements in:
- Stagger children with `animation-delay` increments (80–120ms per item)
- Use `translateY(20px) → 0` + `opacity: 0 → 1` as the base motion
- Duration: 0.3–0.5s per element. Never exceed 0.7s.
- Easing: `cubic-bezier(0.2, 0.8, 0.2, 1)` (smooth deceleration)

### Animated counters

For metric slides, animate numbers from 0 to target:
```js
function countUp(el, target, duration = 1200) {
  const start = performance.now();
  (function tick(now) {
    const t = Math.min((now - start) / duration, 1);
    el.textContent = Math.round(t * target).toLocaleString();
    if (t < 1) requestAnimationFrame(tick);
  })(start);
}
```

### Reduced motion

Always include:
```css
@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after {
    animation-duration: 0.01ms !important;
    transition-duration: 0.01ms !important;
  }
}
```

---

## Effects Techniques

Write effects directly in CSS. Here's a reference catalog — use what serves the content:

### Background effects

**Animated aurora** — conic-gradient with `@property` angle animation:
```css
@property --angle { syntax: '<angle>'; inherits: false; initial-value: 0deg; }
.aurora { background: conic-gradient(from var(--angle), #0f2027, #203a43, #2c5364, #0f2027); animation: rotate 30s linear infinite; }
@keyframes rotate { to { --angle: 360deg; } }
```

**Grain overlay** — SVG noise texture at low opacity:
```css
.grain::after { content:''; position:absolute; inset:0; opacity:0.06; mix-blend-mode:overlay;
  background: url("data:image/svg+xml,...feTurbulence..."); pointer-events:none; }
```

**Grid / dot pattern** — repeating-linear-gradient or radial-gradient at small sizes.

**Gradient mesh** — multiple radial-gradients layered with different positions and blend modes.

### Text effects

**Gradient text fill:**
```css
h1 { background: linear-gradient(135deg, var(--accent), var(--accent-alt));
     -webkit-background-clip: text; background-clip: text; color: transparent; }
```

**Glow:**
```css
h1 { text-shadow: 0 0 20px var(--accent), 0 0 60px color-mix(in srgb, var(--accent) 40%, transparent); }
```

**Stroke outline:**
```css
h1 { -webkit-text-stroke: 2px var(--heading); color: transparent; }
```

### SVG filters (inline in the HTML)

Displacement for organic distortion:
```html
<svg width="0" height="0"><defs>
  <filter id="displace"><feTurbulence baseFrequency="0.02" numOctaves="3" result="noise"/>
  <feDisplacementMap in="SourceGraphic" in2="noise" scale="8"/></filter>
</defs></svg>
```

Use sparingly — one filter-heavy slide per deck is plenty.

### 3D entrance

```css
.slide.entering { animation: tilt-in 0.5s cubic-bezier(0.2,0.8,0.2,1) backwards; }
@keyframes tilt-in { from { opacity:0; transform: perspective(1200px) rotateY(15deg) translateZ(-80px); } }
```

---

## Content Density Limits

| Slide type | Maximum content |
|---|---|
| Title | 1 heading + 1 subtitle |
| Big statement | 1 sentence or number. Period. |
| Quote | 3 lines of quoted text + attribution |
| Comparison | 2 columns × 4 points each |
| Process | 3–5 steps (4 is ideal) |
| Card grid | 4–6 cards |
| Code | 8–12 lines |
| Body content | 1 heading + 5 bullets (short fragments, not sentences) |

If content overflows, split into multiple slides. Never shrink font size to fit.

---

## Responsive Behavior

Presentations get shared as URLs. They must work at:
- **320px** — phone, portrait. Stack everything vertically. Reduce heading sizes.
- **768px** — tablet / half-screen. Side-by-side layouts kick in.
- **1024px+** — laptop / projector. Full layout.
- **1920px+** — large display. Don't let content stretch edge-to-edge; constrain max-width.

Use `clamp()` for typography and `min()` / `max()` for spacing so breakpoints are minimal.

---

## Accessibility

- Slides use `<section>` with `aria-roledescription="slide"` and `aria-label="Slide N: title"`
- The deck container has `role="region"` and `aria-roledescription="slide deck"`
- Navigation is keyboard-accessible (Arrow keys, Space, Home/End)
- Color contrast meets WCAG AA (4.5:1 body, 3:1 large text)
- Images have `alt` text
- `prefers-reduced-motion` is respected
- Focus indicators are visible for keyboard navigation

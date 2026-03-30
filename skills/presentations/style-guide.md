# Presentation Style Guide

Reference for creating reveal.js presentations. Read this before generating any slide deck.

---

## Design Principles

1. **No AI slop** — No generic gradients-on-white, no "corporate futurism," no stock-art energy
2. **No overused fonts** — Never use Inter, Roboto, Arial, Helvetica, Open Sans, or system fonts
3. **Bold choices** — Every theme must feel like a human designer made it with intention
4. **Typography first** — Font pairing drives the mood more than color
5. **Restraint** — One accent color used purposefully beats a rainbow
6. **Contrast matters** — Text must always be effortlessly readable

---

## Theme Presets

### 1. Midnight Aurora

**Mood**: Deep, dramatic, cinematic. For keynotes, product launches, high-stakes pitches.

**Fonts**: Heading: `Space Grotesk` (700) · Body: `Source Serif 4` (400, 400i)

```css
@import url('https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@500;700&family=Source+Serif+4:ital,wght@0,400;0,600;1,400&display=swap');

:root {
  --r-background-color: #0b1120;
  --r-main-color: #c8d6e5;
  --r-heading-color: #e2f0ff;
  --r-accent-color: #36d6a8;
  --r-accent-secondary: #5b8af5;
  --r-heading-font: 'Space Grotesk', sans-serif;
  --r-main-font: 'Source Serif 4', serif;
  --r-heading-font-weight: 700;
  --r-heading-text-transform: none;
}
.reveal { background: radial-gradient(ellipse at 30% 80%, #0f1f3d 0%, #0b1120 70%); }
.reveal h1, .reveal h2 { color: var(--r-heading-color); }
.reveal strong, .reveal b { color: var(--r-accent-color); }
.reveal a { color: var(--r-accent-secondary); }
.reveal code { background: #152238; color: var(--r-accent-color); padding: 0.1em 0.3em; border-radius: 3px; }
.reveal pre code { background: #0d1a2d; border-left: 3px solid var(--r-accent-color); }
.reveal blockquote { border-left: 4px solid var(--r-accent-secondary); color: #8fa5c0; }
```

**Transition**: `fade` · **Code theme**: `atom-one-dark`

---

### 2. Paper & Ink

**Mood**: Warm, editorial, literary. For academic talks, essays, storytelling.

**Fonts**: Heading: `Playfair Display` (700, 700i) · Body: `Libre Baskerville` (400, 400i)

```css
@import url('https://fonts.googleapis.com/css2?family=Playfair+Display:ital,wght@0,700;1,700&family=Libre+Baskerville:ital,wght@0,400;0,700;1,400&display=swap');

:root {
  --r-background-color: #f5f0e8;
  --r-main-color: #2c2416;
  --r-heading-color: #1a150d;
  --r-accent-color: #9e3b2d;
  --r-accent-secondary: #3d6b5e;
  --r-heading-font: 'Playfair Display', serif;
  --r-main-font: 'Libre Baskerville', serif;
  --r-heading-font-weight: 700;
  --r-heading-text-transform: none;
}
.reveal { background: #f5f0e8; }
.reveal h1, .reveal h2 { color: var(--r-heading-color); letter-spacing: -0.02em; }
.reveal h1 { font-style: italic; }
.reveal strong { color: var(--r-accent-color); }
.reveal a { color: var(--r-accent-secondary); text-decoration: underline; }
.reveal code { background: #e8e0d4; color: var(--r-accent-color); padding: 0.1em 0.3em; border-radius: 2px; }
.reveal pre code { background: #2c2416; color: #f5f0e8; border: none; }
.reveal blockquote { border-left: 3px solid var(--r-accent-color); font-style: italic; color: #5a4e3c; }
```

**Transition**: `slide` · **Code theme**: `github-light` (inline), `monokai` (blocks)

---

### 3. Electric Signal

**Mood**: High-energy, technical, cutting-edge. For developer talks, tech demos, launch events.

**Fonts**: Heading: `JetBrains Mono` (700) · Body: `DM Sans` (400, 500)

```css
@import url('https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@500;700&family=DM+Sans:wght@400;500;700&display=swap');

:root {
  --r-background-color: #0a0a0f;
  --r-main-color: #b0b8c8;
  --r-heading-color: #ffffff;
  --r-accent-color: #ff3d71;
  --r-accent-secondary: #00d4aa;
  --r-heading-font: 'JetBrains Mono', monospace;
  --r-main-font: 'DM Sans', sans-serif;
  --r-heading-font-weight: 700;
  --r-heading-text-transform: uppercase;
  --r-heading-letter-spacing: 0.08em;
}
.reveal { background: #0a0a0f; }
.reveal h1, .reveal h2 { color: var(--r-heading-color); font-size: 1.8em; }
.reveal strong { color: var(--r-accent-color); }
.reveal a { color: var(--r-accent-secondary); }
.reveal code { background: #1a1a2e; color: var(--r-accent-color); font-family: 'JetBrains Mono', monospace; padding: 0.1em 0.3em; }
.reveal pre code { background: #12121f; border: 1px solid #2a2a3e; }
.reveal blockquote { border-left: 3px solid var(--r-accent-color); color: #7a8298; }
.reveal .slide-number { color: var(--r-accent-secondary); }
```

**Transition**: `none` · **Code theme**: `dracula`

---

### 4. Dune

**Mood**: Organic, grounded, warm. For sustainability, nature, culture, design talks.

**Fonts**: Heading: `Fraunces` (700) · Body: `Outfit` (300, 400)

```css
@import url('https://fonts.googleapis.com/css2?family=Fraunces:wght@700;900&family=Outfit:wght@300;400;600&display=swap');

:root {
  --r-background-color: #f2ebe0;
  --r-main-color: #3d3228;
  --r-heading-color: #2a1f14;
  --r-accent-color: #c4652a;
  --r-accent-secondary: #4a7c6f;
  --r-heading-font: 'Fraunces', serif;
  --r-main-font: 'Outfit', sans-serif;
  --r-heading-font-weight: 700;
  --r-heading-text-transform: none;
}
.reveal { background: linear-gradient(170deg, #f2ebe0 0%, #e8ddd0 100%); }
.reveal h1, .reveal h2 { color: var(--r-heading-color); }
.reveal strong { color: var(--r-accent-color); }
.reveal a { color: var(--r-accent-secondary); }
.reveal code { background: #e0d5c4; color: var(--r-accent-color); padding: 0.1em 0.3em; border-radius: 3px; }
.reveal pre code { background: #2a1f14; color: #f2ebe0; border-left: 3px solid var(--r-accent-color); }
.reveal blockquote { border-left: 4px solid var(--r-accent-color); color: #6b5d4e; }
```

**Transition**: `slide` · **Code theme**: `nord`

---

### 5. Phosphor

**Mood**: Retro-terminal, nostalgic, hacker. For security talks, CLI demos, retro computing.

**Fonts**: Heading: `IBM Plex Mono` (600) · Body: `IBM Plex Mono` (400, 400i)

```css
@import url('https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:ital,wght@0,400;0,600;1,400&display=swap');

:root {
  --r-background-color: #0c1014;
  --r-main-color: #33cc66;
  --r-heading-color: #44ee77;
  --r-accent-color: #ffcc00;
  --r-accent-secondary: #33cc66;
  --r-heading-font: 'IBM Plex Mono', monospace;
  --r-main-font: 'IBM Plex Mono', monospace;
  --r-heading-font-weight: 600;
  --r-heading-text-transform: none;
}
.reveal { background: #0c1014; }
.reveal::after { content: ''; position: fixed; inset: 0; background: repeating-linear-gradient(transparent, transparent 2px, rgba(0,0,0,0.15) 2px, rgba(0,0,0,0.15) 4px); pointer-events: none; z-index: 9999; }
.reveal h1, .reveal h2 { color: var(--r-heading-color); text-shadow: 0 0 8px rgba(68,238,119,0.3); }
.reveal strong { color: var(--r-accent-color); }
.reveal a { color: var(--r-accent-color); }
.reveal code { background: transparent; color: var(--r-accent-color); }
.reveal pre code { background: #0a0e12; border: 1px solid #1a3a1a; color: var(--r-main-color); }
.reveal blockquote { border-left: 2px solid var(--r-accent-color); color: #228844; }
.reveal .slide-number { font-family: 'IBM Plex Mono', monospace; color: #228844; }
```

**Transition**: `none` · **Code theme**: `monokai`

---

### 6. Nordic Frost

**Mood**: Clean, airy, minimal. For product design, UX talks, corporate strategy.

**Fonts**: Heading: `Manrope` (700, 800) · Body: `Karla` (400, 400i)

```css
@import url('https://fonts.googleapis.com/css2?family=Manrope:wght@700;800&family=Karla:ital,wght@0,400;0,500;1,400&display=swap');

:root {
  --r-background-color: #f8fafb;
  --r-main-color: #2d3748;
  --r-heading-color: #1a202c;
  --r-accent-color: #2563eb;
  --r-accent-secondary: #059669;
  --r-heading-font: 'Manrope', sans-serif;
  --r-main-font: 'Karla', sans-serif;
  --r-heading-font-weight: 800;
  --r-heading-text-transform: none;
}
.reveal { background: #f8fafb; }
.reveal h1, .reveal h2 { color: var(--r-heading-color); letter-spacing: -0.03em; }
.reveal strong { color: var(--r-accent-color); }
.reveal a { color: var(--r-accent-color); text-decoration: none; border-bottom: 2px solid var(--r-accent-secondary); }
.reveal code { background: #edf2f7; color: #6b21a8; padding: 0.15em 0.35em; border-radius: 4px; font-size: 0.85em; }
.reveal pre code { background: #1e293b; color: #e2e8f0; border-radius: 8px; }
.reveal blockquote { border-left: 4px solid var(--r-accent-color); background: #eef4ff; padding: 0.5em 1em; border-radius: 0 6px 6px 0; }
.reveal ul li::marker { color: var(--r-accent-color); }
```

**Transition**: `slide` · **Code theme**: `github-light` (inline), `one-dark` (blocks)

---

### 7. Oxide

**Mood**: Bold, high-contrast, industrial. For data science, infra, systems engineering.

**Fonts**: Heading: `Archivo Black` (400) · Body: `Work Sans` (400, 500)

```css
@import url('https://fonts.googleapis.com/css2?family=Archivo+Black&family=Work+Sans:wght@400;500;600&display=swap');

:root {
  --r-background-color: #18181b;
  --r-main-color: #d4d4d8;
  --r-heading-color: #fafafa;
  --r-accent-color: #f97316;
  --r-accent-secondary: #06b6d4;
  --r-heading-font: 'Archivo Black', sans-serif;
  --r-main-font: 'Work Sans', sans-serif;
  --r-heading-font-weight: 400;
  --r-heading-text-transform: uppercase;
  --r-heading-letter-spacing: 0.04em;
}
.reveal { background: #18181b; }
.reveal h1 { font-size: 2.2em; line-height: 1.1; color: var(--r-accent-color); }
.reveal h2 { color: var(--r-heading-color); }
.reveal strong { color: var(--r-accent-color); }
.reveal a { color: var(--r-accent-secondary); }
.reveal code { background: #27272a; color: var(--r-accent-color); font-size: 0.85em; padding: 0.1em 0.3em; border-radius: 3px; }
.reveal pre code { background: #09090b; border: 1px solid #3f3f46; }
.reveal blockquote { border-left: 4px solid var(--r-accent-color); color: #a1a1aa; }
```

**Transition**: `fade` · **Code theme**: `vitesse-dark`

---

### 8. Rose Quartz

**Mood**: Soft, modern, approachable. For workshops, education, creative briefs, community talks.

**Fonts**: Heading: `Sora` (600, 700) · Body: `Nunito` (400, 400i)

```css
@import url('https://fonts.googleapis.com/css2?family=Sora:wght@600;700&family=Nunito:ital,wght@0,400;0,600;1,400&display=swap');

:root {
  --r-background-color: #fef7f7;
  --r-main-color: #3d2c3e;
  --r-heading-color: #2a1a2c;
  --r-accent-color: #d64077;
  --r-accent-secondary: #7c3aed;
  --r-heading-font: 'Sora', sans-serif;
  --r-main-font: 'Nunito', sans-serif;
  --r-heading-font-weight: 700;
  --r-heading-text-transform: none;
}
.reveal { background: linear-gradient(135deg, #fef7f7 0%, #f5eef8 50%, #eef0fb 100%); }
.reveal h1, .reveal h2 { color: var(--r-heading-color); }
.reveal strong { color: var(--r-accent-color); }
.reveal a { color: var(--r-accent-secondary); }
.reveal code { background: #f0e4f0; color: var(--r-accent-color); padding: 0.1em 0.3em; border-radius: 6px; }
.reveal pre code { background: #2a1a2c; color: #f0e4f0; border-radius: 8px; }
.reveal blockquote { border-left: 4px solid var(--r-accent-secondary); background: rgba(124,58,237,0.05); padding: 0.5em 1em; border-radius: 0 8px 8px 0; }
.reveal ul li::marker { color: var(--r-accent-color); }
```

**Transition**: `convex` · **Code theme**: `github-light` (inline), `panda` (blocks)


---

## Mood → Theme Mapping

Pick the theme based on the presentation's emotional register:

| Mood / Context | Theme |
|---------------|-------|
| Cinematic, dramatic, keynote | **Midnight Aurora** |
| Academic, literary, storytelling | **Paper & Ink** |
| Technical, developer-focused, high-energy | **Electric Signal** |
| Natural, warm, design-oriented | **Dune** |
| Retro, hacker, security, CLI | **Phosphor** |
| Clean, corporate, product design | **Nordic Frost** |
| Infrastructure, systems, data-heavy | **Oxide** |
| Friendly, educational, workshop | **Rose Quartz** |

**When the user specifies a mood**, match to the closest theme. When they specify a theme name, use it directly. When neither is specified, default to **Midnight Aurora** for dark or **Nordic Frost** for light.

---

## Content Density Rules

Maximum content per slide type. **Never exceed these limits.**

| Slide Type | Maximum Content |
|-----------|----------------|
| Title slide | 1 heading + 1 subtitle + optional tagline |
| Content slide | 1 heading + 4–6 bullet points OR 1 heading + 2 short paragraphs |
| Feature grid | 1 heading + 4–6 cards (2×2 or 2×3 layout) |
| Code slide | 1 heading + 8–12 lines of code |
| Quote slide | 1 quote (max 3 lines) + attribution |
| Image slide | 1 heading + 1 image + optional caption |
| Section divider | 1 large heading + optional subtitle |
| Comparison | 1 heading + 2 columns with 3–4 points each |
| Stats / metrics | 1 heading + 3–4 large numbers with labels |

**Rules**:
- If content overflows, **split into multiple slides** — never shrink font size
- Bullet points should be sentence fragments, not paragraphs
- Code blocks should show the essential 8–12 lines, not full files
- One idea per slide. If you're tempted to say "also," it's a new slide

---

## Animation & Fragment Guidelines

### Transitions (between slides)

| Theme | Default Transition | Rationale |
|-------|-------------------|-----------|
| Midnight Aurora | `fade` | Cinematic dissolve matches the mood |
| Paper & Ink | `slide` | Page-turning feel |
| Electric Signal | `none` | Instant cuts feel technical and fast |
| Dune | `slide` | Natural, physical movement |
| Phosphor | `none` | Terminal screens don't transition |
| Nordic Frost | `slide` | Clean, predictable |
| Oxide | `fade` | Dramatic reveals |
| Rose Quartz | `convex` | Playful, dimensional |

### Fragments (within slides)

Use fragments sparingly. Rules:

1. **Bullet lists**: Reveal one at a time ONLY for suspense/punchlines. Default: show all at once
2. **Feature grids**: Never fragment — show the full grid immediately
3. **Code blocks**: Never fragment — code needs full context
4. **Quotes**: Never fragment
5. **Images**: Fade-in is acceptable for dramatic reveal
6. **Stats/metrics**: Can fragment to build narrative ("We went from X → Y → Z")

**Fragment styles** by theme family:
- Dark themes (Aurora, Signal, Phosphor, Oxide): `fade-up` or `fade-in`
- Light themes (Paper, Dune, Frost, Rose): `fade-in` only — no directional movement

### Timing

- Never auto-advance slides
- Fragment animation duration: 0.3s (fast) to 0.5s (dramatic)
- Avoid animation on the first and last slides

---

## Code Syntax Highlighting

Each theme specifies a recommended highlight.js theme. Summary:

| Theme | Inline Code Style | Block Code Theme |
|-------|-------------------|-----------------|
| Midnight Aurora | Teal on dark blue | `atom-one-dark` |
| Paper & Ink | Burgundy on parchment | `monokai` (blocks only) |
| Electric Signal | Pink on near-black | `dracula` |
| Dune | Burnt orange on sand | `nord` |
| Phosphor | Amber on terminal black | `monokai` |
| Nordic Frost | Purple on light gray | `one-dark` |
| Oxide | Orange on dark zinc | `vitesse-dark` |
| Rose Quartz | Rose on lavender | `panda` |

**Rules**:
- Always wrap code in `<pre><code>` with a language class
- Use `data-trim` and `data-noescape` on code blocks
- Tab size: 2 spaces
- Show line numbers only for code blocks ≥ 6 lines
- Highlight key lines with `data-line-numbers="3,7-9"` when explaining specific parts

---

## Background Effects

Subtle background treatments per theme. Apply to `.reveal` or individual slides.

| Theme | Background Effect |
|-------|------------------|
| Midnight Aurora | Radial gradient from deep navy center, optional subtle star-field dots |
| Paper & Ink | Flat cream. Optional: faint paper texture via CSS noise |
| Electric Signal | Flat near-black. Optional: subtle grid pattern (`background-size: 40px 40px`) |
| Dune | Gentle warm gradient (cream → sand) |
| Phosphor | Flat black + CRT scanline overlay (built into theme CSS) |
| Nordic Frost | Flat cool white. Optional: very faint blue tint on section dividers |
| Oxide | Flat dark zinc. Optional: diagonal hatching on section dividers |
| Rose Quartz | Soft multi-stop gradient (pink → lavender → blue-white) |

**Rules**:
- Never use background images on content slides (they fight with text)
- Background effects should be barely noticeable — atmosphere, not decoration
- Section divider slides can have slightly stronger background treatment
- Title slides can use a unique background variant from the same palette
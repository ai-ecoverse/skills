# Presentation Style Guide

Reference for creating reveal.js presentations. Read this before generating any slide deck.

This guide is structured in three layers:

1. **Stardust integration** — when `DESIGN.json` exists, pull tokens dynamically. This is the preferred path.
2. **Anchor moods** — eight starting positions for when stardust is not in play. Each one is a *starting point*, not a finished design.
3. **Bespoke effects layer** — SVG filters, CSS shader patterns, 3D animations. Mandatory on every deck regardless of mode.

Plus: anti-tells, content density rules, and the data contract for the per-slide `effects` array.

---

## Design Principles

1. **No AI slop** — no generic gradients-on-white, no "corporate futurism," no stock-art energy
2. **No banned fonts** — never use Inter, Roboto, Arial, Helvetica, Open Sans, or system fonts as primary heading/body
3. **Bold choices** — every deck must feel like a human designer made it with intention
4. **Typography first** — font pairing drives the mood more than color
5. **Restraint with effects** — one effect per slide, used purposefully. Three competing effects = chaos
6. **Contrast matters** — text must always be effortlessly readable. WCAG AA minimum (4.5:1 body, 3:1 large)

---

## Stardust integration (preferred mode)

When `DESIGN.json` exists at the project root, **generate the theme dynamically** rather than picking a preset. Stardust's `DESIGN.json` carries the resolved brand tokens for the target site/brand; the presentation should use them so the deck feels native to the brand, not pasted into it.

### Reading DESIGN.json

Key paths to extract:

| DESIGN.json path | Reveal.js token | Notes |
|---|---|---|
| `colors.<background-role>.hex` | `--r-background-color` | The brand's ground (often non-cream — respect `extensions.divergence.seed.ground_family`) |
| `colors.<text-primary-role>.hex` | `--r-main-color` | Body text |
| `colors.<heading-role>.hex` | `--r-heading-color` | Heading. Often = `--r-main-color` for cohesion. |
| `colors.<accent-role>.hex` | `--r-accent-color` | Pop. Used for `strong`, link, code, callout |
| `colors.<accent-secondary-role>.hex` | `--r-accent-secondary` | Optional second accent |
| `typography.<headingRole>.fontFamily` | `--r-heading-font` | Brand-native role name like `display-archivist`, `Pomodoro Slab`, etc. |
| `typography.<bodyRole>.fontFamily` | `--r-main-font` | Body face |
| `typography.<headingRole>.fontWeight` | `--r-heading-font-weight` | Weight number, e.g. 700 |
| `typography.<bodyRole>.lineHeight` | line-height on `.reveal` | Body line height |
| `extensions.divergence.font_deck` | @import URL list | Map deck name → Google Fonts URL list (table below) |
| `extensions.divergence.seed.craft` | effects layer keying | Letterpress → ink-bleed; Riso → off-register; folded-paper → fold shadows |
| `extensions.divergence.seed.ground_family` | overall mood key | `dark`, `cream`, `stark-white`, `pale-gray`, `saturated`, `monochrome-tint` |
| `extensions.divergence.seed.decade` | type idiom | 1970s → magazine slab; 1990s → rough early-web; 2025-now → current editorial |

### Font deck → Google Fonts URLs

| Deck | @import URL |
|---|---|
| `editorial-archival` | `https://fonts.googleapis.com/css2?family=Fraunces:ital,wght@0,400;0,700;1,700&family=Big+Shoulders+Stencil+Display:wght@700&family=JetBrains+Mono:wght@500;700&display=swap` |
| `tactile-humanist` | `https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@400;600;800&family=Geist+Mono:wght@400;500&display=swap` |
| `retro-italian` | `https://fonts.googleapis.com/css2?family=Alfa+Slab+One&family=Yeseva+One&family=VT323&display=swap` |
| `zine-maximalist` | `https://fonts.googleapis.com/css2?family=Homemade+Apple&family=Special+Elite&family=Abril+Fatface&family=Bungee+Shade&family=DM+Serif+Display&display=swap` |
| `swiss-modernist` | `https://fonts.googleapis.com/css2?family=Inter+Tight:wght@400;700;900&family=Iosevka:wght@400;700&display=swap` |
| `bauhaus-functional` | `https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@500;700&family=Martian+Mono:wght@400;600&family=Roboto+Slab:wght@400;700&display=swap` |
| `serif-luxury` | `https://fonts.googleapis.com/css2?family=DM+Serif+Display&family=Cormorant+Garamond:ital,wght@0,400;0,600;1,400&family=IBM+Plex+Sans:wght@400;500&display=swap` |
| `bureaucratic` | `https://fonts.googleapis.com/css2?family=IBM+Plex+Serif:wght@400;700&family=IBM+Plex+Mono:wght@400;500&family=IBM+Plex+Sans+Condensed:wght@400;700&display=swap` |
| `broadcast` | `https://fonts.googleapis.com/css2?family=Source+Sans+3:wght@400;700&family=Courier+Prime:wght@400;700&family=Georgia&display=swap` |
| `handmade-signwriter` | `https://fonts.googleapis.com/css2?family=Rubik+Wet+Paint&family=Libre+Caslon+Text:ital,wght@0,400;1,400&family=Syne+Mono&display=swap` |

### Craft → effects-layer key

The seed's `craft` tradition keys the dominant effect on the deck. Pick one effect class per craft and apply it via the `effects` array on slides where it serves narrative.

| Craft seed | Dominant effect class | What it does |
|---|---|---|
| Letterpress | `effect-ink-bleed` | feTurbulence + feDisplacementMap, low scale (0.5) — kiss-impression headline |
| Riso print | `effect-misregister` | Dual-color heading offset 2–3px with mix-blend-mode multiply |
| Embossed leather | `effect-emboss` | feSpecularLighting + feComposite — lit chunky heading |
| Woodblock poster | `effect-grain-knockout` | feTurbulence at scale 4, baseFrequency 0.9, used as alpha mask on heading |
| Terrazzo | `effect-speckled-bg` | Animated radial-gradient mosaic on background |
| Enamel sign | `effect-glossy-stroke` | text-stroke + feSpecularLighting + drop-shadow accent |
| Ceramic transfer | `effect-decal-edge` | clip-path with slight irregularity + drop-shadow |
| Cross-stitch sampler | `effect-grid-overlay` | repeating-linear-gradient grid mask |
| Technical illustration | `effect-blueprint` | feColorMatrix to cyan-on-blueprint + line-art borders |
| Field guide | `effect-marginalia` | small italic captions in margins, dotted leader lines |
| Map engraving | `effect-contour` | layered text-shadows simulating engraved relief |
| Tailor's pattern paper | `effect-pattern-stitch` | dashed-border outlines, perforation marks |
| Wood-veneer marquetry | `effect-veneer` | feDisplacementMap with woodgrain turbulence |
| Folded-paper ephemera | `effect-fold-shadow` | clip-path triangles + linear-gradient shadow simulating creases |
| Neon bending | `effect-neon-glow` | filter: drop-shadow stack at 4 levels (glow + bleed) |
| Photogram | `effect-silhouette` | feColorMatrix to high-contrast B&W + feGaussianBlur halo |
| Plaster cast | `effect-plaster-relief` | feSpecularLighting + low-saturation tone |
| Mosaic tile | `effect-tessellate` | clip-path + grid mask pattern |

### Ground family → effect intensity

The `ground_family` seed determines effect intensity AND color choice for shaders:

- `dark` — full intensity. Glows, neon bleeds, chromatic aberration, scanlines all welcome.
- `cream` — restrained. Ink-bleed and grain only. No glow. (Note: cream grounds are rare per stardust's enforcement; only justified for printing/paper-goods brands.)
- `stark-white` — high contrast. Sharp shadows, no glow, hard-edged shaders only.
- `pale-gray` — medium contrast. Grain and texture welcome, no glow.
- `saturated` — the brand's accent color is the ground. Effects must use the contrast complement, not deepen the same hue.
- `monochrome-tint` — low saturation tinted neutral. Subtle grain, soft shadows, restrained motion.

### Worked example: stardust-derived theme CSS

Given DESIGN.json with: `ground_family: dark`, `craft: Riso print`, `font_deck: tactile-humanist`, palette roles {`Vault: #0d0d12`, `Bone: #f4f1e8`, `Pomodoro: #d83a2a`, `Verdigris: #2ea693`}:

```css
@import url('https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@400;600;800&family=Geist+Mono:wght@400;500&display=swap');

:root {
  /* Vault */    --r-background-color: #0d0d12;
  /* Bone */     --r-main-color:       #f4f1e8;
  /* Bone */     --r-heading-color:    #f4f1e8;
  /* Pomodoro */ --r-accent-color:     #d83a2a;
  /* Verdigris */--r-accent-secondary: #2ea693;
  --r-heading-font: 'Plus Jakarta Sans', sans-serif;
  --r-heading-font-weight: 800;
  --r-main-font: 'Plus Jakarta Sans', sans-serif;
  --r-mono-font: 'Geist Mono', monospace;
  --r-heading-text-transform: none;
}
.reveal { background: var(--r-background-color); }
.reveal h1, .reveal h2 { color: var(--r-heading-color); }
.reveal strong, .reveal b { color: var(--r-accent-color); }
.reveal a { color: var(--r-accent-secondary); }

/* Riso misregister effect — dual-color heading */
.reveal .effect-misregister h1,
.reveal .effect-misregister h2 {
  position: relative;
  color: var(--r-heading-color);
}
.reveal .effect-misregister h1::before,
.reveal .effect-misregister h2::before {
  content: attr(data-text);
  position: absolute;
  inset: 0;
  color: var(--r-accent-color);
  transform: translate(2px, -2px);
  mix-blend-mode: screen;
  z-index: -1;
}
```

Note the brand-native role-name comments above each token. Stardust's role-naming rule (Pomodoro, Vault, Verdigris) carries through to the comments — never strip them.

---

## Anchor moods (fallback mode)

When stardust is not in play, pick from these eight anchor moods. Each is a *starting point*: layer the bespoke effects on top, push beyond the baseline.

### 1. Midnight Aurora · cinematic, dramatic, keynote

**Fonts**: Heading `Space Grotesk` (700) · Body `Source Serif 4` (400, 400i) · Mono `JetBrains Mono`

**Default effect**: `effect-aurora-bg` (animated conic-gradient + feGaussianBlur), `effect-displaced-heading` (subtle feTurbulence on h1)

```css
@import url('https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@500;700&family=Source+Serif+4:ital,wght@0,400;0,600;1,400&family=JetBrains+Mono:wght@500&display=swap');
:root {
  --r-background-color: #0b1120;
  --r-main-color: #c8d6e5;
  --r-heading-color: #e2f0ff;
  --r-accent-color: #36d6a8;
  --r-accent-secondary: #5b8af5;
  --r-heading-font: 'Space Grotesk', sans-serif;
  --r-main-font: 'Source Serif 4', serif;
  --r-heading-font-weight: 700;
}
.reveal { background: radial-gradient(ellipse at 30% 80%, #0f1f3d 0%, #0b1120 70%); }
```

**Transition**: `fade` · **Code theme**: `atom-one-dark`

### 2. Paper & Ink · warm, editorial, literary

**Fonts**: Heading `Playfair Display` (700, 700i) · Body `Libre Baskerville` (400, 400i)

**Default effect**: `effect-ink-bleed` on display headings, `effect-grain-overlay` on backgrounds

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
}
.reveal { background: #f5f0e8; }
```

**Transition**: `slide` · **Code theme**: `monokai` (blocks)

### 3. Electric Signal · high-energy, technical, cutting-edge

**Fonts**: Heading `JetBrains Mono` (700) · Body `DM Sans`

**Default effect**: `effect-chromatic-aberration` on h1 (RGB-split text-shadow), `effect-grid-bg` (40px subtle grid)

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
  --r-heading-text-transform: uppercase;
  --r-heading-letter-spacing: 0.08em;
}
.reveal { background: #0a0a0f; }
```

**Transition**: `none` · **Code theme**: `dracula`

### 4. Dune · organic, grounded, warm

**Fonts**: Heading `Fraunces` (700) · Body `Outfit` (300, 400)

**Default effect**: `effect-emboss` on headings, `effect-grain-overlay` low-intensity

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
}
.reveal { background: linear-gradient(170deg, #f2ebe0 0%, #e8ddd0 100%); }
```

**Transition**: `slide` · **Code theme**: `nord`

### 5. Phosphor · retro-terminal, nostalgic, hacker

**Fonts**: Heading `IBM Plex Mono` (600) · Body `IBM Plex Mono` (400, 400i)

**Default effect**: `effect-scanlines` (built into mood), `effect-neon-glow` on h1, `effect-crt-warp` on `.reveal`

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
}
.reveal { background: #0c1014; }
.reveal::after { content: ''; position: fixed; inset: 0; background: repeating-linear-gradient(transparent, transparent 2px, rgba(0,0,0,0.15) 2px, rgba(0,0,0,0.15) 4px); pointer-events: none; z-index: 9999; }
.reveal h1, .reveal h2 { color: var(--r-heading-color); text-shadow: 0 0 8px rgba(68,238,119,0.3); }
```

**Transition**: `none` · **Code theme**: `monokai`

### 6. Nordic Frost · clean, airy, minimal

**Fonts**: Heading `Manrope` (700, 800) · Body `Karla` (400, 400i)

**Default effect**: `effect-mix-blend-headings` (difference blend on h1 over secondary band), `effect-soft-shadow-card`

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
}
.reveal { background: #f8fafb; }
```

**Transition**: `slide` · **Code theme**: `one-dark`

### 7. Oxide · bold, high-contrast, industrial

**Fonts**: Heading `Archivo Black` · Body `Work Sans`

**Default effect**: `effect-3d-flip-in` on title slides, `effect-hard-stroke` on headings

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
  --r-heading-text-transform: uppercase;
}
.reveal { background: #18181b; }
```

**Transition**: `fade` · **Code theme**: `vitesse-dark`

### 8. Rose Quartz · soft, modern, approachable

**Fonts**: Heading `Sora` (600, 700) · Body `Nunito`

**Default effect**: `effect-conic-bg` (slow conic-gradient @property animation), `effect-holographic` on h1

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
}
.reveal { background: linear-gradient(135deg, #fef7f7 0%, #f5eef8 50%, #eef0fb 100%); }
```

**Transition**: `convex` · **Code theme**: `panda`

---

## Bespoke effects layer (mandatory)

Every deck applies effects from this catalog via the per-slide `effects` array. Effects are CSS classes the template applies to the slide's `<section>`. Reuse the inline SVG filter library defined in the template — don't redefine filters per deck.

### Effects vocabulary

#### Background effects (apply to slide section)

| Class | What it does | Mode |
|---|---|---|
| `effect-aurora-bg` | Animated conic-gradient (45s rotation) + feGaussianBlur halo. Uses `--r-accent-color` and `--r-accent-secondary`. | dark |
| `effect-grid-bg` | 40px repeating-linear-gradient grid at 0.04 alpha | dark, mono |
| `effect-grain-overlay` | feTurbulence baseFrequency 0.65 as alpha mask, opacity 0.08 | any |
| `effect-scanlines` | repeating-linear-gradient horizontal lines at 4px stride | dark only |
| `effect-conic-bg` | `@property --rot` 60deg/sec conic-gradient with 8 stops | light, gradient |
| `effect-speckled-bg` | radial-gradient mosaic, pseudo-random distribution via box-shadow stack | light, terrazzo |
| `effect-blueprint-bg` | feColorMatrix to cyan-on-blueprint + line-art `radial-gradient` overlay | dark |

#### Heading effects (apply to slide section, target h1/h2)

| Class | What it does | Mode |
|---|---|---|
| `effect-displaced-heading` | feTurbulence + feDisplacementMap (scale 1.5) on h1 | any |
| `effect-chromatic-aberration` | text-shadow stack: red −2px, cyan +2px on h1 | dark |
| `effect-misregister` | Riso-style dual-color offset heading via ::before with mix-blend-screen | dark, mono |
| `effect-ink-bleed` | feTurbulence + feDisplacementMap (scale 0.5) — kiss impression | light, paper |
| `effect-emboss` | feSpecularLighting + feComposite — lit relief heading | any |
| `effect-glossy-stroke` | text-stroke + drop-shadow accent ring | any |
| `effect-neon-glow` | drop-shadow stack at 4 levels (close glow + far bleed) using `--r-accent-color` | dark |
| `effect-holographic` | conic-gradient text fill via background-clip + animation | light, gradient |
| `effect-hard-stroke` | text-stroke 2px + offset hard drop-shadow | any |

#### Slide-level effects (entrance / transform)

| Class | What it does | When |
|---|---|---|
| `effect-3d-flip-in` | rotateY(60deg) → 0 on slide entry, 0.6s | title, section |
| `effect-3d-tilt-in` | rotateX(20deg) translateZ(-100px) → 0, 0.5s | title |
| `effect-zoom-blur` | scale(1.5) + filter:blur(20px) → 1, 0.7s | dramatic reveal |
| `effect-slide-stack` | child elements slide in from below at 80ms stagger | content slides |
| `effect-mix-blend-headings` | h1 gets mix-blend-mode: difference over a colored band ::before | content |

#### Per-element decorations

| Class | What it does | Apply to |
|---|---|---|
| `effect-fold-shadow` | clip-path triangle + linear-gradient shadow on container | sections, blockquote |
| `effect-pattern-stitch` | dashed-border around block elements | callouts |
| `effect-marginalia` | small italic captions positioned absolute in margins | optional |
| `effect-decal-edge` | irregular clip-path + drop-shadow | images, cards |

### Effect composition rules

1. **One background effect per slide.** Don't stack `effect-aurora-bg` with `effect-conic-bg` — pick one. They fight.
2. **One heading effect per slide.** `effect-misregister` and `effect-chromatic-aberration` are the same idea expressed differently — don't stack.
3. **Slide-level entrance + heading effect = OK.** They run at different times.
4. **Skip effects on text-dense content slides.** A 6-bullet content slide doesn't need `effect-zoom-blur` — readability wins. Reserve dramatic effects for title and section slides.
5. **Skip ALL effects on the last slide.** Land softly. The audience is scanning for the takeaway, not admiring shaders.

### How effects are wired

The template (`templates/presentation.shtml`) ships an inline `<svg>` defs block with named filters: `#filter-displace-soft`, `#filter-displace-strong`, `#filter-emboss`, `#filter-grain`, `#filter-glow`, `#filter-blueprint`, `#filter-photogram`, `#filter-veneer`. CSS classes reference these via `filter: url(#filter-displace-soft)`.

The data contract's `effects` array on each slide becomes a space-joined `class=""` on the rendered `<section>`. The template's CSS contains the rules for every `.effect-*` class.

---

## Mood → Anchor mapping (fallback only)

Pick the anchor mood based on the deck's emotional register when stardust is not in play:

| Mood / Context | Anchor |
|---|---|
| Cinematic, dramatic, keynote | **Midnight Aurora** |
| Academic, literary, storytelling | **Paper & Ink** |
| Technical, developer-focused, high-energy | **Electric Signal** |
| Natural, warm, design-oriented | **Dune** |
| Retro, hacker, security, CLI | **Phosphor** |
| Clean, corporate, product design | **Nordic Frost** |
| Infrastructure, systems, data-heavy | **Oxide** |
| Friendly, educational, workshop | **Rose Quartz** |

When the user specifies a mood, match to the closest anchor. When nothing is specified, default to **Midnight Aurora** for dark or **Nordic Frost** for light. Whichever you pick, the effects layer is still mandatory.

---

## Bespoke slide types

Bullet-list `content` slides are **one of fourteen types**, not the default. A deck made of bullet slides is the bland-deck failure mode the skill exists to prevent. Pick the type that matches the *informational shape* of the slide.

| Type | When to use | Required fields |
|---|---|---|
| `title` | Opening slide. One headline. | `title`, optional `subtitle` |
| `section` | Act / chapter divider. Single bold headline, centered. | `title`, optional `subtitle` |
| `big-word` | One word or short phrase fills the screen (clamp 64–220px). Default for rapid mode. | `word`, optional `accent` (substring), optional `subtitle` |
| `metric` | Single huge number + label + optional delta. Replaces stat-callout bars. | `metric: { value, label, delta?, direction? }` |
| `comparison` | Two columns separated by a vertical "VS". Then/now, us/them, problem/solution. | `comparison: { left, right, vs? }` where each side is `{ title, items?, content? }` |
| `process` | Numbered horizontal steps with arrow connectors. Workflow, recipe, methodology. | `steps: [{ title, description }]` |
| `timeline` | Vertical timeline with dated events. Roadmap, history, retrospective. | `events: [{ date, title, description }]` |
| `definition` | Term + meaning, dictionary-entry style. Manifesto, glossary, "what we mean by X". | `definition: { term, pos?, pronunciation?, meanings: [...] }` |
| `cards` | 2x2, 3x2, or 3x3 grid of mini-cards with icon + title + body. Feature list, principles, team. | `cards: { layout, items: [{ icon, title, description }] }` |
| `diagram` | Agent-supplied SVG or HTML. Architecture, flow, map. | `diagram: "<svg>...</svg>"`, optional `caption` |
| `quote` | Single quote, max 3 lines. | `quote`, optional `attribution` |
| `image` | Hero image + heading + optional caption. | `src`, `alt` |
| `code` | Code block, 8–10 lines, syntax-highlighted. | `code`, `language` |
| `content` | Bulleted list. **Use sparingly** — most lists are better as `cards` or `process`. | `bullets`, optional `title`, optional `content` HTML |
| `html` | **Full-power escape hatch** — agent-controlled HTML with no sanitizer. `<script>`, `<style>`, `<iframe>`, `on*=` handlers, animated SVG, custom canvas/WebGL, third-party widgets all work. Scripts are rehydrated post-render so they actually execute. For one-off interactive scenes, slide-scoped CSS, embedded demos, or anything the type catalog doesn't cover. | `html: "<style>...</style><script>...</script><div>...</div>"` |
| `recap` | **Closing slide.** 3 takeaways + 1 CTA, two-column layout. End-screen for an async-shared deck. | `takeaways: [string, string, string]`, `cta: { label, text }` |
| `zoom-overview` | Mode=zoom only. Names regions to zoom into; renders as labeled chips or supplied diagram. | `regions: [{ id, label }]` or `diagram` |
| `zoom-detail` | Mode=zoom only. Sits as a vertical sub-slide under a `zoom-overview`. | `regionId` (links back), plus content of choice |

**Picking rule of thumb**: if you reach for bullets, ask first whether the items are (a) a temporal sequence → `process` or `timeline`, (b) two opposing groups → `comparison`, (c) parallel categories → `cards`, (d) a definition → `definition`, (e) a single magnitude → `metric`. Bullets are the *fallback*.

### The `html` escape hatch — full power

The `html` slide type passes the agent's HTML through verbatim — no sanitizer. `<script>`, `<style>`, `<iframe>`, animated SVG, canvas/WebGL, third-party CDN widgets all work. Scripts are rehydrated after innerHTML insertion so they execute.

**Use when** the type catalog doesn't fit:
- Interactive demos (a working calculator, a live data visualization, a tiny game)
- Slide-scoped CSS that needs `@keyframes` or pseudo-element artistry beyond the effects layer
- Embedded third-party widgets (CodePen, Observable, GitHub gists, video players)
- Custom canvas/WebGL scenes
- Multi-step animated sequences with their own JS state machine

**Example — slide-scoped CSS animation:**

```json
{
  "type": "html",
  "effects": ["effect-aurora-bg"],
  "html": "<style>.orbit{position:relative;width:60vmin;height:60vmin;margin:auto;animation:spin 24s linear infinite}.orbit .planet{position:absolute;inset:0;animation:orbit 12s linear infinite}.orbit .planet b{display:block;width:2vmin;height:2vmin;border-radius:50%;background:var(--r-accent-color);transform:translate(28vmin,0)}@keyframes spin{to{transform:rotate(360deg)}}@keyframes orbit{to{transform:rotate(-360deg)}}</style><div class='orbit'><div class='planet'><b></b></div></div>"
}
```

**Example — embedded interactive (script tag rehydrates):**

```json
{
  "type": "html",
  "html": "<div id='counter' style='font-size:30vmin;text-align:center;font-family:var(--r-heading-font)'>0</div><script>let n=0;setInterval(()=>{n++;document.getElementById('counter').textContent=n},100)</script>"
}
```

**Trust model.** The deck is agent-authored. Scripts run with the privileges of the sprinkle iframe. Don't put untrusted user input into the `html` field — the agent is the trusted authority.

**Constraints**:
- Inline `<style>` is slide-scoped *by convention* — wrap rules in a unique class so they don't bleed into other slides.
- Inline `<script>` runs on slide load (when innerHTML is set + rehydrated). It does NOT re-run on slide re-show. If you need per-show side effects, listen for `slidechanged` from the parent.
- The `effects` array still works — you can layer the bespoke effects on top of an `html` slide.
- The `builds` array still works — pass selectors that match elements inside your HTML for staged reveals.

---

## Builds (staged element reveals)

Beyond reveal.js fragments, slides take a `builds` array that maps CSS selectors to staged reveals. The renderer adds `class="fragment"` and `data-fragment-index` to matched children.

```json
"builds": [
  { "selector": ".card", "stagger": true },        // each card reveals one after the next
  { "selector": "h3", "at": 1 },                    // h3 reveals at fragment index 1
  { "selector": ".timeline-event", "stagger": true }
]
```

**Allowed selectors**: any CSS selector, but stick to class names and tag names; complex selectors get fragile across renders.

**Stagger vs at**: `stagger: true` indexes matches 0, 1, 2, … so each one steps in. `at: <n>` reveals the matched elements at a specific fragment index — useful when multiple staged reveals should fire together.

**When to use**:
- `cards` — almost always stagger, so the audience absorbs each one.
- `process`, `timeline` — stagger to match the temporal narrative.
- `metric` — never. The number lands in one moment.
- `quote` — never. A quote arrives whole or not at all.
- `big-word` — never. The point of `big-word` is the impact of one beat.

**Mini-animations** (CSS classes the agent can add to children for richer entrance):

| Class | Effect |
|---|---|
| `typewriter` | Types text out character by character on slide entry. Use on `<span>` inside a heading. |
| `counter-up` | Animates a number from 0 to its `data-target` value over 1.2s. Use `data-format="int"` for integers, `data-suffix="%"` for units. |
| `draw-line` | Animates an SVG path's `stroke-dashoffset` to 0 — line draws itself. Use on a `<line>` or `<path>` inside a `diagram`. |
| `flip-card` | Element flips in 3D on entrance. Use on a `cards` child. |
| `[data-from="left\|right\|top\|bottom"]` | Element slides in from that direction on entrance. Use sparingly. |

These are auto-suppressed in **rapid** mode (slides too short for animations to land).

---

## Presentation modes

Four modes; pick one per deck via the data contract's `mode` field.

### traditional

Default. Manual advance. All slide types, all effects, all builds available.

### zoom — big picture first, then zoom into parts

A `zoom-overview` slide names regions of a larger whole; each subsequent vertical sub-slide is a `zoom-detail` that drills into one region. The detail slide entry runs an `effect-zoom-blur`-like animation by default.

**Composition pattern**:
```
section[type=zoom-overview] (regions: north, south, east, west)
  ↓ vertical
  section[type=zoom-detail, regionId=north]
  section[type=zoom-detail, regionId=south]
  section[type=zoom-detail, regionId=east]
  section[type=zoom-detail, regionId=west]
section[type=section] (next chapter)
```

**Tips**:
- Provide a `diagram` on the overview so regions sit in a real spatial layout — not just a chip list.
- Each detail's `regionId` must match an overview region. Renderer uses this to apply the zoom transition.
- Cap at 5 regions per overview. More than 5 and the audience loses track.

### rapid — Lessig-style, ≤20 sec/slide

100 slides, single word or sentence per slide. Auto-advances. Effects and entrance animations are suppressed (too short to land).

**Hard rules in rapid mode**:
- Each slide ≤20 sec auto-advance (default 20000ms; per-slide override allowed).
- Slide types: `big-word` (default), `metric`, `image`, single-sentence `content`. **Bullets banned.**
- Total slide count: 50+ minimum (warn the user otherwise — sub-50 isn't really rapid).
- No `effect-aurora-bg` / `effect-conic-bg` (too slow). Static backgrounds only.
- No build sequences. The audience sees the slide for 20 sec; staged reveals don't have time.

**Voice in rapid mode**: terse. Each slide is a beat. The audience reads the slide in 2 seconds and listens to the speaker for the rest.

### scroll — share-friendly scrolling deck

Reveal.js v5's built-in `view: 'scroll'` mode. The deck becomes a vertically-scrolling document — each slide is a viewport-sized section. Best for decks shared as URLs after a talk, where the viewer wants to skim. Auto-adds a scroll-driven CSS-only progress bar at the top (no JS, uses `animation-timeline: scroll(root block)`).

**Tips**:
- Pair with the `recap` slide type at the end — async readers go straight there.
- Effects layer still applies, but `effect-3d-flip-in`-style entrance animations don't fire in scroll view (no slide-change events).
- Use `effect-snap-carousel` on `cards` slides for horizontal sub-flow within a section.

---

## View Transitions and cross-slide morphs

The template auto-applies `view-transition-name` to key elements (h1 in title slides, h2 across slides, `.metric-value`, `.big-word`). On browsers that support the View Transitions API (Baseline since Oct 2025), the browser morphs same-named elements between slide changes — a metric value can morph in size and position into a big-word headline on the next slide, the deck headline persists as a slide changes, etc.

### How to opt elements in

Two ways:

1. **Implicit** — use the slide types and the template handles it. h1 in `title-slide`/`section-slide` shares the `deck-headline` name across slides, so it morphs.

2. **Explicit `data-vt-name`** — for custom morphs across non-matching types, add the same `data-vt-name="my-thing"` to two elements on adjacent slides:

```json
{ "type": "html", "html": "<svg data-vt-name='hero-shape'>...</svg>" },
{ "type": "html", "html": "<svg data-vt-name='hero-shape'>...</svg>" }
```

The browser will morph the SVG between the two states.

### The `data-id` auto-animate technique (reveal.js native)

Separately from View Transitions, reveal.js's auto-animate matches by `data-id` across adjacent sections with `data-auto-animate`:

```html
<section data-auto-animate>
  <h1 data-id="hero">Before</h1>
  <p data-id="ratio" style="font-size: 30px;">10%</p>
</section>
<section data-auto-animate>
  <h1 data-id="hero">After</h1>
  <p data-id="ratio" style="font-size: 200px;">94%</p>
</section>
```

Reveal animates every CSS property between the two `data-id="hero"` and `data-id="ratio"` pairs. Use this for: a number that grows, an icon that travels across the slide, a card that morphs into a chart. The two morphing techniques (View Transitions and auto-animate) compose: VT handles cross-slide morphs declaratively; auto-animate handles per-property tweens with explicit `data-id` matching.

---

## Anchor-positioned callouts

For tooltips, footnotes, and term-definition asides on `definition` and `diagram` slides:

```html
<p>The <span class="anchor" id="zenith" style="--anchor: --zenith">zenith</span> is the highest point...</p>
<aside class="callout" style="--anchor: --zenith">
  Astronomy: the point on the celestial sphere directly above the observer.
</aside>
```

CSS handles the rest — the callout positions below the anchor, flips above when it would overflow the viewport (`position-try-fallbacks: flip-block, flip-inline`).

For click-to-reveal popovers, use the Popover API:

```html
<button popovertarget="def-zenith" class="anchor">zenith</button>
<aside id="def-zenith" popover>
  Astronomy: the point on the celestial sphere directly above the observer.
</aside>
```

---

## Contrast guarantees

Dark backgrounds with bespoke effects can wreck contrast. The template ships an **automatic protection layer** that you must respect:

### Auto-applied (don't undo)

The template adds text-shadow halos to headings and body text on slides carrying any of: `effect-aurora-bg`, `effect-conic-bg`, `effect-speckled-bg`, `effect-blueprint-bg`. The shadow is tinted to the background color so headings stay readable as the conic gradient passes underneath.

### Heading effects + busy backgrounds

Two heading effects degrade contrast on busy bgs:

- **`effect-holographic`** — text fill is a moving gradient, low contrast against patterned grounds. Combine only with flat backgrounds (`#hex` background only) or pair with `text-protect` on the heading.
- **`effect-chromatic-aberration`** — the text-shadow stack at red/cyan offsets reduces effective contrast. Template forces the heading core to white when this effect is on. Don't override.

### The `text-protect` utility

Add the `text-protect` class to any element sitting over a busy region. It renders a soft radial darken behind the element keyed to `--r-background-color`.

```html
<h1 class="text-protect">Statement that needs to be readable</h1>
```

Use sparingly — overuse = visual noise.

### Hard contrast minimums

- Body text: ≥4.5:1 against rendered background (WCAG AA)
- Large text (≥24px): ≥3:1
- The 8 anchor moods all pass these; the bespoke-effects layer is what threatens them.
- When in doubt, drop the effect rather than the readability.

---

## Anti-tells (banned moves)

Per stardust's divergence toolkit. These are the assistant's recurring defaults — banned outright on this skill except with a **brand-specific written justification** (the kind that wouldn't transfer to another brand unchanged).

**Visual:**
- Cream-family page ground (any color where HSL-L is 80–97, R−B ≥ 5, S < 40%) — banned unless the brand's category is literally printing/publishing/paper-goods.
- 45° hazard stripes (yellow + ink, two-tone alternation).
- Hard non-blur drop shadow on display headings (offset 6–14px) without a craft justification.
- Rotated circular stamps with perimeter text.
- Stat-callout bar (3–4 large numbers + all-caps labels in a horizontal trust strip).
- Generic-2026-SaaS hero silhouette — oversized clamp() sans + two-button CTA pair + sticky top-nav.
- Hero text on photographic background without ≥0.4 contrast scrim.

**Type:**
- Stencil display (Big Shoulders Stencil) used for non-archival/industrial brands.
- UPPERCASE condensed sans as primary display register without justification.
- Italic expressive serif single-word accents (Fraunces italic, etc.) used as a visual gimmick.

**Voice / copy:**
- Triplet-cadence headlines: "Same press. Same shop. Same eight years." — at most ONE per deck.
- Editorial vocabulary on non-editorial brands: "atelier", "the journal", "dispatches", "manifesto", "field guide" applied to product/services/B2B/healthcare.
- Quartermaster/curator/examiner register as default voice.

**Fabricated content:**
- Invented stats, addresses, named-customer logos, named-person quotes, dollar amounts, percentages, dates that don't appear in the user's brief or in stardust's `current/pages/<slug>.json`. Use `data-placeholder="true"` with a visible signature treatment instead.

**Bland-deck patterns:**
- **Bullet-list deck** — more than 40% of slides are `content` type with bullets. Test from draft: `(count(slides[type='content' and bullets]) / total) > 0.4` is the failure. Replace bullet slides with `metric`, `comparison`, `process`, `timeline`, `cards`, `definition`, or `big-word` per the informational shape.
- **Title-then-bullets-then-title** — every non-title slide is `<h2>` + `<ul>`. Even when the bullet count is reasonable, the *rhythm* is dead. At least every third content-bearing slide should be a non-bullet type.
- **Wall-of-text content slide** — bullets that are full sentences with sub-clauses. Bullets are sentence fragments. If a bullet has >12 words, split the slide or move to `quote` / `definition`.
- **No builds** — multi-element slides (cards, process, timeline) without a `builds` array. The audience sees everything at once and tunes out. Stagger them.

If a draft hits any of these, rewrite. "Feels right for the brand" is not a justification.

---

## Content Density Rules

Maximum content per slide type. **Never exceed these limits.**

| Slide Type | Maximum Content |
|---|---|
| `title` | 1 heading + 1 subtitle + optional tagline |
| `section` | 1 large heading + optional subtitle |
| `big-word` | 1 word OR 1 short phrase (≤6 words). Optional 1-line subtitle. |
| `metric` | 1 number + 1 label + optional delta. Never two metrics on one slide. |
| `comparison` | 1 heading + 2 columns × 3–4 points each |
| `process` | 1 heading + 3–5 steps (4 is the sweet spot) |
| `timeline` | 1 heading + 4–6 events (more = fragment with builds) |
| `definition` | 1 term + 1–3 meanings + optional pronunciation/POS |
| `cards` | 1 heading + 4 cards (2×2) or 6 cards (3×2) or 9 cards (3×3) |
| `diagram` | 1 heading + 1 diagram + optional caption |
| `content` | 1 heading + 4–6 bullets OR 2 short paragraphs |
| `code` | 1 heading + 8–12 lines of code |
| `quote` | 1 quote (max 3 lines) + attribution |
| `image` | 1 heading + 1 image + optional caption |
| `zoom-overview` | 1 heading + 3–5 regions |
| `zoom-detail` | Same as the underlying type it carries |
| `html` | Agent's responsibility — no enforced limit, but the *one idea per slide* rule still applies |

If content overflows, **split into multiple slides** — never shrink font size. Bullet points are sentence fragments, not paragraphs. Code blocks show the essential 8–12 lines, not full files. One idea per slide.

---

## Animation & Fragment Guidelines

### Transitions (between slides)

Mood defaults from the anchor moods table above. Stardust mode: pick `fade` for `dark` ground, `slide` for `cream`/`stark-white`/`pale-gray`, `convex` for `monochrome-tint`, `none` for retro/terminal registers, `fade` for `saturated`.

### Fragments (within slides)

Use sparingly. Rules:

1. **Bullet lists**: reveal one at a time ONLY for suspense/punchlines. Default: show all at once.
2. **Feature grids**: never fragment.
3. **Code blocks**: never fragment — code needs full context.
4. **Quotes**: never fragment.
5. **Images**: fade-in is acceptable for dramatic reveal.
6. **Stats**: can fragment to build narrative ("X → Y → Z").

**Fragment styles:**
- Dark grounds: `fade-up` or `fade-in`
- Light grounds: `fade-in` only — no directional movement

### Timing

- Never auto-advance slides
- Fragment animation duration: 0.3s (fast) to 0.5s (dramatic)
- Effect-layer entrance animations 0.5s–0.7s; cap at 0.7s to keep pacing
- Skip effect entrances on the first and last slides

---

## Code Syntax Highlighting

Per anchor / stardust mode:

| Mode | Inline Code Style | Block Code Theme |
|---|---|---|
| Midnight Aurora | Teal on dark blue | `atom-one-dark` |
| Paper & Ink | Burgundy on parchment | `monokai` (blocks only) |
| Electric Signal | Pink on near-black | `dracula` |
| Dune | Burnt orange on sand | `nord` |
| Phosphor | Amber on terminal black | `monokai` |
| Nordic Frost | Purple on light gray | `one-dark` |
| Oxide | Orange on dark zinc | `vitesse-dark` |
| Rose Quartz | Rose on lavender | `panda` |
| Stardust dark ground | Accent-color on bg layer | `atom-one-dark` or `vitesse-dark` |
| Stardust light ground | Accent-color on bg layer-1 | `github-light` or `nord` |
| Stardust saturated | Inverted (light on accent) | `monokai` |

**Rules:**
- Always wrap code in `<pre><code>` with a language class
- Use `data-trim` and `data-noescape` on code blocks
- Tab size: 2 spaces
- Show line numbers only for code blocks ≥ 6 lines
- Highlight key lines with `data-line-numbers="3,7-9"` when explaining specific parts

---

## Background Effects (legacy, see Bespoke effects layer above for the canonical list)

The 8 anchor moods carry default backgrounds (radial gradient, flat near-black, scanline overlay, etc.). The effects-layer classes above are *additions* on top of the mood baseline — they are not replacements for the mood's background. Don't apply two background effects to the same slide.

**Rules:**
- Never use background images on content slides (they fight with text and any heading effect)
- Background effects should be barely noticeable as decoration — atmosphere, not foreground
- Section divider slides can carry stronger background treatment
- Title slides can use a unique background variant from the same palette

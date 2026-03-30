---
name: presentations
description: Create interactive reveal.js presentations as sprinkles
allowed-tools: bash
---

# Presentations

Create reveal.js slide decks as interactive SLICC sprinkles. The user asks for a presentation, you build it as a sprinkle panel where slides can be navigated, edited, and refined through the lick bridge.

**Trigger phrases:** "create a presentation", "make slides", "build a deck", "presentation about X", "slide deck", "make a pitch deck"

## Phase 1 — Content Discovery

Before generating anything, gather requirements through quick questions:

1. **Purpose** — "What's this for?" (pitch, teaching, conference talk, internal update, workshop)
2. **Length** — "How long?" (5–10 slides, 10–20, 20+)
3. **Content readiness** — "Do you have content ready, or just a topic?"
4. **Style** — Show 1–2 sample slides as inline shtml cards with different themes, let user pick

Keep discovery conversational. If the user gives a clear brief ("10-slide pitch deck about our Q3 results"), skip redundant questions.

## Phase 2 — Style Discovery

Read the style guide for available themes:

```bash
read_file /workspace/skills/presentations/style-guide.md
```

Generate 1–2 sample title slides as **inline shtml cards** showing different themes. Each card should be a small preview (single slide, not a full deck). Let the user pick a theme or ask for adjustments before generating the full deck.

## Phase 3 — Create the Presentation

### Scoop workflow

One scoop per presentation. The scoop owns the sprinkle and stays alive for edits.

**Creating:**
```
scoop_scoop("quarterly-review")
feed_scoop("quarterly-review", "You own the sprinkle 'quarterly-review'. Your job:
1. Read style guide: read_file /workspace/skills/presentations/style-guide.md
2. Create the .shtml file at /shared/sprinkles/quarterly-review/quarterly-review.shtml using the template from /workspace/skills/presentations/template.shtml
3. Run: sprinkle open quarterly-review
4. Push initial content: sprinkle send quarterly-review '<slide-data-json>'
5. Stay alive — wait for lick events. Do NOT exit while the sprinkle is open.")
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
    {"type": "title", "title": "...", "subtitle": "...", "background": "#hex"},
    {"type": "content", "title": "...", "bullets": ["..."], "notes": "speaker notes"},
    {"type": "code", "title": "...", "code": "...", "language": "js"},
    {"type": "quote", "text": "...", "attribution": "...", "background": "#hex"},
    {"type": "image", "title": "...", "src": "url-or-description", "alt": "..."}
  ],
  "theme": "midnight-aurora",
  "transition": "slide"
}
```

Send the full slides array on every update — the sprinkle replaces all content on each push.

## Handling Lick Events

The sprinkle emits lick events via `slicc.lick({action, data})`. Handle these:

| Action | Data | Response |
|--------|------|----------|
| `edit-slide` | `{index, instruction}` | Regenerate that slide, push full deck |
| `add-slide` | `{afterIndex, instruction}` | Generate new slide, insert, push full deck |
| `delete-slide` | `{index}` | Remove slide, push full deck |
| `change-theme` | `{theme}` | Update theme in data, push full deck |
| `export-html` | `{}` | Write standalone HTML to VFS, tell user the path |

**Modifying via cone:**
```
feed_scoop("quarterly-review", "Lick event on YOUR sprinkle: Action: 'edit-slide', data: {index: 2, instruction: 'Make it more concise'}. Update slide 2 and push the full deck.")
```

## Content Density Limits

Each slide type has strict content limits. Overfull slides look terrible at any viewport size.

| Slide Type | Max Content |
|-----------|-------------|
| **Title** | 1 heading + 1 subtitle |
| **Content** | 1 heading + 4–6 bullets OR 2 short paragraphs |
| **Code** | 1 heading + 8–10 lines of code |
| **Quote** | 1 quote (max 3 lines) + attribution |
| **Image** | 1 heading + 1 image |

If content exceeds these limits, split into multiple slides.

## Design Principles

- **No generic AI aesthetics** — avoid safe, bland palettes and default fonts
- **Distinctive typography** — not Inter, not Arial, not system fonts. Use bold typographic choices via Google Fonts or CDN
- **Bold color choices** — dark backgrounds with vibrant accents, or striking monochrome. Never default blue-on-white
- **Purposeful animations** — fragments and transitions should serve the narrative, not decorate
- **Viewport fitting** — reveal.js handles this, but keep content sparse enough that it looks good at any size


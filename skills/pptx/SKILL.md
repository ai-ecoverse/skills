---
name: pptx
description: Generates, reads, and edits PowerPoint files (.pptx). Handles full presentations with text, images, themes, and precise slide positioning. Use when the user asks to create, build, or generate a PowerPoint presentation, slide deck, or .pptx file; when they want to read, extract text from, or inspect an existing .pptx; when they need to edit, update, replace text in, or add slides to a PowerPoint file; or when they mention slides, ppt, slide deck export, or pptx output. Does not generate speaker notes or custom slide layouts.
allowed-tools: bash
trigger-phrases:
  - create a pptx
  - generate pptx file
  - make powerpoint file
  - export to pptx
  - read pptx
  - edit pptx
  - extract text from pptx
  - add slide to pptx
  - pptx with images
---

# PPTX Skill

> **Note**: This skill generates `.pptx` files. For content strategy and presentation structure guidance, see the `presentations` skill.

Four operations: **Create**, **Images**, **Read**, **Edit**. No dependencies on other skills.

All generation is driven by `pptx-lib.jsh`, inlined via shell expansion:
`node -e "$(cat /workspace/skills/pptx/scripts/pptx-lib.jsh) ...your code..."`. Positions and
sizes are in **inches** (a 16:9 slide is `13.33 x 7.5`). See
[`references/api-reference.md`](references/api-reference.md) for the full function and theme-color
reference.

---

## Create a presentation

Core functions (full signatures in [`references/api-reference.md`](references/api-reference.md)):

- `slideXml(bgColor, shapes)` — a slide with a background color and shape content
- `textBox(x, y, w, h, paragraphs, opts)` — text box at a position
- `rectShape(x, y, w, h, fill, opts)` — rectangle
- `para(runs, opts)` / `multiPara(texts, opts)` — paragraph(s)
- `textRun(text, opts)` — styled text segment

Colors come from the random per-deck theme `T` (e.g. `T.dark`, `T.accentBar`, `T.textMutedDark`)
with a light palette under `T.light.*`. Use **dark text on light backgrounds**. Full palette in
[`references/api-reference.md`](references/api-reference.md#theme-colors).

### Basic example (text only)

```bash
node -e "$(cat /workspace/skills/pptx/scripts/pptx-lib.jsh)
var slides = [];

// Dark title slide
slides.push(slideXml(T.dark, [
  rectShape(0, 0, 13.33, 0.06, T.accentBar),
  textBox(1, 2.2, 11, 1.0, para(textRun('My Title', {size:4000, color:'FFFFFF', bold:true}), {align:'center'})),
  textBox(1, 3.5, 11, 0.5, para(textRun('Subtitle', {size:1600, color:T.textMutedDark}), {align:'center'})),
].join('')));

// Light content slide (note: dark text on light background)
slides.push(slideXml(T.light.bg, [
  rectShape(0, 0, 13.33, 0.06, T.accentBar),
  textBox(0.8, 0.7, 11, 0.6, para(textRun('Slide Title', {size:2200, color:T.light.text, bold:true}))),
  textBox(0.8, 1.6, 11, 4.5, multiPara(['Point one', 'Point two'], {size:1200, color:T.light.textMuted, lnSpc:150000})),
].join('')));

var zipData = assemblePptx(slides, {title: 'My Presentation'});
await writePptx(zipData, '/mnt/my-presentation.pptx');
await exec('open --download /mnt/my-presentation.pptx');
"
```

### Verify the output

Creation writes a ZIP/XML file directly, so confirm it is a valid PPTX before delivering it. Read
it back with the read script (see [`references/reading-pptx.md`](references/reading-pptx.md)) and
check that the reported slide count equals the number of slides you pushed and that the expected
titles appear:

```bash
python3 /tmp/read_pptx.py /mnt/my-presentation.pptx   # expect "Total: N slides"
```

If the count is wrong, a slide is empty, or the read raises `BadZipFile`, regenerate before
handing the file to the user.

---

## Add images to slides

Two approaches — `imageSlideXml()` for dramatic full-slide visuals, `picShape()` (with
`slideWithImagesXml`) for positioned images. Download images with `fetchImageB64()` (avoids VFS
binary corruption); it validates magic bytes and returns `null` on failure, so check the result and
fall back to a placeholder `rectShape`. Only PNG and JPEG are supported.

Full workflows — fetching/decoding, positioned images, and full-bleed backgrounds, each with a
complete runnable example — are in [`references/images.md`](references/images.md). Verify
image decks the same way as created decks (read back, check slide count).

---

## Read an existing .pptx

Extract all slide text with the read script in
[`references/reading-pptx.md`](references/reading-pptx.md):

```bash
python3 /tmp/read_pptx.py /mnt/file.pptx
```

It prints one line of text per slide plus a `Total: N slides` line — the same script used to
validate created and edited decks.

---

## Edit an existing .pptx

> **Important**: edit operations manipulate ZIP/XML internals directly. Always verify the output by
> reading it back (slide count, key text) before delivering it.

Two operations, with full scripts and per-operation verify steps in
[`references/editing-pptx.md`](references/editing-pptx.md):

- **Replace text** — `edit_pptx.py <in> <out> "Old" "New"`, then read back to confirm the change.
- **Add a text slide** — `add_slide.py <in> <out> "Title" "Body"`, then confirm the slide count
  increased by one and the new title appears.

---

## Downloading the result

Use `writePptx()` to write the file, then `open --download` to deliver it. Write to `/mnt/` paths —
binary output to `/tmp/` is not reliable.

```javascript
await writePptx(zipData, '/mnt/my-deck.pptx');
await exec('open --download /mnt/my-deck.pptx');
```

`writePptx` handles the base64 encode/decode internally — no manual `toB64Safe` or shell piping
needed.

---
name: pptx2pdf
description: |
  Convert PPTX files to PDF, preserving slide backgrounds, text styles, colors,
  alignment, word-wrap, and embedded PNG/JPEG images. No external tools required —
  uses pdf-lib via esm.sh and the pre-loaded JSZip.
  Use when the user asks to convert a presentation to PDF, export slides as PDF,
  or download a PPTX as PDF. Triggers on phrases like "convert ppt to pdf",
  "export presentation as pdf", "turn this pptx into a pdf", "save slides as pdf".
---

# pptx2pdf

Convert a PPTX file to a PDF using `pdf-lib` (via esm.sh) and the pre-loaded `JSZip` — no external tools or packages required. Preserves slide backgrounds, text styling (bold, italic, color, alignment, word-wrap), and embedded PNG/JPEG images. Slide order and dimensions (960×540pt widescreen) are maintained. Unsupported: charts, SmartArt, grouped shapes, gradients, custom fonts (mapped to Helvetica).

## Usage

Load the library via `new Function` — required to correctly scope the loaded code:

```js
var libCode = await fs.readFile('/workspace/skills/pptx2pdf/scripts/pptx2pdf-lib.jsh');
var pptx2pdf = await (new Function(
  'fs','exec','require','btoa','atob','console',
  'Uint8Array','Array','Object','String','parseInt','Math','Promise','fetch',
  libCode + '\nreturn { convertPptxToPdf };'
))(fs, exec, require, btoa, atob, console, Uint8Array, Array, Object, String, parseInt, Math, Promise, fetch);

await pptx2pdf.convertPptxToPdf('/mnt/deck.pptx', '/shared/deck.pdf');
open('/shared/deck.pdf', '--download');
```

### Verifying output

After conversion, confirm the output file exists and is non-trivially sized:

```js
var stat = await fs.stat('/shared/deck.pdf');
if (!stat || stat.size < 1024) {
  console.error('PDF may be empty or conversion failed — check that the input path is correct and the file is a valid PPTX.');
}
```

Common failure modes: invalid or password-protected PPTX, unreadable input path, or write permission issues on the output path.

## Notes

### Paths

- Input path: any readable path (`/mnt/`, `/shared/`, `/workspace/`)
- Output path: use `/shared/` — reliable for binary writes from scoops

### Text encoding

- Unicode symbols outside WinAnsi (e.g. ▶ ● ✓) are substituted with ASCII equivalents
- HTML entities in text (`&amp;`, `&quot;`, `&#x2026;`) are decoded automatically

### Debugging edge cases

For unexpected rendering, missing images, or unsupported shape types, inspect `/workspace/skills/pptx2pdf/scripts/pptx2pdf-lib.jsh` directly to understand how individual slide elements are parsed and rendered. This file is the single source of truth for all conversion logic.
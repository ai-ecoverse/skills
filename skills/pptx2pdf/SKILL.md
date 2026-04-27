# pptx2pdf

Convert a PPTX file to a PDF, preserving slide backgrounds, text, font styles, colors, alignment, word-wrap, and embedded PNG/JPEG images. No external tools or packages required — uses `pdf-lib` (via esm.sh) and the pre-loaded `JSZip`.

## Triggers

Use this skill when the user says things like:
- "convert ppt to pdf"
- "convert pptx to pdf"
- "export presentation as pdf"
- "turn this pptx into a pdf"
- "save slides as pdf"
- "make a pdf from my presentation"
- "download as pdf"
- "export ppt as pdf"

## What it preserves

- Slide backgrounds (solid color from slide, layout, or master)
- Text content, font size, bold, italic, color, alignment (left/center/right)
- Word-wrapped text — long text reflows to fit its box, no ellipsis truncation
- Embedded PNG and JPEG images at correct position and size
- Slide order and dimensions (960×540pt widescreen)

## What it skips

Charts, SmartArt, grouped shapes, custom fonts (mapped to Helvetica), gradients, and shadows.

## Usage

Load the library via `new Function` — required because `eval()` in SLICC's strict-mode async context does not hoist `var` declarations to the caller's scope.

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

## Notes

- Input path: any readable path (`/mnt/`, `/shared/`, `/workspace/`)
- Output path: use `/shared/` — reliable for binary writes from scoops
- Unicode symbols outside WinAnsi (e.g. ▶ ● ✓) are substituted with ASCII equivalents
- HTML entities in text (`&amp;`, `&quot;`, `&#x2026;`) are decoded automatically

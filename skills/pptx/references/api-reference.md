# PPTX API Reference

Complete function reference for `pptx-lib.jsh`. Inline the library first, then call any of
these functions:

```bash
node -e "$(cat /workspace/skills/pptx/scripts/pptx-lib.jsh)
// ...your slide code...
"
```

All positions and sizes are in **inches**. A standard 16:9 slide is `13.33 x 7.5` inches.

## Theme colors

Each presentation gets a random color theme, exposed as the global `T`.

Dark-slide colors (`T.xxx`):

| Token | Purpose |
| --- | --- |
| `T.dark`, `T.dark2` | Dark slide backgrounds |
| `T.accentBar`, `T.highlightBar` | Accent / highlight bar fills |
| `T.textLight`, `T.textMutedDark` | Text on dark backgrounds |
| `T.cardBg`, `T.cardBorder` | Cards on dark backgrounds |
| `T.good`, `T.poor`, `T.warning`, `T.neutral`, `T.purple` | Semantic colors |

Light-slide colors (`T.light.xxx`) — remember to use **dark text** on light backgrounds:

| Token | Purpose |
| --- | --- |
| `T.light.bg`, `T.light.bg2` | Light backgrounds |
| `T.light.text`, `T.light.textMuted`, `T.light.textDim` | Dark text for light backgrounds |
| `T.light.card`, `T.light.cardBorder` | Cards on light backgrounds |

## Slide creation

- `slideXml(bgColor, shapes)` — standard slide with a solid background color
- `slideWithImagesXml(bgColor, shapes)` — slide that can contain `picShape()` elements
- `imageSlideXml(caption)` — full-bleed background image slide

`shapes` is an array of shape strings joined with `.join('')`.

## Shapes

- `textBox(x, y, w, h, paragraphs, opts)` — text container
  - `opts`: `{fill, border, va}` (`va`: `'t'` | `'m'` | `'b'` for vertical align)
- `rectShape(x, y, w, h, fill, opts)` — rectangle
  - `opts`: `{rr, border}` (`rr: true` for rounded corners)
- `picShape(x, y, w, h, rId)` — positioned image (use with `slideWithImagesXml`)

## Text

- `textRun(text, opts)` — styled text segment
  - `opts`: `{size, color, bold, italic, font}` (`size` in hundredths of a point, e.g. `4000` = 40pt)
- `para(runs, opts)` — paragraph wrapper
  - `opts`: `{align, lnSpc}` (`align`: `'left'` | `'center'` | `'right'`; `lnSpc` in thousandths, e.g. `150000` = 1.5x)
- `multiPara(texts, opts)` — multiple paragraphs from a string array

## Assembly

- `assemblePptx(slideXmls, meta)` — build a PPTX without images
- `assemblePptxWithImages(slideXmls, images, meta)` — build a PPTX with embedded images
  - `images`: `[{slideIndex, mediaIndex, bytes, ext}]` (`slideIndex` is 1-based; `ext` is `'png'` or `'jpeg'`)
- `toB64Safe(bytes)` — convert a `Uint8Array` to a base64 string

## Utilities

- `writePptx(zipData, path)` — write the assembled PPTX to disk (handles base64 internally)
- `fetchImageB64(url, outPath)` — download an image and save it as base64 (returns `null` on failure)
- `emu(inches)` — convert inches to EMUs (914400 per inch)
- `escXml(str)` — escape XML special characters

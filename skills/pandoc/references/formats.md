# Supported formats (pandoc-wasm)

Pandoc-wasm exposes the same reader/writer names as desktop Pandoc. Common pairs:

| From | To | Command |
|------|-----|---------|
| markdown | html | `pandoc convert -f markdown -t html doc.md` |
| markdown | typst | `pandoc convert -f markdown -t typst doc.md` |
| markdown | pdf | `pandoc pdf doc.md` or `pandoc convert -f markdown -t pdf doc.md` |
| docx | markdown | `pandoc convert -f docx -t markdown doc.docx` |
| html | markdown | `pandoc convert -f html -t markdown page.html` |

PDF output is **not** produced by pandoc-wasm directly. The skill routes
`to: pdf` through typst-wasm after a markdown→typst (or direct typst) step,
then **rasterises**: typst-wasm PNG pages → one Flate DeviceRGB image per page
in a PDF 1.3. typst-wasm's native `compile({ format: 'pdf' })` embeds CID CFF
that extract as text but paint as tofu (`pdftoppm`, DocuSign) — do not ship it.

Libertinus (the default `@typst-wasm/fonts` serif) has no CJK and no U+2E3A
(Doppelgeviertstrich). Those code points stay boxes until a covering font is
`addFonts`'d.

### Extra fonts (OTF only)

typst-wasm `addFonts` takes TTF/OTF bytes. **WOFF2 packages do not work**
(`@fontsource/*`, Expo Google Fonts, `@fontpkg/*`, `node-source-han-sans-*`).

| Package | Family | Regular OTF | U+2E3A | CJK |
|---------|--------|------------:|:------:|:---:|
| `@typst-wasm/fonts` (default) | Libertinus Serif | 337 kB | no | no |
| `source-serif@4.5.1` | Source Serif 4 | 241 kB | yes | no |
| `source-sans@3.52.0` | Source Sans 3 | 335 kB | yes | no |
| `source-code-pro@2.42.0` | Source Code Pro | 131 kB | no | no |

These three are the official Adobe `adobe-fonts/source-*#release` trees and
include an `OTF/` directory. Desktop typst finds extra fonts via
`TYPST_FONT_PATHS` / `--font-path` (no pandoc flag). The skill does the same:
walk those dirs for `.otf`/`.ttf` and `addFonts` them. No OS font scan.

```bash
ipk add source-serif@4.5.1
TYPST_FONT_PATHS=/workspace/node_modules/source-serif/OTF \
  pandoc pdf report.md -o /shared/report.pdf
```

Do not add the whole 20 MB / 59 MB packages to `pandoc install`. Source Han
(思源) is not on npm as OTF; CJK still needs a GitHub-release Noto / Source Han
file.

Use `pandoc query version` for the embedded Pandoc version string.

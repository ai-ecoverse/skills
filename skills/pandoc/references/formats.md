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
added.

Use `pandoc query version` for the embedded Pandoc version string.

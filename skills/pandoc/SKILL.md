---
name: pandoc
description: >-
  Convert documents and generate PDFs in SLICC using pandoc-wasm and typst-wasm.
  Use when the user wants to convert markdown, docx, html, or other formats;
  render markdown to PDF; run pandoc conversions; compile Typst to PDF; or
  mentions pandoc, typst, document conversion, markdown to html/pdf, or docx to
  markdown. Triggers on "convert this markdown", "make a pdf from markdown",
  "pandoc", "typst compile", "docx to markdown", and similar. Does NOT trigger
  for PowerPoint (.pptx) generation (use pptx skill) or built-in pdftk merge/split
  (use pdf skill).
allowed-tools: bash
command: pandoc
script: scripts/pandoc.jsh
---

# pandoc — document conversion + PDF (pandoc-wasm + typst-wasm)

Single skill bundling **pandoc-wasm** (format conversion) and **typst-wasm** (PDF
backend). Pandoc-wasm cannot emit PDF directly; `pandoc pdf` and `convert --to pdf`
route markdown (or other inputs) through typst-wasm.

## First-time setup

Runtime WASM packages (~90MB total) are installed on demand:

```bash
pandoc install
# equivalent: ipk add pandoc-wasm@1.1.0 typst-wasm @typst-wasm/fonts
```

## Commands

```
pandoc convert -f <from> -t <to> <input> [-o out]
pandoc pdf <input.md> [-o out.pdf]
pandoc typst compile <input.typ> [-o out.pdf]
pandoc query version [--json]
pandoc install
pandoc --help
```

### convert

Transforms `<input>` with pandoc-wasm. Common pairs: `markdown→html`,
`markdown→typst`, `docx→markdown`. When `-t pdf`, the skill converts to typst
then compiles with typst-wasm.

```bash
pandoc convert -f markdown -t html README.md -o README.html
pandoc convert -f markdown -t typst doc.md -o doc.typ
pandoc convert -f docx -t markdown report.docx -o report.md
pandoc convert -f markdown -t pdf notes.md -o /shared/notes.pdf
```

### pdf

Shortcut: markdown → typst (pandoc) → PDF (typst). Default output is
`<input>.pdf`.

```bash
pandoc pdf report.md -o /shared/report.pdf
```

### typst compile

Compile a `.typ` file directly with typst-wasm (no pandoc step).

```bash
pandoc typst compile paper.typ -o /shared/paper.pdf
```

### query version

```bash
pandoc query version
```

## Notes

- **Never `require('pandoc-wasm')`** at runtime — use the skill's prebuilt
  `scripts/pandoc-core.cjs` plus `fs.readFileBinary` on `pandoc.wasm`.
- **Keep the runner on the promise.** `.jsh` bodies are an `AsyncFunction`.
  `await main()` is correct *if* the file never hits the CJS transpiler;
  `await` at top level currently dies with `Top-level await is currently not
  supported with the "cjs" output format` (and `typescript@7` has no
  `transpileModule` fallback). `main().catch(...)` without `return`/`await`
  lets the wrapper exit before any I/O. **`return main().catch(...)`** is the
  form that waits and still transpiles.
- **PDF shape:** typst-wasm native `pdf.output` embeds CID CFF that extract as
  text but paint as tofu (`pdftoppm`, DocuSign). The skill compiles PNG pages
  (`compile({ format: 'png', ppi: 144 })`) and wraps each as a Flate DeviceRGB
  image in a PDF 1.3. Do not ship typst-wasm's native PDF.
- **Fonts:** default Libertinus / New CM / DejaVu from `@typst-wasm/fonts` are
  loaded automatically for rasterisation. Libertinus has no U+2E3A
  (Doppelgeviertstrich) and no CJK — those code points paint as boxes.
  **Do not `ipk add @fontsource/…`.** Fontsource (and Expo / `@fontpkg` webfonts)
  ship WOFF2; typst-wasm `addFonts` wants TTF/OTF bytes.
  **Adobe Source on npm does ship OTF** (`adobe-fonts/source-sans#release`,
  `adobe-fonts/source-serif#release`):
  - `ipk add source-serif@4.5.1` — Source Serif 4. Regular OTF 241 kB.
    cmap includes U+2E3A, `é`, `€`. No CJK.
  - `ipk add source-sans@3.52.0` — Source Sans 3. Regular OTF 335 kB. Same
    coverage (U+2E3A yes, CJK no).
  - `ipk add source-code-pro@2.42.0` — Source Code Pro. No U+2E3A.
  Load only the cuts you need (`OTF/SourceSerif4-Regular.otf` plus Bold /
  Italic), not the whole 20–59 MB package. Source Han Sans/Serif is a
  **different family**; there is no `source-han-sans` npm package with OTF.
  CJK still needs a Noto / Source Han OTF from GitHub releases, not npm.
- **GPL:** pandoc-wasm is GPL-2.0-or-later; typst-wasm is MIT. See
  [`references/licensing.md`](references/licensing.md).
- Format matrix: [`references/formats.md`](references/formats.md).

## Maintainers

Rebuild `scripts/pandoc-core.cjs` from `pandoc-wasm/src/core.js` via
`npm run build` in `scripts/`. `pandoc.jsh` is hand-authored from `pandoc.src.js`
(no esbuild bundle of the CLI — only the pandoc core glue is prebuilt).

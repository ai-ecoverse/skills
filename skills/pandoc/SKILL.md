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
  `scripts/pandoc-core.mjs` plus `fs.readFileBinary` on `pandoc.wasm`.
- **PDF shape:** typst-wasm returns `pdf.output` (Uint8Array), not `pdf.pages`.
- **Fonts:** default Libertinus / New CM fonts from `@typst-wasm/fonts` are loaded
  automatically for PDF output.
- **GPL:** pandoc-wasm is GPL-2.0-or-later; typst-wasm is MIT. See
  [`references/licensing.md`](references/licensing.md).
- Format matrix: [`references/formats.md`](references/formats.md).

## Maintainers

Rebuild `scripts/pandoc-core.mjs` from `pandoc-wasm/src/core.js` via
`npm run build` in `scripts/`. `pandoc.jsh` is hand-authored from `pandoc.src.js`
(no esbuild bundle of the CLI — only the pandoc core glue is prebuilt).

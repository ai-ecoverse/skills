---
name: pdf
description: Read, create, merge, split, rotate, and extract text from PDF files. Uses SLICC's built-in pdftk and convert commands. No Python required.
triggers:
  - "extract text from pdf"
  - "extract text from this pdf"
  - "read this pdf"
  - "merge pdfs"
  - "merge these pdfs"
  - "combine pdfs"
  - "split pdf"
  - "split this pdf"
  - "extract pages from pdf"
  - "rotate pdf"
  - "rotate pages"
  - "create a pdf"
  - "make a pdf"
  - "generate a pdf"
  - "pdf page count"
  - "how many pages in this pdf"
  - "pdf metadata"
  - "burst pdf into pages"
---

# PDF Skill

Work with PDF files using SLICC's built-in `pdftk` (backed by `@cantoo/pdf-lib` + `unpdf`) and `convert` (magick-wasm) commands.

## pdftk Syntax

pdftk uses positional syntax: **input file(s) come before the operation.**

```bash
pdftk <input.pdf> <operation> [options]
```

For multi-file operations, assign handle labels first:

```bash
pdftk A=first.pdf B=second.pdf cat A B output merged.pdf
```

## Operations

### Extract text
```js
var r = await exec('pdftk /mnt/file.pdf dump_data_utf8');
console.log(r.stdout);
```

### Extract metadata
```js
var r = await exec('pdftk /mnt/file.pdf dump_data');
console.log(r.stdout);
// Output: NumberOfPages, InfoKey/InfoValue pairs, etc.
```

### Merge PDFs
```js
// Assign handle labels A, B, C — then cat them in order
await exec('pdftk A=/mnt/a.pdf B=/mnt/b.pdf C=/mnt/c.pdf cat A B C output /shared/merged.pdf');
open('/shared/merged.pdf', '--download');
```

### Split — extract specific pages
```js
// Extract pages 2–5
await exec('pdftk /mnt/file.pdf cat 2-5 output /shared/pages2to5.pdf');

// Extract a single page
await exec('pdftk /mnt/file.pdf cat 3 output /shared/page3.pdf');

// Extract from page 4 to the end
await exec('pdftk /mnt/file.pdf cat 4-end output /shared/from4.pdf');
```

### Split — every page into its own file
```js
// Creates /shared/page_01.pdf, /shared/page_02.pdf, etc.
await exec('pdftk /mnt/file.pdf burst output /shared/page_%02d.pdf');
```

### Rotate pages
```js
// Rotate all pages 90° clockwise
await exec('pdftk /mnt/file.pdf rotate 1-end right output /shared/rotated.pdf');

// Rotate a single page (page 3 only)
await exec('pdftk /mnt/file.pdf rotate 3 right output /shared/rotated.pdf');

// Rotate directions: right (90° CW), left (90° CCW), down (180°)
```

### Create a PDF from scratch
Say "create a pdf [title]" — SLICC will run `create-pdf.jsh` directly and download the result.

To generate programmatically, run the script via node:
```js
await exec('node /workspace/skills/pdf/scripts/create-pdf.jsh "My Report Title"');
```

The script produces a 2-page US Letter PDF (612×792pt) with:
- Centered gray header + hairline rule on every page
- 24pt bold Helvetica titles, 13pt body, 72pt margins
- "Page N of M" footer centered at the bottom of every page

### Convert PDF page to image
```js
// Convert page 1 to PNG (0-indexed — page 1 = [0])
await exec('convert /mnt/file.pdf[0] /shared/page1.png');
open('/shared/page1.png', '--view');
```

## Notes

- All output files should go to `/shared/` or `/mnt/` — not `/tmp/`.
- `pdftk cat` page ranges are 1-based. `end` means last page: `3-end`.
- `pdftk burst` zero-pads page numbers — use `%02d` or `%03d` in the output pattern.
- `convert` (ImageMagick) requires a tray runtime; not available in the browser-only float.
- OCR and PDF form filling are not available in the current SLICC environment.
- For PPTX → PDF conversion with font embedding and layout fidelity, use the `pptx2pdf` skill.

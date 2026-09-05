---
name: pdf
description: Read, merge, split, rotate and rasterise PDF files with SLICC's built-in pdftk and pdftoppm, plus `pdf-text` for validated text extraction. Text extraction succeeds on simple fonts and on any PDF carrying a /ToUnicode CMap; for subset CID fonts without one it refuses to return glyph-index mojibake and escalates to poppler on an ssh follower, and it reports a scanned/image-only PDF as having no text layer instead of guessing. No Python required. Use when the user asks to work with PDFs or .pdf files, extract or read text from a PDF, merge, split, rotate or burst documents, check page count or metadata, or convert a PDF page to an image. Not OCR of scanned pages, not PDF form filling, and not PPTX conversion (use the pptx2pdf skill).
allowed-tools: bash
triggers:
  - "extract text from pdf"
  - "extract text from this pdf"
  - "read this pdf"
  - "what does this pdf say"
  - "pdf text came out as garbage"
  - "merge pdfs"
  - "combine pdfs"
  - "split pdf"
  - "extract pages from pdf"
  - "rotate pdf"
  - "pdf page count"
  - "how many pages in this pdf"
  - "pdf metadata"
  - "burst pdf into pages"
  - ".pdf file"
---

# PDF Skill

Work with PDFs using SLICC's built-in `pdftk` (backed by `@cantoo/pdf-lib` + `unpdf`),
`pdftoppm`/`pdftocairo`, and `convert` (magick-wasm).

`pdftotext`, `mutool` and `qpdf` do **not** exist in SLICC, and there is no OCR engine.

## Quick start

```bash
pdf-text /mnt/invoice.pdf [--layout]   # extract text, validated, reports its tier
pdftk /mnt/file.pdf dump_data          # metadata: NumberOfPages, Info keys
pdftk A=/mnt/a.pdf B=/mnt/b.pdf cat A B output /shared/merged.pdf
pdftoppm -r 150 -png /mnt/file.pdf /shared/page   # -> /shared/page-1.png
```

## Extract text

Use `pdf-text`, not `pdftk` directly. It tries three tiers, checks each result for
garbage, and always reports which tier produced the output:

1. `pdftk dump_data_utf8` — SLICC's unpdf extractor; honours `/ToUnicode`
2. own `zlib` inflation of page content streams + `/ToUnicode` CMap decoding
3. offload to an `ssh` exec follower running poppler `pdftotext -layout`

If nothing trustworthy comes out it rasterises for visual inspection, labels the
images as *not text*, and exits **3**.

```bash
pdf-text file.pdf [--layout] [--tier1-only] [--no-ssh] [--json] [--pages N-M]
```

`--layout` preserves columns (tier 2 only) · `--tier1-only` stays local, no ssh or
raster · `--no-ssh` skips the offload · `--json` gives provenance and per-tier
rejection reasons · `--pages N-M` restricts first (1-based, `3-end` works).

Exit codes: **0** text extracted · **3** nothing trustworthy · **1** usage/IO error.

### Why not `pdftk dump_data_utf8` on its own?

It exits 0 and prints plausible output even when it has failed. Given a subset CID
font with no `/ToUnicode` CMap it emits the raw glyph indices:

```
$ pdftk cid-nounicode.pdf dump_data_utf8
$QH7H
$ echo $?
0
```

Those bytes are glyph selectors, not characters. It has **two** silent failure modes
— measured, it exits 0 and emits no metadata in all three cases:

| Page content | stdout | means |
|---|---|---|
| text layer, simple font | correct text | fine |
| CID text, no `/ToUnicode` | mojibake | glyphs unmappable → escalate to poppler |
| raster image only (a scan) | **empty** | **no text layer** → nothing can decode it |

`pdf-text` guards every tier (poppler's output included) and tells the two apart:
unusable bytes get the CID diagnosis, empty output everywhere is reported as a
missing text layer.

## Merge, split, rotate, rasterise

```bash
pdftk A=/mnt/a.pdf B=/mnt/b.pdf cat A B output /shared/merged.pdf
pdftk /shared/merged.pdf dump_data | head -1        # verify the page count
pdftk /mnt/file.pdf cat 4-end output /shared/from4.pdf
pdftk /mnt/file.pdf burst output /shared/page_%02d.pdf     # zero-padded, use %02d
pdftk /mnt/file.pdf rotate 1-end right output /shared/rotated.pdf
pdftoppm -r 150 -png /mnt/file.pdf /shared/page
open --view /shared/page-1.png --size high
```

Positional syntax — **inputs come before the operation**; multi-file ops need handle
labels (`A=`, `B=`). Ranges are 1-based, `end` is the last page, `burst` zero-pads.
Rotations: `right` 90° CW, `left` 90° CCW, `down` 180°. Confirm `NumberOfPages`
from `dump_data` before using a range.

## Troubleshooting

- **Text came out as symbols, boxes or consonant soup** — subset CID font with no
  `/ToUnicode`. `pdf-text` already refuses it; attach an ssh follower with poppler
  (`brew install poppler`) and re-run without `--no-ssh`.
- **`pdf-text` says NO TEXT LAYER** — the page is a raster (a scan). No extractor
  can help; SLICC has no OCR engine. Read the rasterised page images it points at,
  or OCR them elsewhere.
- **`pdf-text` exits 3** — believe it and read the per-tier reasons; `--json` gives
  them machine-readably. It found nothing it could vouch for.
- **`convert` cannot write PDF** — it only rasterises PDF input, and
  `convert x.png x.pdf` silently emits a PNG named `.pdf`. Use `pdftoppm` for
  PDF→image. `convert` also needs magick-wasm
  (`ipk install -g @imagemagick/magick-wasm`) and has no `text:` coder.
- **`create-pdf` currently fails** (`Top-level await … not supported with the "cjs"
  output format`) — `await import(…pdf-lib)` forces the ESM→CJS transpile path.
- Write outputs to `/shared/` or `/mnt/`; `/tmp/` may not exist in a sandbox.

## Reference

- [references/text-extraction.md](references/text-extraction.md) — the escalation
  ladder, why CID fonts defeat local extraction, the garbage guard's thresholds and
  regression results, the chunked-base64 ssh transfer recipe, `.jsh` runtime
  gotchas, and reproducible test fixtures.
- `tests/run-tests.sh` — 58 assertions; runs without installing the skill.
- Form filling and OCR are not available in SLICC.
- For PPTX → PDF with font embedding and layout fidelity, use the `pptx2pdf` skill.

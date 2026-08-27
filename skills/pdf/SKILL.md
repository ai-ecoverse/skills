---
name: pdf
description: Read, merge, split, rotate and rasterise PDF files with SLICC's built-in pdftk and pdftoppm, plus `pdf-text` for validated text extraction. Text extraction succeeds on simple fonts and on any PDF carrying a /ToUnicode CMap; for subset CID fonts without one it refuses to return glyph-index mojibake and escalates to poppler on an ssh follower. No Python required. Use when the user asks to work with PDFs or .pdf files, extract or read text from a PDF, merge, split, rotate or burst documents, check page count or metadata, or convert a PDF page to an image. Not OCR of scanned pages, not PDF form filling, and not PPTX conversion (use the pptx2pdf skill).
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
pdf-text /mnt/invoice.pdf              # extract text, validated, reports its tier
pdf-text /mnt/invoice.pdf --layout     # preserve column layout (tables)
pdftk /mnt/file.pdf dump_data          # metadata: NumberOfPages, Info keys
pdftk A=/mnt/a.pdf B=/mnt/b.pdf cat A B output /shared/merged.pdf
pdftk /mnt/file.pdf cat 2-5 output /shared/pages2to5.pdf
pdftoppm -r 150 -png /mnt/file.pdf /shared/page   # -> /shared/page-1.png
```

`pdftk` uses positional syntax — **input file(s) come before the operation**. For
multi-file operations assign handle labels first (`A=`, `B=`, …). Page ranges are
1-based and `end` means the last page (`4-end`).

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

| Flag | Effect |
|---|---|
| `--layout` | preserve visual columns (tier 2 only) |
| `--tier1-only` | stay local; no ssh, no raster |
| `--no-ssh` | skip the follower offload |
| `--json` | provenance + per-tier rejection reasons |
| `--pages N-M` | restrict to a page range first |

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

Those bytes are glyph selectors, not characters. `pdf-text` detects this — control
character density, vowel-less words, embedded-font-program markers — and escalates
rather than hand back mojibake as data. Tier 2 output is checked by the same guard.

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

Rotation directions: `right` (90° CW), `left` (90° CCW), `down` (180°). Confirm
`NumberOfPages` from `dump_data` before using a range.

## Troubleshooting

- **Text came out as symbols, boxes or consonant soup** — subset CID font with no
  `/ToUnicode`. `pdf-text` already refuses it; attach an ssh follower with poppler
  (`brew install poppler`) and re-run without `--no-ssh`.
- **`pdf-text` exits 3** — believe it and read the per-tier reasons; `--json` gives
  them machine-readably. It found nothing it could vouch for.
- **File not found** — uploaded files live at `/mnt/<filename>`, not `/tmp/`.
- **`convert` unavailable** — needs a tray runtime; prefer `pdftoppm`, which always
  works. This build also lacks `convert`'s `text:` coder and `-crop`/`+repage`.
- **`create-pdf` currently fails** with `Top-level await is currently not supported
  with the "cjs" output format` — its `await import('https://esm.sh/pdf-lib')` forces
  the ESM→CJS transpile path. Tracked separately; PDF creation is unavailable until
  it is rewritten.
- Write outputs to `/shared/` or `/mnt/`; `/tmp/` may not exist in a sandbox.

## Reference

- [references/text-extraction.md](references/text-extraction.md) — the escalation
  ladder, why CID fonts defeat local extraction, the garbage guard's thresholds and
  regression results, the chunked-base64 ssh transfer recipe, `.jsh` runtime
  gotchas, and reproducible test fixtures.
- Form filling and OCR are not available in SLICC.
- For PPTX → PDF with font embedding and layout fidelity, use the `pptx2pdf` skill.

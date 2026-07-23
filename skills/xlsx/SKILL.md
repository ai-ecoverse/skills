---
name: xlsx
description: >-
  Read, edit, and create spreadsheet files (.xlsx, .xls, .csv, .tsv) in the
  SLICC environment via the `xlsx` CLI, which bundles SheetJS. Use when the user
  wants to open, inspect, extract, transform, or generate a spreadsheet —
  including converting between .xlsx and CSV/TSV, pulling values or formulas out
  of a workbook, reading a sheet as JSON, setting a cell, adding a sheet, or
  building a new workbook from tabular data. Trigger whenever a spreadsheet file
  is the primary input or output, even when mentioned only in passing ("the xlsx
  in /workspace"). Do NOT trigger when the deliverable is a Word document, a
  PowerPoint deck, an HTML report, a database, or a Google Sheets API integration.
allowed-tools: bash
---

# xlsx — spreadsheets in SLICC

The `xlsx` CLI reads, edits, and creates `.xlsx` / `.xls` / `.csv` / `.tsv`
files. It bundles [SheetJS](https://sheetjs.com) inside a single self-contained
`xlsx.jsh`, so there is nothing to install at runtime — no `openpyxl`, no
`pandas`, no `unzip`/`zip`/XML surgery.

## Commands

```
xlsx info <file>                              Sheet names, dimensions, format
xlsx read <file> [flags]                      Print a sheet (CSV default / TSV / JSON)
xlsx to-csv <file> [flags]                     Alias for read --csv
xlsx to-json <file> [flags]                    Alias for read --json
xlsx create <out.xlsx> --data <src> [flags]    New workbook from JSON/CSV data
xlsx set-cell <file> <A1> <value> [flags]      Set one cell in place, keep the rest
xlsx add-sheet <file> <name> --data <src>      Append a sheet from JSON/CSV data
```

### read / to-* flags
| Flag | Meaning |
|---|---|
| `--sheet <name\|index>` | Target sheet (name, or 0-based index). Default: first sheet. |
| `--csv` | Output CSV (default). |
| `--tsv` | Output TSV. |
| `--json` | Output JSON — array of row-objects keyed by the header row. |
| `--raw` | With `--json`, emit an array-of-arrays instead of row-objects. |
| `--range <A1:D9>` | Limit output to a cell range. |

### --data source (create / add-sheet)
- `@path.json` — read JSON from a file.
- `@path.csv` / `@path.tsv` — read delimited text from a file.
- `'<json>'` — inline JSON string.

JSON may be an **array-of-arrays** (`[["Name","Value"],["foo",42]]` — first row
is the header) or an **array-of-objects** (`[{"Name":"foo","Value":42}]` — keys
become the header, taken from the union of all objects' keys).

### set-cell flags
| Flag | Meaning |
|---|---|
| `--number` | Coerce the value to a number. |
| `--bool` | Coerce to boolean (`true/1/yes` → true). |
| `--formula` | Treat the value as a formula (a leading `=` is optional). |

Without a coercion flag, `set-cell` auto-detects numbers (a bare numeric string
becomes a number; anything else is text).

## Examples

```bash
xlsx info report.xlsx
xlsx read report.xlsx --sheet Sales --json
xlsx read report.xlsx --range A1:C10 --tsv
xlsx create out.xlsx --data '[["Name","Value"],["foo",42],["bar",100]]'
xlsx create out.xlsx --data @rows.csv --sheet Data
xlsx set-cell report.xlsx B2 99 --number
xlsx set-cell report.xlsx C2 '=SUM(B2:B10)' --formula
xlsx add-sheet report.xlsx Summary --data @summary.json
```

## Notes and gotchas

- **Formulas.** `set-cell --formula` writes the formula plus a placeholder cached
  value (`0`); the spreadsheet app recomputes the real value when it opens the
  file. The placeholder is required because SheetJS's reader silently **drops**
  a formula cell that has no cached value — without it, the formula would be lost
  the next time the file is read and re-written.
- **Editing preserves the rest of the workbook.** `set-cell` / `add-sheet` read
  the whole workbook into memory and write it back, so other sheets, styles, and
  cells are retained. (SheetJS's community build does not preserve every exotic
  feature — e.g. charts, pivot tables, VBA macros — so treat heavily-formatted or
  macro-enabled workbooks with care and verify the result.)
- **CSV/TSV** are handled directly — no XLSX overhead. For simple column math a
  plain `awk -F,` is still fine; use `xlsx` when you need real CSV parsing
  (quoted fields, embedded commas/newlines) or CSV↔XLSX conversion.
- **Output type** is inferred from the output extension: `.xlsx` (default),
  `.xls`, `.csv`, `.tsv`/`.txt`.

## Maintainers: rebuilding the bundle

The shipped entrypoint `scripts/xlsx.jsh` is generated from `scripts/xlsx.src.js`
(the readable source) by bundling SheetJS with esbuild. Installing the skill
never builds — the committed `xlsx.jsh` ships as-is.

```bash
cd skills/xlsx/scripts
npm install        # xlsx (SheetJS) + esbuild, pinned in package.json
npm run build      # regenerates xlsx.jsh from xlsx.src.js
```

CI (`.github/workflows/xlsx-build.yml`) runs the same build, smoke-tests the
result, and warns if the committed bundle is stale.

To rebuild from **within SLICC** (whose `esbuild` CLI wrapper lacks
`--external`/`--platform` — see ai-ecoverse/slicc#1632 — and whose esbuild-wasm
Node build API fails on a missing `tty` — ai-ecoverse/slicc#1631), use the CLI
fallback, which keeps `fs`/`stream` external by default:

```bash
ipk install xlsx && ipk add esbuild-wasm
esbuild xlsx.src.js --bundle --format=cjs --target=node18 --minify --outfile=xlsx.jsh
# then prepend the "GENERATED by build.mjs" banner line
```

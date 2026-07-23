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
  in /workspace"). Also covers Excel Online / OneDrive file operations via the
  `excel` CLI — listing, downloading, uploading, and opening spreadsheets stored
  in Microsoft 365 (OneDrive for Business). Do NOT trigger when the deliverable
  is a Word document, a PowerPoint deck, an HTML report, a database, or a Google
  Sheets API integration.
allowed-tools: bash
---

# xlsx — spreadsheets in SLICC

This skill ships two CLIs:

- **`xlsx`** — read, edit, and create LOCAL spreadsheet files (`.xlsx` / `.xls`
  / `.csv` / `.tsv`) offline. Bundles [SheetJS](https://sheetjs.com) inside a
  single self-contained `xlsx.jsh` (no `openpyxl`, `pandas`, or `zip`/XML
  surgery). Covered below.
- **`excel`** — CRUD for spreadsheets stored in **Excel Online / OneDrive** via
  Microsoft Graph: list, download, upload, delete, search, and open-in-browser.
  See "Excel Online (`excel`)" near the end.

## `xlsx` — local files

The `xlsx` CLI reads, edits, and creates `.xlsx` / `.xls` / `.csv` / `.tsv`
files entirely offline — there is nothing to install at runtime.

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

## Excel Online (`excel`)

The `excel` CLI does basic file CRUD against **Excel Online / OneDrive for
Business** through the Microsoft Graph API. Use it to move spreadsheets between
your local workspace and the cloud, then edit them locally with `xlsx` or open
them for editing in Excel for the Web.

```
excel ls [path]                       List a folder (root if omitted)
excel info <path|id>                  Metadata for a file or folder
excel search <query>                  Search your OneDrive
excel download <path|id> [--out F]    Download a file (default: same name locally)
excel upload <localfile> [remotepath] Upload/replace a file (default: /<basename>)
excel new <remotepath.xlsx> --data S  Build a workbook (via xlsx) and upload it
excel mkdir <path>                    Create a folder
excel rm <path|id>                    Delete a file or folder
excel open <path|id>                  Open the item in the browser (Excel for the Web)
excel whoami                          Signed-in account + token expiry
excel token [--refresh] [--quiet]     Print the Graph access token
```

### Addressing
Targets are drive **paths** (`/Reports/Q3.xlsx`, `Q3.xlsx`) or item **IDs**.
Bare id-looking strings are auto-detected; force id interpretation with `--id`.

### Auth — no admin approval
Graph normally needs an app registration + admin consent. `excel` sidesteps that
by borrowing the delegated token that Microsoft's own first-party "App Home
Pages" client already minted for the signed-in user inside Excel for the Web: on
first use (and after the token's ~1h expiry) it opens a throwaway
`excel.cloud.microsoft` recording tab, lifts the `Authorization: Bearer` header
off the on-load Graph call, caches it to `/tmp/.slicc-excel-token.json`, and
closes the tab. **You must be signed into Microsoft 365 in the browser.** The
token carries `Files.ReadWrite.All`, `Sites.*`, `Calendars.Read`, `User.Read.All`
(enough for all OneDrive file CRUD) — but NO Teams/OnlineMeetings scopes.

Override auto-capture with `--token <jwt>` or the `EXCEL_GRAPH_TOKEN` env var.

### Examples
```bash
excel ls /Reports
excel download /Reports/Q3.xlsx --out ./q3.xlsx   # then: xlsx read ./q3.xlsx
xlsx set-cell ./q3.xlsx B2 99 --number
xlsx read ./q3.xlsx --range A1:B5                  # verify the edit before uploading
excel upload ./q3.xlsx /Reports/Q3.xlsx           # replace in place
excel new /Reports/new.xlsx --data '[["Name","Value"],["foo",42]]'
excel open /Reports/Q3.xlsx                       # edit in Excel for the Web
```

### Notes and gotchas
- **Uploads go through `curl`.** The jsh proxied `fetch` cannot send a raw binary
  request body (it stringifies every body type — a `Blob` uploads as the literal
  13-byte string `[object Blob]`), so `excel upload` PUTs bytes with `curl`, which
  is byte-faithful. Downloads use `fetch`+`arrayBuffer` (faithful for responses).
- **Simple PUT to `/content` handles files up to 250 MiB** — no upload-session
  chunking is needed for real spreadsheets.
- **OneDrive re-processes Office files on ingest** (an uploaded `.xlsx` may come
  back a few hundred bytes larger with added SharePoint metadata) but the file
  stays valid and round-trips cleanly through `xlsx`.
- **`resourceLocked` on delete/overwrite** means the file is currently open in
  Excel for the Web — close that tab first.
- **Search is eventually-consistent** — a freshly created/deleted file may lag in
  `excel search` for a minute; `excel ls` / `excel info` are real-time.

## Maintainers

Build/rebuild instructions for the bundled `xlsx.jsh`, and notes on the
hand-written `excel.jsh`, live in the skill folder's `README.md`.

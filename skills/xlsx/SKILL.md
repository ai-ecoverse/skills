---
name: xlsx
description: >-
  Read, edit, and create spreadsheet files (.xlsx, .csv, .tsv) in the SLICC
  environment without `openpyxl`, `exceljs`, or `pandas`. Use when the user
  wants to open, inspect, extract, transform, or generate a spreadsheet —
  including converting between .xlsx and CSV/TSV, pulling values or formulas
  out of a workbook, adding rows or columns, or building a new sheet from
  other tabular data. Trigger whenever a spreadsheet file is the primary
  input or output, even when the user only mentions it in passing ("the xlsx
  in /workspace"). Do NOT trigger when the deliverable is a Word document,
  HTML report, database, or Google Sheets API integration.
allowed-tools: bash
---

# xlsx — spreadsheets in the SLICC environment

SLICC has no `openpyxl`, no `exceljs`, and no `pandas`. Use the tools that
are available: `unzip` / `zip` to open and repack `.xlsx` archives, `node -e`
or `python3 -c` to parse and rewrite the XML inside, and plain shell (`awk`,
`cut`, `sort`) or `python3` for CSV/TSV.

An `.xlsx` file is a ZIP archive of XML documents. Editing one is always the
same three steps: **unzip → mutate XML → zip**. There is no library shortcut
here; treat the format as data, not as a black box.

## Formats at a glance

| Task | Approach |
|---|---|
| Read a `.csv` / `.tsv` | `awk -F,`, `cut -d,`, or `python3 -c "import csv; ..."` |
| Write a `.csv` / `.tsv` | Write text directly, or `python3 -c "import csv; ..."` |
| Convert `.xlsx` → CSV | `unzip` + parse `xl/worksheets/sheet1.xml` + resolve `xl/sharedStrings.xml`, then emit CSV |
| Convert CSV → `.xlsx` | Generate the minimal XML file set below, then `zip` them |
| Read cell values from `.xlsx` | Same as convert-to-CSV — walk `<row>` / `<c>` elements |
| Edit cells in an existing `.xlsx` | `unzip` in place → rewrite `xl/worksheets/sheetN.xml` → `zip` the archive back |
| Preserve formulas / formatting | Rewrite only the cells you touch; leave every other file in the archive byte-for-byte |

## Reading an `.xlsx`

```bash
# Unpack into a working directory
mkdir -p /tmp/xlsx-work && cd /tmp/xlsx-work
unzip -o /workspace/input.xlsx > /dev/null
ls xl/worksheets/         # sheet1.xml, sheet2.xml, ...
cat xl/workbook.xml       # sheet names and their sheetId → rId mapping
[ -f xl/sharedStrings.xml ] && echo "uses sharedStrings" || echo "inline strings only"
```

Every cell in `xl/worksheets/sheet*.xml` looks like one of:

- **Inline string** — `<c r="A1" t="inlineStr"><is><t>Name</t></is></c>`
- **Shared string** — `<c r="A1" t="s"><v>0</v></c>` where `0` is a 0-based
  index into `<si><t>...</t></si>` inside `xl/sharedStrings.xml`.
- **Number** — `<c r="B1" t="n"><v>42</v></c>` (the `t="n"` may be omitted).
- **Formula** — `<c r="C1"><f>SUM(B1:B10)</f><v>55</v></c>`. The `<v>` is a
  cached result and may be missing on a file that was never opened by a
  spreadsheet app; do NOT trust it as authoritative.
- **Boolean / error** — `t="b"` (`0`/`1`) or `t="e"` (`#REF!`, `#NAME?`, …).

Parse the XML with `node -e` (built-in DOMParser is not available; use a
regex over the flat structure above, or `python3 -c "import xml.etree.ElementTree as ET; ..."`).
Example — dump the first sheet as CSV using Python's stdlib only:

```bash
python3 - <<'PY'
import csv, sys, xml.etree.ElementTree as ET, zipfile
NS = {"s": "http://schemas.openxmlformats.org/spreadsheetml/2006/main"}
with zipfile.ZipFile("/workspace/input.xlsx") as z:
    shared = []
    if "xl/sharedStrings.xml" in z.namelist():
        for si in ET.fromstring(z.read("xl/sharedStrings.xml")).findall("s:si", NS):
            shared.append("".join(t.text or "" for t in si.iter(f"{{{NS['s']}}}t")))
    root = ET.fromstring(z.read("xl/worksheets/sheet1.xml"))
w = csv.writer(sys.stdout)
for row in root.findall(".//s:row", NS):
    out = []
    for c in row.findall("s:c", NS):
        t = c.get("t", "n")
        if t == "s":
            out.append(shared[int(c.findtext("s:v", "0", NS))])
        elif t == "inlineStr":
            out.append("".join(x.text or "" for x in c.iter(f"{{{NS['s']}}}t")))
        else:
            out.append(c.findtext("s:v", "", NS) or c.findtext("s:f", "", NS))
    w.writerow(out)
PY
```

## Editing an existing `.xlsx`

Change one cell, keep everything else identical:

```bash
mkdir -p /tmp/xlsx-work && cd /tmp/xlsx-work
unzip -o /workspace/input.xlsx > /dev/null

# Edit xl/worksheets/sheet1.xml (or the target sheet) in place — a targeted
# sed/node/python rewrite is enough for a single cell.
python3 - <<'PY'
import re, pathlib
p = pathlib.Path("xl/worksheets/sheet1.xml")
xml = p.read_text()
# Replace the value of B2 (assumes t="n" or missing t).
xml = re.sub(r'(<c r="B2"[^>]*>)<v>[^<]*</v>', r'\1<v>99</v>', xml, count=1)
p.write_text(xml)
PY

# Repack. Use -X to strip extra metadata so the archive round-trips cleanly.
cd /tmp/xlsx-work && zip -rX /workspace/output.xlsx . > /dev/null
```

**Never** re-zip from a parent directory (`zip output.xlsx /tmp/xlsx-work/`) —
the archive entries must be at the archive root (`xl/...`, `_rels/...`,
`[Content_Types].xml`), not nested under a folder name. Excel will refuse to
open the file.

If a cell uses a shared string you want to change, either edit
`xl/sharedStrings.xml` (safe when no other cell references the same index)
or convert the cell to an inline string (`t="inlineStr"` with `<is><t>…</t></is>`)
and drop the `<v>` element.

## Creating a new `.xlsx` from scratch

The minimum file set Excel and LibreOffice will open:

```
[Content_Types].xml
_rels/.rels
xl/workbook.xml
xl/_rels/workbook.xml.rels
xl/worksheets/sheet1.xml
```

Generate all five with `node -e` or `python3 -c` and zip them:

```bash
mkdir -p /tmp/new-xlsx/{_rels,xl/_rels,xl/worksheets} && cd /tmp/new-xlsx

cat > '[Content_Types].xml' <<'XML'
<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
  <Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>
</Types>
XML

cat > _rels/.rels <<'XML'
<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
</Relationships>
XML

cat > xl/workbook.xml <<'XML'
<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"
          xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <sheets><sheet name="Sheet1" sheetId="1" r:id="rId1"/></sheets>
</workbook>
XML

cat > xl/_rels/workbook.xml.rels <<'XML'
<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>
</Relationships>
XML

# Emit the row XML from your data — inlineStr keeps this self-contained
# (no sharedStrings.xml needed).
python3 - <<'PY' > xl/worksheets/sheet1.xml
rows = [["Name", "Value"], ["foo", 42], ["bar", 100]]
NS = 'xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"'
def col(i):
    s = ""
    while True:
        s = chr(65 + i % 26) + s
        i = i // 26 - 1
        if i < 0: return s
def cell(r, ci, v):
    ref = f'{col(ci)}{r}'
    if isinstance(v, (int, float)):
        return f'<c r="{ref}" t="n"><v>{v}</v></c>'
    return f'<c r="{ref}" t="inlineStr"><is><t>{v}</t></is></c>'
body = "".join(
    f'<row r="{r}">' + "".join(cell(r, ci, v) for ci, v in enumerate(row)) + "</row>"
    for r, row in enumerate(rows, start=1)
)
print(f'<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet {NS}><sheetData>{body}</sheetData></worksheet>')
PY

zip -rX /workspace/output.xlsx . > /dev/null
```

For a formula, emit `<c r="C2"><f>SUM(B2:B3)</f></c>` — omit the `<v>` and
the spreadsheet app will compute the value when the file is opened.

## CSV and TSV

CSV and TSV are plain text — no unzip step, no XML. Prefer shell for simple
work and `python3 -c "import csv; ..."` when the file has quoted fields,
embedded commas, or newlines inside cells.

```bash
# Sum column 3 of a CSV, ignoring the header.
awk -F, 'NR>1 {s+=$3} END {print s}' input.csv

# Convert CSV to TSV (only safe when no field contains a tab or newline).
sed 's/,/\t/g' input.csv > output.tsv

# Robust CSV → TSV that handles quoted fields correctly.
python3 -c "import csv,sys
r=csv.reader(open('input.csv'))
w=csv.writer(sys.stdout, delimiter='\t')
for row in r: w.writerow(row)" > output.tsv
```

## Common pitfalls

- **XML entities** — escape `&`, `<`, `>`, `"` in any string you write into a
  cell, or the file will be corrupt. `&amp; &lt; &gt; &quot;` — nothing else.
- **Sheet ordering** — `xl/workbook.xml` defines the tab order and names;
  `xl/worksheets/sheet1.xml`, `sheet2.xml`, … are the physical files. The
  `<sheet r:id="rIdN"/>` attribute joins the two through
  `xl/_rels/workbook.xml.rels`. Renaming a file without updating both is a
  silent break.
- **Cached formula values** — a freshly written file has none. Do not assume
  a `<v>` will appear next to every `<f>` until a spreadsheet app has opened
  and saved the file.
- **Do not re-zip from a parent directory.** The archive members must be at
  the archive root. `cd` into the unpacked directory before `zip -rX`.
- **`.xlsm` macros** live in `xl/vbaProject.bin` — preserve it byte-for-byte
  if you unpack and repack a macro-enabled workbook.

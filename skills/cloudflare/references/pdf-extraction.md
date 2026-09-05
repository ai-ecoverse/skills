# Reading text out of a Cloudflare invoice PDF

The invoice API gives you a total and nothing else. Contract numbers, order
types, service periods and excess-usage caps exist **only inside the PDF**. This
file records which extraction routes work, which produce convincing garbage, and
how to move a PDF to a machine that has poppler.

## Why these PDFs are hard

Cloudflare generates invoices with **[pdf-lib](https://github.com/Hopding/pdf-lib)**
(confirmed: `pdftk <f> dump_data` reports both `Creator` and `Producer` as
`pdf-lib`). Measured font structure of a real invoice:

```
/Subtype /Type0        × 3
/Subtype /CIDFontType2 × 3
/Encoding /Identity-H
/ToUnicode             present
```

`Identity-H` means the text-showing operators contain **2-byte glyph ids, not
characters**. Reading the page content stream gets you numbers that are only
meaningful through the font's `ToUnicode` CMap. An extractor that ignores the
CMap produces plausible-looking bytes that are not the invoice text — which is
far worse than failing, because it looks like data.

## What works, in order

### 1. `pdftk <file> dump_data_utf8` — local, no dependencies

SLICC's bundled `pdftk` has a `dump_data_utf8` operation that **does** resolve
the `ToUnicode` mapping. This is the primary path and needs nothing installed:

```bash
pdftk IN705825.pdf dump_data_utf8
```

```
Invoice
Cloudflare, Inc
…
Invoice#
Date
Terms
…
IN705825
Aug 20, 2026
Net 60
…
Description Order Type Contract # Tax Rate Tax Amount Amount
Cloudflare Enterprise Service Renew IC-140105 0% $0.00 $564,407.28
Subtotal
Tax Total
Total
Amount Due
```

**It does not preserve column layout.** Two consequences, both of which will
corrupt a parser that ignores them:

- **The header emits a block of LABELS followed by a block of VALUES.** An empty
  field simply drops its value — an invoice with no `PO #` yields one fewer
  value than there are labels, so zipping labels to values by index silently
  shifts *every* subsequent field. Match on the **shape of the value**
  (`/\bIN[-\d]*\d{4,}\b/`, `/\bNet\s+\d+\b/`, `/\b[A-Z][a-z]{2} \d{1,2}, \d{4}\b/`)
  instead of on position.
- **Numbers wrap mid-token.** A real invoice emits `$240,300.0` and then `0` on
  the next line. Flatten newlines to spaces and stitch currency amounts back
  together (`/(\$[\d,]+\.\d)\s(\d)(?![\d.])/`) before parsing — and prefer the
  API's `amount` field over the PDF's total whenever both exist.

Line items also wrap. The excess-usage detail arrives as:

```
Total Workers Core per MM Requests
in MM Cap: 83334 MM Rate: 0.04 /MM
Usage: 206061.224 MM - $4909.09
```

so flatten first, then match
`/Total\s+(.+?)\s+Cap:\s*([\d,.]+)\s*(.*?)\s*Rate:\s*([\d.]+)\s*\/?\s*(.*?)\s*Usage:\s*([\d,.]+)\s*(.*?)\s*-\s*\$([\d,]+\.?\d*)/g`.
Cross-check the parse by summing the per-metric costs against the API `amount`;
they matched to the cent on every invoice tested, so a mismatch means a metric
line failed to parse and must be reported, not hidden.

### 2. `pdftotext -layout` on an `ssh` exec follower — fallback

If the local route ever stops working (a pdf-lib upgrade, a different invoice
template), offload to a connected follower that has Homebrew poppler. Verified
with **poppler 26.08.0** on macOS, which extracts the full invoice cleanly and
*with* column layout preserved — strictly better text than `dump_data_utf8`, it
just needs a second machine.

```bash
host                 # exec targets are tagged [ssh]
ssh --list           # → follower-<uuid>
ssh <id> "command -v pdftotext"   # if empty: brew install poppler
```

### 3. Nothing else — fail loudly

If neither route yields text, **say so and stop**. Never emit glyph noise as if
it were line items. `wrangler-ext` names both attempted routes, names the poppler
requirement, and points at `billing pdf <id> --out ./inv.pdf` so a human can read
the file directly.

The detector is a positive test, not an absence-of-error test: the text must be
>120 chars, contain at least two of `Cloudflare` / `Invoice` / `Subtotal`, and be
>90% printable. Exit code 0 from an extractor means nothing here — two of the
routes below exit 0 and produce rubbish.

## Routes that DO NOT work (all measured on a real invoice)

| Route | Result |
|---|---|
| `pdftotext` | **not installed** in SLICC (nor `mutool`, nor `qpdf`) |
| `pdftk <f> output - uncompress` | `pdftk: unknown operation '-'` → **0 bytes** |
| `pdftk <f> output out.pdf uncompress` | `pdftk: no operation specified` — this build has **no `uncompress` at all** |
| `pdftoppm -png` / `pdftocairo` | renders the layout, but **every glyph is a tofu box** — the embedded CID fonts are not mapped, so there is nothing to read without OCR |
| manual zlib inflate + scrape `Tj`/`TJ` operands | 11 streams inflate fine, 1 carries text operators, and **zero** of `Cloudflare` / `Invoice` / `Subtotal` / `IC-…` appear — the operands are Identity-H glyph ids, so this yields font-program noise |
| `/api/…/receipts/<uuid>/pdf` without `?doctype=invoice&isLegacy=false` | 400 code 1196 — you never get a PDF to extract from |

`pdftk` *does* have `dump_data`, `dump_data_utf8`, `cat` and `rotate`. Only
`dump_data_utf8` gets you text.

## Moving a PDF to a follower: chunked base64

A ~95 KB PDF is ~128 KB of base64. Things that **failed**:

- **One `ssh` call with the whole 129 KB payload as an argument** — the argument
  is too large.
- **`split`** — not available.
- **Nested quoting inside `ssh "python3 -c \"…\""`** — the escaping collapses and
  the call times out. If you need a script on the follower, base64 the *script*
  over as a file and execute the file; never inline a quoted program.

What works — append ~25 KB at a time (the base64 alphabet `A-Za-z0-9+/=` is safe
inside single quotes), then decode remotely and **verify the byte count**:

```bash
D=/tmp/wrangler-ext-$$
ssh <id> "mkdir -p $D"
# first chunk truncates, the rest append
ssh <id> "printf '%s' '<chunk-0>'  > $D/f.b64"
ssh <id> "printf '%s' '<chunk-1>' >> $D/f.b64"
# …
ssh <id> "cd $D && { base64 -d f.b64 > f.pdf 2>/dev/null \
                  || base64 -D f.b64 > f.pdf 2>/dev/null \
                  || openssl base64 -d -A -in f.b64 -out f.pdf; } \
          && wc -c < f.pdf && pdftotext -layout f.pdf -"
ssh <id> "rm -rf $D"
```

- macOS `base64` accepts both `-d` and `-D`; GNU takes `-d`. `openssl base64 -d -A`
  is the universal fallback and `-A` is required because the payload is one very
  long line.
- **Always compare the remote `wc -c` against the local byte count** before
  trusting the text. A silently truncated upload still produces *some* output
  from `pdftotext`, and it will be missing exactly the line items you wanted.
- Clean up the remote scratch dir. The command runs on someone's real machine,
  as their user, outside this leader's sudo policy.

## Scratch files

`pdftk` needs a real path, so the PDF must land on disk. `/tmp` is **not
guaranteed to exist inside every SLICC sandbox** — try `$TMPDIR`, then `/tmp`,
then `~/.cache`, then `.`, and treat "nowhere writable" as a failure of the local
route rather than a crash. Never write scratch files under `/workspace`: a
`Write /workspace/**` grant does not confer unlink, so they cannot be cleaned up.

# Text extraction from PDFs in SLICC

Everything below was measured in SLICC 6.96.2, not inferred. Where a claim could
not be reproduced it says so.

## The short version

Run `pdf-text <file.pdf>`. It tries three tiers, validates every result, and tells
you which tier produced the text. If it exits 3, no tier produced text it was
willing to vouch for — believe it, and read the reasons it printed.

```bash
pdf-text invoice.pdf                  # full ladder
pdf-text invoice.pdf --layout         # keep column layout (tier 2)
pdf-text invoice.pdf --tier1-only     # never leave this machine
pdf-text invoice.pdf --json           # provenance + per-tier rejection reasons
pdf-text invoice.pdf --pages 2-3      # restrict first
```

## Which tools actually exist

| Tool | Present in SLICC? |
|---|---|
| `pdftk` (`@cantoo/pdf-lib` + `unpdf`) | yes, `/usr/bin/pdftk` |
| `pdftoppm`, `pdftocairo` | yes, `/usr/bin` |
| `convert` (magick-wasm) | yes, but needs a tray runtime |
| `pdftotext` | **no** |
| `mutool`, `qpdf` | **no** |

Verified with `command -v`. There is no OCR engine either.

## What `dump_data_utf8` really does

SLICC's `pdftk` is **not** the classic Debian `pdftk`. Its own help says:

```
dump_data              Print metadata (page count, title, author, etc.)
dump_data_utf8         Extract text content per page
```

So `dump_data_utf8` genuinely is the text extractor here — that part of this
skill's older documentation was correct, and an earlier claim that it "returns
metadata only" does not reproduce. On a simple PDF it works:

```
$ pdftk simple.pdf dump_data_utf8
INVOICE ACME CORP
Total Due 4242 USD
```

**The real defect is that it fails silently.** Given a subset CID font with no
`/ToUnicode` CMap it prints the raw glyph indices as if they were characters and
still exits 0:

```
$ pdftk cid-nounicode.pdf dump_data_utf8
$QH7H
$ echo $?
0
```

Hexdump of that output — note the interleaved C0 bytes, which is the tell:

```
00000000: 2451 4803 3748 030a                      $QH.7H..
```

A caller that checks only "exit 0 and non-empty stdout" concludes success and
carries mojibake forward as data. That is what cost a real session significant
time while reading Cloudflare invoice PDFs.

### It never returns metadata — measured across all three PDF classes

`dump_data_utf8` was tested on every kind of PDF it can meet. It **always exits 0**
and it **never emits a single metadata marker** (`NumberOfPages`, `InfoKey`,
`InfoValue`):

| Fixture | Page content | rc | stdout | metadata markers |
|---|---|---|---|---|
| `simple-raw.pdf` | `/Type1` text layer | 0 | 86 B of correct text | 0 |
| `cid-nounicode.pdf` | CID text, no `/ToUnicode` | 0 | 7 B of mojibake | 0 |
| `scanned-image-only.pdf` | raster image only | 0 | **0 B (empty)** | 0 |

So there are **two distinct silent failures**, not one, and they need opposite
advice:

- **non-empty but unusable** → the glyphs cannot be mapped to Unicode (CID font
  with no `/ToUnicode`). Escalate to poppler on a follower; the text *is* in the
  file, it just needs a better decoder.
- **empty from every tier** → there is **no text layer at all** (a scan). No
  decoder anywhere will help; the page is pixels. SLICC has no OCR engine.

`pdf-text` distinguishes these and prints the matching diagnosis, so a scanned
PDF is never misreported as a font problem.

## Why tier 1 cannot always win: CID fonts and `/ToUnicode`

A PDF content stream does not store characters. It stores **glyph selectors** for
whatever font is current. For a simple font (`/Type1` + `/WinAnsiEncoding`) the
byte `0x41` means glyph "A", so byte == character and extraction is trivial.

With a **Type0 / `Identity-H`** font — what almost every modern PDF generator
emits, including `pdf-lib` — each glyph is a **2-byte index into the embedded font
subset**. Index `0x0024` is "whatever the 36th glyph of this particular subset
happens to be". Nothing in the content stream says it is `P` or `$` or anything
else. The only bridge back to Unicode is the optional `/ToUnicode` CMap, a stream
of `beginbfchar` / `beginbfrange` mappings hanging off the font dictionary.

Measured, same font, same glyph indices, one fixture with a `/ToUnicode` and one
without:

| Fixture | `/ToUnicode`? | `dump_data_utf8` | `pdf-text` |
|---|---|---|---|
| `cid-tounicode.pdf` | present | `PAIDYID` (correct) | tier 1a, accepted |
| `cid-nounicode.pdf` | absent | `$QH7H` (mojibake) | rejected, escalates |

So the boundary is not "simple vs complex PDF", it is **`/ToUnicode` present vs
absent**. When it is absent the information required to recover text is not in the
file, and no amount of local cleverness will produce it.

## Measured failure modes

Three plausible-looking approaches that do **not** work:

1. **`pdftk … output - uncompress` → nothing.** `uncompress` is not an operation
   in SLICC's pdftk at all; the invocation fails with `unknown operation '-'` and
   writes a 0-byte file. (An earlier note attributed the 0 bytes to the PDF; it is
   simply an unsupported operation.)

2. **Rasterising and reading the glyphs → tofu.** On a real invoice with an
   embedded subset font, `pdftoppm -r 150 -png` renders the layout correctly but
   every glyph is a `□` box, because the subset font cannot be mapped. Visual
   reading fails too. *Not reproduced here:* the synthetic fixture in this repo
   declares a CID font without embedding a font file, so `pdftoppm` substitutes a
   system font and renders the glyph indices as Latin letters instead of tofu. The
   tofu behaviour is reported from the original incident, not re-measured.

3. **Hand-inflating every stream and grepping for `Tj`/`TJ` → font-program
   garbage.** Inflate indiscriminately and you hit the embedded font binary, not
   page content, and get glyph tables plus strings like
   `Copyright 2012 Google Inc`, `NotoSans-BoldItalic`, and SIL Open Font License
   text. This is the most dangerous failure because it is voluminous and looks
   like a successful extraction.

   `pdf-text`'s tier 1b avoids it structurally: it only ever inflates streams
   reachable from a `/Page`'s `/Contents`, so a font program is never a candidate
   for text in the first place.

## The escalation ladder

### Tier 1a — `pdftk dump_data_utf8`
SLICC's built-in unpdf-backed extractor. Handles `FlateDecode` and honours
`/ToUnicode` when present. Tried first because it is fast and local.

### Tier 1b — independent zlib inflation
Own implementation, used when 1a is rejected:

- parse indirect objects, inflate stream bodies with `zlib.inflateSync`, falling
  back to `zlib.inflateRawSync` for streams with a missing/short zlib header;
- resolve each `/Page`'s `/Contents` so only real content streams are read;
- build a per-page font table from `/Resources /Font`, and for each font parse its
  `/ToUnicode` CMap (`beginbfchar` and `beginbfrange`, including ranges);
- walk the content stream tracking `Tf` for the current font, and decode `Tj`,
  `TJ`, `'` and `"` operands through that font's CMap — 2 bytes at a time for
  `Identity-H`, 1 byte otherwise;
- inside `TJ`, a kerning number `<= -100` thousandths of an em is emitted as a
  word space, otherwise words run together (`HelloWorldFixture`);
- count glyph codes that had **no** CMap entry. Any such code means the output is
  guesswork, so tier 1b refuses the result even if it otherwise looks plausible.

### Tier 2 — offload to an `ssh` exec follower
The only thing measured to read a real subset-CID invoice correctly was Homebrew
poppler `pdftotext -layout` (version 26.08.0) on a connected macOS follower.

This is **remote code execution on the user's real machine**, outside this
leader's sudo policy — see `/workspace/skills/ssh/SKILL.md`. Keep the command
narrow. `pdf-text` does exactly four things remotely: `mkdir` a scratch dir,
append base64 chunks, decode + `wc -c`, run `pdftotext`, then `rm -rf` the scratch
dir.

Detection is `ssh --list` (targets also appear in `host` tagged `[ssh]`). If no
target exists, tier 2 reports that and moves on. If a target exists but has no
`pdftotext`, it reports the one-line fix: `brew install poppler` on macOS,
`apt-get install -y poppler-utils` on Debian/Ubuntu.

**Transfer recipe.** base64 the PDF locally, then append it in ~25 KB chunks:

```bash
printf '%s' '<chunk>' >> ~/dir/f.b64          # repeat per chunk
cd ~/dir && (base64 -d -i f.b64 -o f.pdf || base64 --decode f.b64 > f.pdf)
wc -c < f.pdf                                  # compare against the local size
```

macOS `base64` wants `-i`/`-o`; GNU coreutils wants `--decode`; try both. The
byte-count comparison matters — `pdf-text` aborts rather than extract text from a
truncated upload.

Notes on the transfer, measured:

- Chunk the payload in **JS**, not with the `split` command, which failed to write
  output here.
- Deeply nested quoting such as `ssh "python3 -c \"…\""` **timed out**. If you need
  a remote helper script, base64 the script across and execute the file.
- A single `ssh` call carrying the whole 130 KB base64 string as one argument
  **did succeed** on this build, contrary to an earlier report that 129 KB failed.
  Chunking is kept anyway: it is bounded, it works for larger files, and it costs
  a fraction of a second (98 KB / 6 chunks ran in ~0.6 s end to end).

### Tier 3 — rasterise, and say so
`pdftoppm -r 150 -png`. This produces **images, never text**, and `pdf-text`
labels it that way and still exits 3. If the glyphs come out as tofu boxes, the
embedded subset font is unmappable and there is no text to recover without OCR,
which SLICC does not have.

## The garbage guard

The most important part of the tool: a wrong answer that looks like data is worse
than a clean failure. Every tier's output — including poppler's — goes through the
same check, and output is only returned if it passes.

| Signal | Threshold | Catches |
|---|---|---|
| font-program markers | any match | inflating a font instead of page content |
| control-character density | > 2 % | `Identity-H` glyph indices (high byte lands in C0) |
| printable/Latin ratio | < 85 % | binary noise |
| zero alphabetic words | — | digits/punctuation-only output |
| word density (letters in words ÷ bytes) | < 35 % | sparse mojibake |
| vowel share of 3+ letter words | < 50 %, needs ≥ 6 such words | consonant soup from glyph indices |
| empty / whitespace-only | — | silent extraction failure |

Font-program markers are matched case-insensitively: a `Copyright <year>` notice,
`SIL Open Font License` / `Reserved Font Name`, family and tool names
(`NotoSans`, `DejaVu`, `LiberationSans`, `FontForge`), CMap resource names
(`Adobe-Identity-UCS`), raw CMap keywords (`begincmap`, `endbfchar`,
`beginbfrange`, `begincodespacerange`), TrueType table tags (`glyf`, `hmtx`,
`maxp`, `fpgm`, `prep`), and PostScript font headers (`%!PS-AdobeFont`).

The vowel test is what catches mojibake that happens to contain no control
characters, e.g. `Qhk Trz Wgm Bdx Ktp Nvf` — genuine prose has a vowel in nearly
every word of three or more letters.

The guard is deliberately biased toward rejection, but it is checked against
genuine text so it does not cry wolf: invoice-shaped text, prose, German with
umlauts, a short `PAIDYID` token, and a sentence containing the word "copyright"
without a year all pass. Regression results: **17/17** (11 rejections, 6
acceptances, no false positives).

Run the guard's own suite against a JSON array of `{name, text, expectOk}` cases:

```bash
PDF_TEXT_SELFTEST=/path/to/cases.json pdf-text any.pdf
```

It prints per-case results and exits non-zero if any case disagrees with its
expectation.

## Debugging aids

| Env var | Effect |
|---|---|
| `PDF_TEXT_SKIP=1a,1b` | skip tiers, to exercise one in isolation |
| `PDF_TEXT_SSH_BIN=<cmd>` | override the `ssh` binary (stub it in tests) |
| `PDF_TEXT_TMP=<dir>` | scratch directory for page subsets and rasters |
| `PDF_TEXT_SELFTEST=<json>` | run the garbage-guard suite and exit |

## SLICC runtime gotchas hit while building this

- **`path.resolve()` ignores `process.cwd()`** and resolves against `/`, so
  `path.resolve('x.pdf')` yields `/x.pdf`. Use `path.join(process.cwd(), p)`.
- **`process.pid` is `undefined`** in a `.jsh`, so it cannot seed a unique
  filename. Derive a run id from `Date.now()` + a random suffix.
- **`exec()` is not a `.jsh` global.** The `await exec(...)` form in SKILL.md is
  the agent's JS tool context; inside a `.jsh` use `require('child_process')`
  (`spawnSync` / `execSync` both work).
- **Creating a subdirectory for scratch can trip a sandbox write gate.** Write
  scratch files flat into an existing directory with a unique filename prefix.
- **`spawnSync`'s `cwd` option is IGNORED.** A child process always runs in the
  parent's cwd, so `{ cwd: dir }` silently does nothing and relative paths resolve
  against the wrong directory. Pass **absolute paths** to every child process.
- **The shell does not word-split a variable holding a command with arguments.**
  With `V="node /path/x.jsh"`, `$V arg` looks for a command literally named
  `node /path/x.jsh` and fails with 127. Dispatch through a shell function
  (`f(){ node /path/x.jsh "$@"; }`) or `eval`. Env-var prefixes
  (`FOO=bar f args`) do work on functions.
- **`command -v` can report a stale `.jsh`** that has since been deleted; running
  it then fails with 127. Probe by actually executing the tool, not by `command -v`.
- `set -u` plus `${VAR:-}` misfires here (`unbound variable`); guard with
  `[ "$#" -ge 1 ]` and plain assignments instead.
- `node --check` exits 9 and checks nothing. Syntax-check with
  `new Function('async function w(){' + src + '\n}')` — the async wrapper is
  required because `.jsh` uses top-level `await`.

## Running the tests

```bash
bash skills/pdf/tests/run-tests.sh [workdir]
```

The skill does **not** need to be installed: if `pdf-text` is not a registered
command the suite runs the sibling source file with `node` instead. Override the
tool under test with `PDF_TEXT_BIN`.

It builds the fixtures, asserts behaviour and exits non-zero on any failure. Tier 2
assertions are skipped automatically when no `[ssh]` follower is attached. Measured
on SLICC 6.96.2 with a macOS follower present: **58 assertions, 0 failures.**

## Reproducible fixtures

`tests/make-fixtures.jsh` builds every PDF from raw bytes with `node`, so the
fixtures are deterministic and need no network or font files:

- **`simple-raw.pdf`** — uncompressed content stream, `/Type1` `/Helvetica` with
  `/WinAnsiEncoding`. Tier-1-friendly baseline.
- **`simple-flate.pdf`** — identical content, `/FlateDecode` stream. Exercises
  `zlib.inflateSync`.
- **`cid-tounicode.pdf`** — `/Type0` `/Identity-H` font **with** a `/ToUnicode`
  CMap. Must decode to `PAIDYID`.
- **`cid-nounicode.pdf`** — the same font **without** `/ToUnicode`. Must be
  rejected by every tier.
- **`big.pdf`** — 12 pages, padded to ~98 KB with an unreferenced random-bytes
  object so the base64 payload spans 6 chunks. Exercises the chunked transfer at
  the size of the invoice from the original incident.
- **`scanned-image-only.pdf`** — a page whose only content is a `/DCTDecode`
  image XObject: what a scan looks like. Every extractor must return empty, and
  `pdf-text` must diagnose a missing text layer rather than blaming a CID font.
- **`blank.pdf`** — an empty page, used only as the white canvas the scan fixture
  is rendered from.

Notes on `convert` in SLICC, all measured:

- **It cannot WRITE PDF at all.** `convert x.png x.pdf` silently produces a *PNG*
  with a `.pdf` name (`pdftk` then reports `No PDF header found`). `convert` only
  *rasterises* PDF input. So the scan fixture is assembled by hand as a
  `/DCTDecode` image XObject instead.
- No `text:` coder, and no `-size` / `xc:` canvas generation — hence the white
  canvas comes from `pdftoppm` rendering `blank.pdf`.
- `-annotate` **does** work (bundled Adobe Clean font) and is what draws the text
  into the raster.
- `+repage` is unsupported; `-crop` is accepted.
- `convert` needs magick-wasm: `ipk install -g @imagemagick/magick-wasm@0.0.42`.

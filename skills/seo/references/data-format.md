# Search Console data format and access

Reference detail for the `seo` skill. Read this when a parse breaks, when
`verify` fails, or when porting the approach to another Google property UI.

## Why the official API is not used

The Search Console API (`googleapis.com/webmasters/v3/`) needs an OAuth token,
and both credentialed routes are closed:

- **The Cloud SDK's public desktop client cannot request the scope.** That client
  (`32555940559.apps.googleusercontent.com`) is the one `gcloud` reuses via
  `oauth-token --intercept`. Asking it for `webmasters.readonly` is refused at
  the authorize endpoint, before any consent screen:
  `restricted_client`, "Unregistered scope(s) in the request".
- **Tab cookies do not carry over.** Calling `googleapis.com` from the logged-in
  `search.google.com` tab returns 401: "Expected OAuth 2 access token, login
  cookie or other valid authentication credential".

A properly scoped OAuth client must be minted in a project you control, and
OAuth clients are Console-UI-only — so that is a human step, not an automatable
one. Until it exists, reading the page the browser already renders is the only
route.

Search Console **fires no XHR on load**: the report is inlined into the HTML as
`AF_initDataCallback` blocks. There is therefore no private RPC to replay, which
is why this parses the page rather than a JSON endpoint.

## Data blocks (verified 2026-09-21)

Blocks look like
`AF_initDataCallback({key: 'ds:N', hash: '…', data:[…], sideChannel: {}});`
and their payload is JSON once `\xNN` escapes are decoded. Raw pages for every
variant below are in `../fixtures/`, with the parameters that produced them.

### `ds:9` — totals and the daily series

- Totals at `data[1][1][1]`, as the 4-tuple `[clicks, impressions, ctr, position]`.
  `ctr` is a fraction (0.0702…), not a percentage.
- Daily rows at `data[1][0]`, each `[epochMs, <that same 4-tuple>, …]`.
  Days with no data carry `"NaN"` strings and are read as zero.

### `ds:16` — the active breakdown table

ds:16 holds **whichever breakdown the URL asked for**, not the query table
specifically. The dimension id sits at `data[0][5][0][0]`, and the block also
names its own dimension in the column metadata at `data[1][1][0][9]`
(`"QUERIES"`, `"PAGES"`, ...), which is how the ids below were read off rather
than guessed:

| dimension | id | how to request it |
|---|---|---|
| date | 1 | (ds:9 / ds:12) |
| query | 2 | default — no `breakdown` parameter |
| page | 3 | `&breakdown=page` |
| country | 4 | inlined as ds:11 on every load |
| search appearance | 8 | inlined as ds:13 |

**Check the id before reading rows.** With `breakdown=page` ignored or renamed,
the response is a perfectly well-formed query table at the same key, so a parser
that only reads offsets prints `sliccy` and `slicc ai` in a column headed `Page`.
That is why `parsePageTable` refuses any dimension but 3, and `parseQueryTable`
refuses dimension 3.

The parameter is not optional: the default report's HTML contains **no page URLs
at all** (`grep -c automate-website-migration baseline.raw` → 0), while the
`breakdown=page` response carries all 8 rows. The parameter name came from the
URL the UI wrote when its own Pages tab was clicked, not from guesswork.

Common to both tables:

- Rows at `data[1][0]`; each row's container is at `row[0]`. A filter matching
  nothing makes `data[1][0]` **`null`**, not an empty array.
- `container[1..]` are metric arrays, each **self-describing**: index `[8]` is a
  type id — `5` = clicks, `6` = impressions, `7` = CTR, `8` = position.
  - Counts (5, 6) carry their value at `[1]`.
  - Ratios (7, 8) carry it in a **trailing** slot, at index 44 and 43 in the
    observed data, so the last non-null element is taken.

Row labels differ, and are not interchangeable:

| table | label position | observed label length |
|---|---|---|
| query (dim 2) | `container[0][0]` | 17 |
| page (dim 3) | `container[0][40]` | 41 |

Page rows carry the absolute URL (`https://www.sliccy.com/`), including anchors
(`https://www.sliccy.com/#video`) as separate rows. Their metric arrays are
identical to query rows' — checked, not assumed: 9 long for the counts, 45 and 44
for CTR and position.

Reading by type id rather than column order survives a reordering of the metric
arrays, but not a renumbering of the type ids.

### Filters, and the echo that proves one was applied

A filter is expressed in the URL, and Search Console **echoes back the filters it
applied** in each block header at `data[0][5][3]`, as
`[dimensionId, [values], operator, 0]`. The search-type entry `[6, ["WEB"]]` is
always present.

Both parameter shapes below were taken from the URL the Search Console UI itself
produced when its Pages tab and its query filter were used — the UI does not
change the URL when a table tab is clicked from the default view, but it does
once a filter or breakdown is applied:

| UI choice | URL | echoed operator |
|---|---|---|
| Exact query | `&query=!slicc` | 1 |
| Queries containing | `&query=*slicc` | 2 |

The skill sends the exact form and requires operator 1 on both `ds:16` and
`ds:9`. The reason to check at all: an unrecognised filter parameter is ignored,
the response is HTTP 200 with the **unfiltered** report, and every row looks
valid. Measured by sending the filter as `&qquery=` — the command exits 1 naming
the filters the response reported, instead of printing all 8 pages as if they
belonged to one query.

`ds:9` is filtered too, so with `&query=!slicc` the totals become that query's
own totals (3 clicks / 380 impressions rather than 192 / 2778). A filter matching
nothing returns the totals tuple `[0, 0, "NaN", "NaN"]`, since a CTR and a position
are undefined with zero impressions. That is data rather than a reshape, and is
read as zeros only while both counts are zero.

## Why totals never come from a table

### The query table under-reports

Summing `ds:16` gave 76 clicks / 848 impressions while `ds:9` reported
196 / 2790 for the same period. The table omits **anonymised rare queries**,
which the totals still count. A tool that summed the table and called it "total
clicks" would under-report by 61%.

The remainder is printed as a gap rather than hidden. One caveat: past the
table's row cap the remainder also contains ordinary queries the table never
returned, so above a conservative 1000-row threshold it is labelled
`Unattributed gap` instead of `Anonymised gap`. The real cap is undocumented and
was **not** measured (the property under test returns 78 rows), so treat the
threshold as a guard rather than a fact.

### The page table over-reports

Measured 2026-09-21: 8 page rows summing to 194 clicks / 3569 impressions, while
`ds:9` reported 192 / 2778 for the same period — 28% **more** impressions than
the property earned. So the page table does not account for the property totals
either, and it misses in the opposite direction.

The mechanism is aggregation level, not anonymisation: page rows count per page,
property totals count per search. A single result page listing two of the site's
URLs is one property impression and two page impressions. Supporting measurement
rather than assertion: filtering to the single query `slicc` gives page rows of
380 + 1 = 381 against filtered totals of 380, an excess of exactly the one search
that showed both `/` and `/automate-website-migration`. Anchor URLs
(`/#video`, `/#use-cases`) also appear as their own rows.

`search-console pages` therefore prints the page sum, the totals, and the signed
difference on separate lines, with the over-count and under-count cases worded
differently.

## Three ways the request fails as HTTP 200

None of these produce an error status, which is why each needs an explicit check.

### Wrong account slot

The `/u/N/` segment selects a Google account.

Every row below is the same property, same tab. The no-access page carries the
title `Oops, you don't have access to this property`.

| slot | HTTP | data blocks | page served |
|---|---|---|---|
| `/u/1` | 200 | 20 | the report (`Performance on Search results`) |
| `/u/0` | 200 | 6 | no-access |
| `/u/7` | 200 | 6 | no-access |
| *(none)* | 200 | 6 | no-access |

So the slot must come from the discovered tab, and a hard-coded value only works
on the machine it was written on. Note the last row: a slotless URL fails too, so
falling back to "no slot" is not a safe default — that case is reported with
different advice (reload Search Console so Google adds the slot) than a genuine
account mismatch.

### Localized report

A localized report renames the scorecards (`Klicks insgesamt` for
`Total clicks`), which would break `verify`. The worse problem is that it also
localizes **number format**: with `hl=de`, 2778 renders as `title="2.778"` and
6.9% as `"6,9 %"`. Parsed with English rules `"2.778"` becomes **2.778** — a
wrong number rather than an error. `hl=en` is therefore forced on every request.

### Expired session

A dead session does not 404: the fetch follows the redirect and returns 200 with
a sign-in page, which is far larger than any size threshold would catch.

The obvious marker does not work. The **signed-in** report page contains
`accounts.google.com/signin` in its account-chooser markup, so matching that
string refuses every valid page. Measured, not assumed. `<title>…Sign in…</title>`
is absent from the good page and is usable; the stronger discriminator is whether
any `AF_initDataCallback` blocks are present at all.

## Fragility, and the tripwire

These indices and offsets are positional and undocumented, so a UI release can
reshape them silently — and the failure mode is a **wrong number, not an error**.

`search-console verify` exists for that: it asserts the parsed `ds:9` totals
equal the scorecards the page itself rendered. A missing scorecard counts as a
failure too, because if the reference silently disappeared, a check that skipped
it would start passing everything — the guard would evaporate exactly when the
page changed.

`verify` covers the totals, not the tables. The page table's own tripwires are
the dimension-id check and the filter echo above; both were exercised against the
real endpoint. The page-row label index (40) has no in-band description, so a
reshape there is caught only by the fail-closed rule that page rows without a URL
at that index raise instead of reporting "no pages".

Parsing lives in `../scripts/gsc-parse.js`, free of `sliccy:` and `fs` imports so
the test suite can exercise it; `../scripts/search-console.jsh` holds only tab
discovery, fetching and output.

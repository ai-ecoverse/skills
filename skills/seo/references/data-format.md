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
and their payload is JSON once `\xNN` escapes are decoded.

### `ds:9` — totals and the daily series

- Totals at `data[1][1][1]`, as the 4-tuple `[clicks, impressions, ctr, position]`.
  `ctr` is a fraction (0.0702…), not a percentage.
- Daily rows at `data[1][0]`, each `[epochMs, <that same 4-tuple>, …]`.
  Days with no data carry `"NaN"` strings and are read as zero.

### `ds:16` — the per-query table

- Rows at `data[1][0]`; each row's container is at `row[0]`.
- `container[0][0]` is the query string.
- Remaining entries are metric arrays, each **self-describing**: index `[8]` is a
  type id — `5` = clicks, `6` = impressions, `7` = CTR, `8` = position.
  - Counts (5, 6) carry their value at `[1]`.
  - Ratios (7, 8) carry it in a **trailing** slot, at index 44 and 43 in the
    observed data, so the last non-null element is taken.

Reading by type id rather than column order survives a reordering of the metric
arrays, but not a renumbering of the type ids.

## Why totals never come from the query table

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

Parsing lives in `../scripts/gsc-parse.js`, free of `sliccy:` and `fs` imports so
the test suite can exercise it; `../scripts/search-console.jsh` holds only tab
discovery, fetching and output.

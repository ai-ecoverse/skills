# AEM Source — design doc

Integrates the `aem` skill with the `review` skill: unpublished and
recently-modified AEM pages become review cards, and a card points at a
URL the cone can open for visual review.

## Scope

Site: org `ai-ecoverse`, site `slicc-website`, Helix 6, `https://api.aem.live`.
The approach generalises to any Helix 6 site with the same `--org`/`--site` flags.

## Measured baseline (2026-09-07, ai-ecoverse/slicc-website)

| Metric | Value |
|--------|-------|
| Preview tree | 259 files / 8 API calls |
| Live tree | 228 files / 6 calls |
| Total API calls (both trees) | 14 |
| `x-ratelimit-limit` | 10/s |
| Never-published (all file types) | 31 |
| Never-published (page cards emitted) | 26 |
| Non-page assets excluded by default | 5 (PDFs, JSON) |
| Stale (preview newer than live) | 0 |
| Live-only orphans | 0 |

The `0 stale` result is real: nav/footer were published earlier the same day.
For non-trivial stale testing, build a fixture — do not modify the live site.

## Why tree listings, not per-page status

`GET .../status/{path}` is the natural "is this published?" call, but calling
it once per page would cost 259 API calls against an `x-ratelimit-limit` of 10.
The tree listing endpoints (`GET .../preview/` and `GET .../live/`) cost
O(folders), not O(pages): 14 calls total vs 259, and each file entry already
carries `lastModified`, which is enough for both the never-published and stale
checks.

Reserve the status endpoint for single-card enrichment (`aem-ext review --path`)
where its richer output (`lastModifiedBy`, `sourceLastModified`, `webPath`) adds
real value.

## The pagination trap

Listings return at most 100 children per response. When the folder has more
children, `links.next` is set to an opaque cursor URL; without it the response
is silently truncated. There is no error flag, no count, no hint — just a
plausible-looking partial result. `/man/` alone has exactly 100 + a cursor, so
ignoring pagination gives 136 preview files instead of the true 259.

`aem-ext sweep` logs every `GET` call to stderr, ending with:

```
[aem-ext sweep] preview: 259 files fetched in 8 API calls
[aem-ext sweep] live: 228 files fetched in 6 calls
[aem-ext sweep] raw diff — never-published: 31, stale: 0, live-only orphans: 0 (all file types)
[aem-ext sweep] page cards — never-published: 26, stale: 0 (5 non-page assets excluded; use --include-assets to emit them)
```

If the logged call count drops without the file count dropping, pagination has
regressed.

## Non-page assets

The 31 never-published raw entries include 5 non-page files (a `.pdf` and
`.json` entries). A content-review backlog exists to gate publish decisions on
pages, not binary assets. By default `aem-ext sweep` excludes non-`.md/.html/.docx`
files and logs how many were suppressed. Pass `--include-assets` to emit cards
for every file type.

Pages include: `.md`, `.html`, `.docx` (all content-bus page formats on Helix 6).
Assets include everything else: `.pdf`, `.json`, `.png`, images, fonts, etc.

This is a heuristic. A `sitemap.json` is arguably a page artefact; a
`drafts/probe.pdf` is not. The default excludes both. Override with
`--include-assets` when auditing asset coverage.

## Enumeration-vs-enrichment protocol gap — resolved design

### The gap

The existing review source protocol (`references/SOURCE_PROTOCOL.md`) is a
*per-path enrichment* contract:

```
[cmd] review --path PATH [--id ID]   # one path in → one card out
```

`review ingest` calls each source once per path and attaches findings to an
existing card. This works for `pangram` and `check-llm-cliches`, which analyse
a single document at a time.

Populating a backlog from AEM requires *enumeration*: scanning the entire site
and producing O(N) cards from a single invocation — the opposite shape.

### Decision

**Two separate commands, one per mode.** The protocol gap is real and the two
modes have genuinely different semantics; forcing both into the same
`[cmd] review --path PATH` contract would require either a magic `--path .` glob
(fragile) or a non-standard multi-object stdout (breaks validation).

| Command | Mode | Output | Use with |
|---------|------|--------|----------|
| `aem-ext sweep --org O --site S` | Enumeration | NDJSON, one card per line | `review sweep --org O --site S` |
| `aem-ext review --path PATH --org O --site S` | Enrichment | Single JSON object | `review ingest aem-ext --path PATH` |

### How they compose

```
# Populate the full backlog from AEM:
review sweep --org ai-ecoverse --site slicc-website

# Enrich a single card later (e.g. after selecting it in the sprinkle):
review ingest aem-ext --path /drafts/wac-demo.md --org ai-ecoverse --site slicc-website
```

`review sweep` calls `aem-ext sweep`, reads the NDJSON line-by-line, and sends
`ensure-item` + `add-findings` to the sprinkle for each card. Existing
`pangram`/`check-llm-cliches` sources are untouched — they still run via
`review ingest` on individual paths.

### Trade-offs

| Factor | Two-command approach | Single `--path .` approach |
|--------|---------------------|---------------------------|
| Protocol compat | Clean separation | Hack; breaks existing sources |
| Dry-run / preview | `--dry-run` on `review sweep` | Ambiguous |
| Enrichment per card | `aem-ext review --path` (status endpoint, richer) | Must invent |
| Existing sources | Unaffected | Risk of collision |

The limitation: `aem-ext` cannot be added to `KNOWN_INTEGRATIONS` in
`review.jsh` for auto-discovery, because the enrichment invocation needs
`--org` and `--site` which the discovery protocol does not pass. Named
invocation (`review ingest aem-ext --path PATH --org O --site S`) forwards the
site flags to `aem-ext`. They are not passed to unrelated review sources.

## Implementation

### `aem-ext sweep` (enumeration)

File: `skills/aem/scripts/aem-ext.jsh`

```
aem-ext sweep --org ORG --site SITE
              [--never-published]   # emit only never-published (default: both)
              [--stale]             # emit only stale
              [--include-assets]    # include non-page file types
```

Outputs NDJSON. Walks `preview/` and `live/` in parallel via `apiFetch` with
the existing credential resolution (API key or cookie). Each line is a valid
`SOURCE_PROTOCOL.md` object (`source: "aem-source"`, stable `id: "aem:<org>/<site>:<path>"`).

### `aem-ext review` (enrichment)

```
aem-ext review --path PATH --org ORG --site SITE [--id ID]
```

Calls `GET .../status/{path}` and emits one card with preview/live status,
`lastModifiedBy`, and `sourceLastModified` metadata. Suitable for
`review ingest aem-ext --path PATH`.

### `review sweep` (backlog population)

File: `skills/review/scripts/review.jsh`

```
review sweep --org ORG --site SITE
             [--never-published] [--stale] [--include-assets] [--dry-run]
```

Calls `aem-ext sweep`, streams NDJSON, sends `ensure-item` + `add-findings` per
card. `--dry-run` prints the raw cards without touching the sprinkle.

## Renderer options — measured verdict

A card produced by `aem-ext sweep` carries `previewUrl` pointing to
`https://main--slicc-website--ai-ecoverse.aem.page/{path}`. Three options for
in-sprinkle visual review; all three were evaluated:

### (a) `aem get` → VFS → serve locally → Pin Review (mirrors Speck)

**How it would work:** `aem-ext get /drafts/wac-demo.md --output /shared/...`,
serve the markdown from a local preview URL, inject the overlay.

**Measured result: NOT viable for rendered fidelity.**

EDS markdown is *source*, not a rendered page. The AEM rendering pipeline
(blocks, CSS, JS, Franklin/EDS framework) lives at `aem.page`, not in the
markdown file. A locally served `.md` file would render as raw text, not as
the designed page. Even if the HTML were fetched instead, asset URLs
(images, CSS, scripts) are relative to the origin and the CSP prevents
injection from other origins.

The local-serve approach works for Speck because Speck's target is the EDS
framework served from `chrome-extension://`, which loads the site's own CSS
and JS. There is no equivalent entrypoint for arbitrary preview pages.

**Verdict: fails the fidelity requirement. Not recommended.**

### (b) Remote iframe in the sprinkle, coordinates-only pins

**How it would work:** embed `https://main--slicc-website--ai-ecoverse.aem.page/...`
in an `<iframe>` inside the review sprinkle. Place pin markers in the sprinkle's
own DOM, using x/y coordinates saved relative to the iframe.

**Measured result: cross-origin DOM is inaccessible.**

`SPECK-FIX.md` states: *"Hidden on remote http(s) pages, which Speck can't
inject into due to CSP."* Verified in this runtime: `iframe.contentDocument`
is `null` for a cross-origin frame; accessing any property throws a
`SecurityError`. This is not a configuration choice — it is the browser's
same-origin policy and cannot be overridden from the sprinkle context.

Consequence: there is no way to read the DOM, measure element positions, or
translate a click on the iframe into a meaningful selector. Only raw viewport
x/y coordinates are available, and these break whenever the page layout
reflows (font load, window resize, lazy images).

**Verdict: coordinate-only pins are unreliable. Not recommended as a primary
review mechanism, but acceptable as a fallback for rough location notes.**

### (c) Pin Review on a real browser tab, sprinkle deep-links (recommended)

**How it works today (Pin Review):** the cone navigates a browser tab to the
preview URL, injects `enter.resolved.js`, and uses the existing Pin Review
overlay. This is already implemented and working. Pins attach to DOM selectors,
survive reflow, and POST back to the review sprinkle via the webhook.

**Extension for AEM:** when a card is selected in the review queue, the cone:
1. Opens (or navigates) a tab to `card.previewUrl`
2. Injects the Pin Review overlay (existing `enter.resolved.js` flow)
3. The user pins directly on the rendered AEM page

The sprinkle card's "Preview" button becomes a deep-link that triggers this
flow. No changes to the overlay or injection machinery are needed — the
existing Pin Review wiring handles it.

**Measured result: works.** Pin Review already supports remote `http(s)` pages
(overlay POSTs `mode:'no-cors'`). The AEM preview URL is accessible; the
rendered page loads correctly; pins attach to real DOM nodes.

**Verdict: recommended.** This is the only option that provides:
- Full rendered fidelity (real AEM page, real CSS/JS)
- Selector-based pins that survive reflow
- No new infrastructure (existing Pin Review handles it)
- No cross-origin access needed from the sprinkle

The only requirement: the cone must be active to inject the overlay after
the tab navigates. This is already a Pin Review requirement.

## Security

- `aem-ext sweep` and `aem-ext review` are read-only (`GET` only).
- No `POST .../preview/`, `POST .../live/`, `PUT`, or `DELETE` calls.
- No API key creation, registration, or deletion.
- Auth cookie is read from the session secret `aem.authcookie` via
  `secret get`; its masked value is passed to curl, which unmasks it
  server-side. The value never appears in stdout, code, or logs.

Card IDs include the organization and site, so the same path in two sites
remains two cards. Ingest and sweep use the same ID; an explicit `--id` overrides
it for ingest. A sweep exits nonzero if any card cannot be delivered, while
continuing through the remaining cards and reporting the totals.

## Future work

- Stale-check fixture: modify one preview file without publishing to generate
  a reproducible stale case for CI.
- Incremental sweeps: cache the previous tree snapshot and only emit delta
  cards since the last run (useful for large sites where O(folders) is still
  slow).

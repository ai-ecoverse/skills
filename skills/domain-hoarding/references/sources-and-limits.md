# Sources, limits and design decisions

Wire formats below were captured live on **2026-10-08** (issue-free to re-derive: the site bundle is
the ground truth). `scripts/sources.js` is the only file that talks to the network.

## 1. Instant Domain Search (primary)

The website's own backend, no key, no login. Both calls go to `https://instantdomainsearch.com`.

`GET /services/check?names=<d1,d2,…>&hash=<hash>` — up to 100 comma-joined full domains.
Response: `{"results":[{"name":"live.zip","availability":"available","trust":"high"}, …]}`.

- `hash = hashCode(names, 27)` where `hashCode` is the site's `r = (r<<5) - r + codePoint; r &= r` over
  the whole `names` string, seed 27, printed as a signed int32. Wrong or missing hash → HTTP 400
  `invalid hash`; a missing `hash` param says `missing field hash`.
- One invalid name fails the **whole batch** (400 `invalid domain name`), so every name is validated
  before sending (`scripts/domains.js`).
- `availability`: `available`, `inuse`, `reserved`, `blocked`, `unsupported` (TLD not covered —
  `.de`, `.eu`, `.co`, many new gTLDs). A name the API omits entirely is recorded as `missing`.
  `trust`: `high` (fresh registry check), `medium`, `low`, `none`. IDN names come back in Unicode;
  they are re-punycoded before matching.
- The site retries a 429/403 with a reCAPTCHA token header (`x-recaptcha-token`). This skill cannot
  mint that token; after the HTTP client's `Retry-After`-aware retries a persistent 429/403 is
  recorded as `ids: error` and the name falls through to RDAP. Not seen during testing.
- **Trust is spent on the first ask** — see `confidence-tiers.md`. Hence the local answer cache.

`POST /services/bulk-check` body `{"names":[{"name":"<label>","hash":"<hashCode(label,42)>","tlds":["zip","dad"]}]}`
(entries must be objects; `tlds` an array; hash may be a string). Response `results[]` rows carry
`isRegistered`, `tld`, and — only for premium names — `premium:{is_premium:true, usd_cents:N}`
(`live.zip` → 24900/99900 cents on different days; `page.dad` → 49900). It is called once per label for
names not already taken, and only enriches (price + a second opinion); a failure is swallowed.

## 2. RDAP via the IANA bootstrap (secondary)

`https://data.iana.org/rdap/dns.json` (cached 24 h in `$TMPDIR/domain-hoarding/`) maps TLD →
registry base URL; `GET <base>domain/<name>` with `Accept: application/rdap+json`. HTTPS entries are
preferred. For `foo.co.uk` the full suffix is tried before the last label. Status mapping:
200 → `registered` (+ `events[expiration]`, `status[]`), 404 → `unregistered`, 429/5xx/network →
`inconclusive` (after retries), no server → `no-server`.

**IANA lacks several large TLDs** (2026-10-08: 76 of the 636 suffixes — `de`, `io`, `co`, `eu`, `me`,
`us`, `sh`, `ac`, `ag`, `bz`, `lc`, `mn`, `sc`, `vc`, `ws`, `la`, `nz` and all `*.nz`/`*.pr`/`*.ag`…
second levels). `RDAP_OVERRIDES` in `sources.js` adds the servers that were **probed and proven**:
`google.<tld>` → HTTP 200 with the right `ldhName` *and* a nonsense label → 404.

| TLD(s) | Server |
|---|---|
| `de` | `rdap.denic.de` |
| `us` | `rdap.nic.us` |
| `ws` | `rdap.website.ws` |
| `io sh me ac lc mn vc ag sc bz` | `rdap.identitydigital.services/rdap/` |

Probed and **rejected** (do not add): `rdap.gg` and `rdap.mynic.my` answer 200 for *every* name;
`rdap.registry.co`, `rdap.nz`, `rdap.nic.tm` and `rdap.identitydigital.services` for `.la` answered 404
for `google.<tld>` (wrong or incomplete zone — a 404 you cannot trust); `rdap.eurid.eu`, `rdap.nic.co`,
`rdap.mx`, `rdap.amnic.net`, `rdap.dot.ph` were unreachable from this runtime. `rdap.org` (the
public redirector) answered 429 after ~70 requests and is not used. IANA always wins over an override.

## 3. WHOIS over HTTP (conservative fallback) and DNS (weaker last resort)

The brief orders sources IDS → RDAP → WHOIS. Port-43 WHOIS is **not feasible in-runtime**: SLICC has no raw
sockets (no `whois`/`nc`/`telnet`; a tray follower could run it, but none with exec was connected). The
substitute is the public, keyless HTTP JSON service **`https://api.whois.vu/?q=<domain>`**:
`{"domain","available":"yes"|"no","type","whois":"<raw WHOIS text>"}`.

**Third-party disclosure.** Every name sent to it is disclosed to api.whois.vu (unknown operator, no SLA).
It is therefore used only when IDS did not settle the name AND RDAP had no server or was inconclusive (a name RDAP
already placed in a tier never goes there); at most `--whois-max` names (25) per run; `--no-whois` disables it;
the names sent are printed on stderr and listed in `stats.whois.namesSent`.

**Why it is conservative (evidence, 2026-10-08):**
- `live.eu` → `available:"no"` with full registry text (Registrar, Name servers) in 0.6 s: a real positive.
- `live.nagoya` → `available:"no"` but the text was only *"Effective May 1, 2026, the WHOIS service has been retired … use RDAP"*.
  So a bare `no` is **not** evidence of registration; the client requires registration data (`Registrar:`,
  `Name servers:`, `Creation Date:`, …) in the text and rejects service notices (retired, rate limit, RDAP, …).
- `live.zip` → the service hung >60 s and ended in an nginx **504 HTML** page, and SLICC `curl -m 15` did not bound it.
  Hence the hard cap per lookup, strictly sequential calls at 1 s spacing, and a breaker after 2 consecutive failures.
- `yes` is never stronger than `unregistered-needs-confirmation`; `no` is `taken` only with registration data, and never
  overrules an IDS `available/high` (that is `inconclusive` + `conflict`). The reply must also name the queried domain.
- Registries are retiring WHOIS in favour of RDAP, so this fallback can only get weaker. A stronger no-key WHOIS
  option was not found: no other service was probed (the six-name live budget forbade probing with additional names).

**DNS NS** runs `dig <domain> NS --json` (SLICC's DoH `dig`), only for names still `inconclusive` after WHOIS.
`NS` present → `taken`; NXDOMAIN/no NS → `unregistered-needs-confirmation` (weak: registered-but-undelegated names
exist). It is not a substitute for WHOIS and is reported separately (`dns:`). One call is capped at 8 s; DoH being blocked
trips a breaker after the first failure. The DNS success path is tested only against fixtures.

## 4. The TLD universe — decision: ship a snapshot, offer a live refresh

`assets/tlds-porkbun-2026-09-24.txt` is the 636 extensions Porkbun's bulk-search selector offered on
2026-09-24 (taken from the old scan's CSV; 94 are multi-label like `co.uk`, 7 are punycode IDNs). Why a
snapshot: the selector is rendered page state, not an API, so scraping it live is brittle; the snapshot
makes `scan --all` deterministic, offline-capable and comparable with the old CSV.
`--live-tlds` (with `--all` or `tlds`) instead POSTs `{}` to Porkbun's **public, unauthenticated**
`https://api.porkbun.com/api/json/v3/pricing/get`: 911 TLDs on 2026-10-08, a strict superset of the
snapshot (all 636 present, 275 extra — mostly brand/new gTLDs IDS may not cover), each with a
registration price (reported as `porkbunUsd`). Cached 24 h; `--no-cache` bypasses. To refresh the shipped
snapshot: `domain-hoarding tlds --live-tlds > new.txt` and review the diff.

## 5. Politeness

| Knob | Default | Notes |
|---|---|---|
| `--concurrency` | 6 | total in-flight RDAP/DNS lookups (via `sliccy:pool`) |
| `--delay` | 200 ms | minimum spacing between requests to ONE registry host; 2 in flight per host |
| `--timeout` | 10 s | per attempt; ONE RDAP/WHOIS/DNS lookup is hard-capped at 1.5× (retries and `Retry-After` sleeps included); 5 s for RDAP on a name IDS already settled; an IDS call at 3× |
| IDS batch | 100 names | the site's own chunk size; ≥250 ms between batches |
| retries | 3 attempts | `sliccy:http` client; honours `Retry-After` on 429/502/503 |
| `--budget` | 45 s + 0.25 s/name beyond 60 | wall-clock for the RDAP/WHOIS/DNS stages; afterwards names stay `inconclusive` ("time budget exhausted") |
| WHOIS | 1 at a time, 1 s apart, `--whois-max` 25, breaker 2 | third-party service, see §3 |
| breaker | 3 | consecutive 429/5xx/network failures against a host → remaining names for it are `inconclusive` and the stderr line lists the host |

Hosts such as `rdap.donuts.co` serve hundreds of TLDs, so a big `scan` is bounded by that host's
per-host limit, not by `--concurrency`. Nothing is retried in a loop beyond the table.

## 6. Files and caches (all under `$TMPDIR/domain-hoarding/`, override with `DOMAIN_HOARDING_CACHE`)

`iana-rdap-dns.json` (24 h), `porkbun-pricing.json` (24 h, `--live-tlds` only), `ids-answers.json`
(`--cache-ttl`, default 60 min, high-trust answers only). Availability results are **not** otherwise
cached: a name can be registered at any moment. Cache dirs are per SLICC unit (`$TMPDIR` differs per
cone/scoop), so a scoop does not see the cone's remembered answers.

## 7. Known gaps

- The process ends with `process.exit` after output is written: an abandoned (timed-out) fetch otherwise kept the realm alive for >90 s.
- WHOIS `yes` has never been observed live (the only `yes` candidates were names the tool would not send); its handling is unit-tested against the documented shape only.

- reCAPTCHA-gated IDS responses and the live DNS success path are unverified.
- Multi-label suffixes (`co.uk`, `ac.nz`) are checked as the name `label.suffix`; IDS often drops them
  (`missing`) and many have no RDAP server, so they are frequently `inconclusive`.
- `.ae.org`-style private suffixes: the parent registry's RDAP answers 400 → `inconclusive`.
- IDS's server-side cache window is longer than the 60 minutes measured here; its true TTL is unknown.

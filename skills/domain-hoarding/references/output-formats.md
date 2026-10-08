# Output formats

## Human (default)

`check` prints one block per domain (glyph, name, verdict, evidence, reason). `scan` prints a
matrix (rows = TLDs, columns = labels, one glyph per cell), then:

```
AVAILABLE for ALL 3 label(s) (high confidence; registrable — premium names cost extra): com, dev, tech
    standard price for every label: com, dev
    with at least one PREMIUM label ($): tech
Not taken for all, but needs confirmation / inconclusive: xyz
```

TLDs whose every label is taken are hidden (`--full` shows them). The glyph legend is printed
under every table. A one-line stats summary (call counts, throttling, elapsed) goes to stderr
unless `-q`.

## JSON (`--json`)

```json
{
  "tool": "domain-hoarding", "version": "1.1.0", "command": "scan",
  "generatedAt": "2026-10-08T14:40:00.000Z",
  "sources": { "tlds": "snapshot:tlds-porkbun-2026-09-24", "rdapEnabled": true, "whoisEnabled": true, "whoisProvider": "api.whois.vu (third party)", "dnsEnabled": true, "premiumLookup": true },
  "stats": { "elapsedMs": 2987, "ids": { "checkCalls": 1, "bulkCalls": 1, "errors": 0, "rememberedAnswersReused": 0, "availableAnswers": 16, "availableHighTrust": 10 }, "rdap": { "calls": 16, "throttled": 0, "backedOffHosts": [] }, "whois": { "calls": 0, "skippedOverLimit": 0, "backedOff": false, "thirdParty": "api.whois.vu", "namesSent": [] }, "dns": { "calls": 0 }, "budgetSec": 45, "warnings": [] },
  "tierOrder": ["available-high-confidence", "unregistered-needs-confirmation", "inconclusive", "taken-reserved-blocked"],
  "summary": { "total": 16, "tiers": { "...": 0 }, "available": 10, "standardPrice": 3, "premium": 7, "premiumUnchecked": 0 },
  "labels": ["live", "page"], "tlds": ["com", "dev"],
  "allAvailable": ["dev", "tech"], "allAvailableStandard": ["dev"], "allAvailableButPremium": ["tech"], "allAvailableUnchecked": [],
  "allNotTaken": ["dev", "tech", "xyz"],
  "results": [ { "domain": "page.giving", "label": "page", "tld": "giving", "tier": "available-high-confidence",
      "available": true, "premium": false, "premiumUsd": null, "reason": "…", "conflict": false,
      "ids": { "availability": "available", "trust": "high" },
      "rdap": { "server": "rdap.donuts.co", "via": "iana", "status": "unregistered", "httpStatus": 404 },
      "whois": null, "dns": null, "bulk": { "registered": false, "premiumUsd": null } } ]
}
```

`labels`, `tlds`, `allAvailable*` and `allNotTaken` exist only for `scan`. There is deliberately no `free` or
`allFree` key: "free" means available, and `allAvailable` includes premium names (see `premium`: `true`/`false`/`null`
= unchecked). `ids`, `rdap`, `whois`, `dns`, `bulk` are `null` when that source was not consulted. `rdap.status` is one of `registered`,
`unregistered`, `inconclusive`, `no-server`; `whois.status` is `registered`, `unregistered` or `inconclusive` (`whois.answer` keeps the raw `yes`/`no`); `rdap.expires` is the registry's expiration event.
`ids.availability` can also be `unsupported`, `missing` (the API dropped the name) or `error`.
`porkbunUsd` appears with `--live-tlds`.

## CSV (`--csv`)

One row per name, header always present, RFC-4180 quoting:

`domain,label,tld,tier,available,premium,premium_usd,instant_status,instant_trust,rdap_status,rdap_expires,whois_status,dns_status,porkbun_usd,reason`

`instant_status`, `instant_trust` and `rdap_status` keep the names used by the 2026-09-24 CSV so
old and new files can be joined on `domain`. `tier` replaces its `classification` column with the
brief's tier names (`unavailable` → `taken-reserved-blocked`, `unregistered-rdap-check-at-registrar`
→ `unregistered-needs-confirmation`).

## Exit codes

| Code | Meaning |
|---|---|
| 0 | ran to completion (tiers may still be inconclusive) |
| 1 | usage error, bad label/domain/TLD, unreadable `--from`, unknown flag, no TLD list |
| 2 | ran, but every name is `inconclusive` and IDS errored — nothing answered |

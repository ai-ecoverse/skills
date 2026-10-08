// pipeline.js — evidence gathering order and the scan roll-ups. Sources are injected.
//
// Order (cheapest and most trusted first, later stages only where they can change the answer):
//   1. IDS /services/check  — every name, batched.
//   2. RDAP                 — `check`: every name (adds expiry); `scan`: only names IDS did not
//                             settle (inuse/reserved/blocked, or available+trust high), or all with verify.
//   3. WHOIS (HTTP JSON)    — only names that are STILL inconclusive because RDAP had no server /
//                             was inconclusive (IDS unsettled too). Sequential, capped, third party.
//   4. DNS NS               — only names still inconclusive after 1–3 (weaker final fallback).
//   5. IDS /services/bulk-check — names not already taken, per label: premium price + a second
//                             opinion on registration. Enrichment only.
// Stages 2–4 stop asking once `opts.deadline` (epoch ms) passes: remaining names stay
// inconclusive with an explicit reason, so a throttled secondary source can never hold a run hostage.

const { TAKEN_IDS, TIERS, classify } = require('./classify.js');

const NO_BUDGET = { status: 'inconclusive', error: 'time budget exhausted (--budget)' };
const idsSettled = (ids) =>
  !!ids &&
  (TAKEN_IDS.has(ids.availability) || (ids.availability === 'available' && ids.trust === 'high'));

/**
 * items: [{ domain, label, tld, tldKnown, input?, note? }]
 * deps:  { ids, rdap, whois?, dns, pool, sleep? }
 * opts:  { mode: 'check'|'scan', rdap, whois, dns, premium, verify, concurrency, delayMs, prices, deadline? }
 * Returns rows (one per item, input order).
 */
async function gather(items, deps, opts) {
  const { ids, rdap, whois, dns, pool } = deps;
  const inBudget = () => !opts.deadline || Date.now() < opts.deadline;
  const rows = items.map((it) => ({ ...it, evidence: {} }));

  const idsRes = await ids.check(rows.map((r) => r.domain));
  for (const r of rows) r.evidence.ids = idsRes.get(r.domain);

  if (opts.rdap) {
    const targets = rows.filter(
      (r) => opts.verify || opts.mode === 'check' || !idsSettled(r.evidence.ids)
    );
    await pool(opts.concurrency, targets, async (r) => {
      // When IDS already settled the name, RDAP only adds expiry/cross-checking: give it a short leash so a
      // slow registry cannot hold up an answer we already have.
      const enrich = idsSettled(r.evidence.ids) ? { capMs: opts.enrichCapMs || 5000 } : undefined;
      r.evidence.rdap = inBudget() ? await rdap.lookup(r.domain, r.tld, enrich) : { ...NO_BUDGET };
    });
  }

  if (opts.whois && whois) {
    // Only where IDS did not settle it AND RDAP could not (or was not asked): a name RDAP already
    // placed in a tier never reaches the third-party service.
    const needs = (r) =>
      !r.evidence.rdap ||
      r.evidence.rdap.status === 'no-server' ||
      r.evidence.rdap.status === 'inconclusive';
    const targets = rows.filter(
      (r) =>
        classify(r.evidence).tier === TIERS.INCONCLUSIVE && !idsSettled(r.evidence.ids) && needs(r)
    );
    // whois.lookup serialises internally, so a plain loop keeps the order deterministic.
    for (const r of targets)
      r.evidence.whois = inBudget()
        ? await whois.lookup(r.domain)
        : { ...NO_BUDGET, server: 'api.whois.vu' };
  }

  if (opts.dns) {
    const targets = rows.filter(
      (r) =>
        classify(r.evidence).tier === TIERS.INCONCLUSIVE &&
        !classify(r.evidence).conflict &&
        !(r.evidence.ids?.availability === 'error' && !r.evidence.rdap)
    );
    // First lookup alone: if the DoH path is blocked it fails slowly (~10 s), and we want to pay
    // that once, not once per parallel worker.
    if (targets.length) {
      targets[0].evidence.dns = inBudget() ? await dns.lookup(targets[0].domain) : { ...NO_BUDGET };
      await pool(Math.min(opts.concurrency, 4), targets.slice(1), async (r) => {
        r.evidence.dns = inBudget() ? await dns.lookup(r.domain) : { ...NO_BUDGET };
      });
    }
  }

  if (opts.premium) {
    const byLabel = new Map();
    for (const r of rows) {
      const tier = classify(r.evidence).tier;
      if (tier === TIERS.AVAILABLE || tier === TIERS.UNREGISTERED) {
        if (!byLabel.has(r.label)) byLabel.set(r.label, []);
        byLabel.get(r.label).push(r);
      }
    }
    // Different labels are independent calls; a few at a time keeps a 3-label scan to one round trip.
    await pool(Math.min(3, opts.concurrency || 3), [...byLabel], async ([label, group]) => {
      const res = await ids.bulk(label, [...new Set(group.map((r) => r.tld))]);
      for (const r of group) if (res.has(r.tld)) r.evidence.bulk = res.get(r.tld);
    });
  }

  return rows.map((r) => finalize(r, opts.prices));
}

function finalize(r, prices) {
  const c = classify(r.evidence);
  const { ids, rdap, whois, dns, bulk } = r.evidence;
  const row = {
    domain: r.domain,
    label: r.label,
    tld: r.tld,
    tier: c.tier,
    available: c.available,
    premium: c.premium,
    premiumUsd: c.premiumUsd,
    reason: c.reason,
    conflict: c.conflict,
    ids: ids || null,
    rdap: rdap || null,
    whois: whois || null,
    dns: dns || null,
    bulk: bulk || null,
  };
  if (prices && prices[r.tld] != null) row.porkbunUsd = prices[r.tld];
  if (r.note) row.note = r.note;
  if (r.tldKnown === false)
    row.note = [row.note, 'TLD not in the known suffix list'].filter(Boolean).join('; ');
  return row;
}

const TIER_ORDER = [TIERS.AVAILABLE, TIERS.UNREGISTERED, TIERS.INCONCLUSIVE, TIERS.TAKEN];

function summarize(rows) {
  const tiers = Object.fromEntries(TIER_ORDER.map((t) => [t, 0]));
  let available = 0;
  let premium = 0;
  let premiumUnchecked = 0;
  for (const r of rows) {
    tiers[r.tier]++;
    if (!r.available) continue;
    available++;
    if (r.premium === true) premium++;
    else if (r.premium == null) premiumUnchecked++;
  }
  return {
    total: rows.length,
    tiers,
    available,
    standardPrice: available - premium - premiumUnchecked,
    premium,
    premiumUnchecked,
  };
}

/**
 * Per-TLD matrix and the intersections. "Free" in Lars's brief means AVAILABLE (registrable), so
 * `allAvailable` is the headline intersection and INCLUDES premium cells — premium names are
 * purchasable, just priced above standard. The finer lists say what kind of "available" it is:
 *   allAvailableStandard  every label available and positively known not to be premium
 *   allAvailableButPremium  every label available, >=1 PREMIUM (cost extra)
 *   allAvailableUnchecked   every label available, none premium, >=1 premium status unknown
 * (allAvailable = those three, in TLD order). Nothing weaker than available-high-confidence qualifies;
 * `allNotTaken` additionally admits unregistered-needs-confirmation / inconclusive cells.
 */
function matrix(rows, labels, tlds) {
  const by = new Map(rows.map((r) => [`${r.label}.${r.tld}`, r]));
  const lines = tlds.map((tld) => ({
    tld,
    cells: labels.map((l) => by.get(`${l}.${tld}`) || null),
  }));
  const ok = (cells, pred) => cells.every((c) => c && pred(c));
  const avail = (c) => c.tier === TIERS.AVAILABLE;
  const pick = (pred) => lines.filter((l) => ok(l.cells, pred)).map((l) => l.tld);
  const allAvailable = pick(avail);
  const hasPremium = (l) => l.cells.some((c) => c.premium === true);
  const hasUnknown = (l) => l.cells.some((c) => c.premium == null);
  const inAll = new Set(allAvailable);
  const sub = (f) => lines.filter((l) => inAll.has(l.tld) && f(l)).map((l) => l.tld);
  return {
    rows: lines,
    allAvailable,
    allAvailableStandard: sub((l) => !hasPremium(l) && !hasUnknown(l)),
    allAvailableButPremium: sub(hasPremium),
    allAvailableUnchecked: sub((l) => !hasPremium(l) && hasUnknown(l)),
    allNotTaken: pick((c) => c.tier !== TIERS.TAKEN),
  };
}

module.exports = { TIER_ORDER, finalize, gather, idsSettled, matrix, summarize };

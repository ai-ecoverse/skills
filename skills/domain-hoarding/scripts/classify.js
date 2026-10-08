// classify.js — turn per-source evidence into one confidence tier. Pure.
//
// Vocabulary (Lars's wording): "free" means AVAILABLE — unregistered and registrable —
// NOT zero-dollar. A premium name is still AVAILABLE; it is just priced above standard
// registration. So `available` and `premium` are separate facts and nothing here says "free".
//
// The one rule this file exists to enforce: RDAP 404 means "no registry record",
// NOT "you can register it". In the 2026-09-24 scan 249 names were RDAP-404 yet
// needed checkout confirmation (reserved, premium, registry-blocked, trademark
// sunrise). Only the Instant Domain Search EPP-backed answer with trust=high may
// produce `available-high-confidence`.
//
// Precedence (first match wins):
//   1. RDAP registered                       -> taken   (registry data beats an aggregator)
//   2. IDS inuse/reserved/blocked            -> taken
//   3. WHOIS "no" / DNS delegated            -> taken, UNLESS IDS said available/high:
//                                               a weaker source contradicting the primary
//                                               one is inconclusive + conflict, not a verdict
//   4. IDS available + trust high           -> available (bulk "registered" -> inconclusive+conflict)
//   5. IDS available (lower trust)          -> unregistered-needs-confirmation
//   6. RDAP 404 / WHOIS "yes" / DNS none   -> unregistered-needs-confirmation
//   7. otherwise                            -> inconclusive

const TIERS = {
  AVAILABLE: 'available-high-confidence',
  TAKEN: 'taken-reserved-blocked',
  UNREGISTERED: 'unregistered-needs-confirmation',
  INCONCLUSIVE: 'inconclusive',
};

const TAKEN_IDS = new Set(['inuse', 'reserved', 'blocked']);

/**
 * evidence = {
 *   ids:   { availability, trust } | { availability: 'error', error } | undefined
 *   rdap:  { status: 'registered'|'unregistered'|'inconclusive'|'no-server', ... } | undefined
 *   whois: { status: 'registered'|'unregistered'|'inconclusive', ... } | undefined
 *   dns:   { status: 'delegated'|'undelegated'|'unavailable' } | undefined
 *   bulk:  { registered: boolean|null, premiumUsd: number|null } | undefined
 * }
 * Returns { tier, available, premium, premiumUsd, reason, conflict }.
 *   available = tier is available-high-confidence (registrable; premium names INCLUDED).
 *   premium   = true / false when the bulk lookup answered, null when it did not run or failed
 *               (so "standard price" is never claimed without evidence).
 */
function classify(evidence) {
  const { ids, rdap, whois, dns, bulk } = evidence || {};
  const premiumUsd = bulk?.premiumUsd ?? null;
  const premium = bulk ? premiumUsd != null : null;
  const out = (tier, reason, extra = {}) => ({
    tier,
    available: tier === TIERS.AVAILABLE,
    premium,
    premiumUsd,
    reason,
    conflict: false,
    ...extra,
  });
  const idsHigh = ids?.availability === 'available' && ids.trust === 'high';

  // 1–2. Strong "this exists / is held" signals.
  if (rdap?.status === 'registered') {
    const conflict = ids?.availability === 'available';
    return out(
      TIERS.TAKEN,
      conflict
        ? 'RDAP has a registry record but Instant Domain Search says available'
        : 'RDAP: registered',
      { conflict }
    );
  }
  if (ids && TAKEN_IDS.has(ids.availability)) {
    return out(TIERS.TAKEN, `Instant Domain Search: ${ids.availability} (trust ${ids.trust})`);
  }

  // 3. Weaker "taken" signals never overrule a high-trust IDS "available".
  const weakTaken =
    whois?.status === 'registered'
      ? 'WHOIS (api.whois.vu): registered'
      : dns?.status === 'delegated'
        ? 'DNS: the name has NS delegation'
        : null;
  if (weakTaken) {
    if (idsHigh)
      return out(
        TIERS.INCONCLUSIVE,
        `Instant Domain Search says available (trust high) but ${weakTaken}`,
        { conflict: true }
      );
    return out(TIERS.TAKEN, weakTaken);
  }

  // 4. The only path to high-confidence available.
  if (idsHigh) {
    if (bulk?.registered === true) {
      return out(
        TIERS.INCONCLUSIVE,
        'Instant Domain Search check says available/high but its bulk endpoint says registered',
        { conflict: true }
      );
    }
    return out(
      TIERS.AVAILABLE,
      premiumUsd == null
        ? 'Instant Domain Search: available (trust high)'
        : `Instant Domain Search: available (trust high), PREMIUM $${premiumUsd}`
    );
  }

  // 5–6. Weak "probably unregistered" signals — never promoted to available.
  if (ids?.availability === 'available') {
    return out(
      TIERS.UNREGISTERED,
      `Instant Domain Search: available but trust ${ids.trust}; confirm at a registrar`
    );
  }
  if (rdap?.status === 'unregistered') {
    return out(
      TIERS.UNREGISTERED,
      'RDAP 404 = no registry record, not proof it is registrable; confirm at a registrar'
    );
  }
  if (whois?.status === 'unregistered') {
    return out(
      TIERS.UNREGISTERED,
      'WHOIS (api.whois.vu) says unregistered — unverified third-party answer; confirm at a registrar'
    );
  }
  if (dns?.status === 'undelegated') {
    return out(TIERS.UNREGISTERED, 'DNS: no delegation (weak signal only); confirm at a registrar');
  }

  // 7. Nothing usable.
  const why = [];
  if (!ids) why.push('IDS not queried');
  else if (ids.availability === 'error') why.push(`IDS error: ${ids.error}`);
  else why.push(`IDS ${ids.availability}`);
  if (rdap)
    why.push(
      rdap.status === 'no-server'
        ? 'no RDAP server for this TLD'
        : `RDAP ${rdap.status}${rdap.error ? ` (${rdap.error})` : ''}`
    );
  if (whois) why.push(`WHOIS ${whois.status}${whois.error ? ` (${whois.error})` : ''}`);
  if (dns && dns.status === 'unavailable') why.push('DNS unavailable');
  return out(TIERS.INCONCLUSIVE, why.join('; '));
}

/** Single-glyph cell for the scan matrix. `$` = available but PREMIUM (still registrable). */
function glyph(row) {
  if (row.tier === TIERS.AVAILABLE) return row.premium === true ? '$' : '✓';
  if (row.tier === TIERS.TAKEN) return '✗';
  if (row.tier === TIERS.UNREGISTERED) return '?';
  return '~';
}

module.exports = { TAKEN_IDS, TIERS, classify, glyph };

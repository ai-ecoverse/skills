// render.js — human, CSV and JSON renderers. Pure; `color` is injected so tests get plain text.

const { TIERS, glyph } = require('./classify.js');
const { TIER_ORDER } = require('./pipeline.js');

const CSV_COLUMNS = [
  'domain',
  'label',
  'tld',
  'tier',
  'available',
  'premium',
  'premium_usd',
  'instant_status',
  'instant_trust',
  'rdap_status',
  'rdap_expires',
  'whois_status',
  'dns_status',
  'porkbun_usd',
  'reason',
];

const plain = new Proxy({}, { get: () => (s) => s });

function csvCell(v) {
  const s = v == null ? '' : String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function csvRow(r) {
  return [
    r.domain,
    r.label,
    r.tld,
    r.tier,
    r.available,
    r.premium,
    r.premiumUsd,
    r.ids?.availability,
    r.ids?.trust,
    r.rdap?.status,
    r.rdap?.expires,
    r.whois?.status,
    r.dns?.status,
    r.porkbunUsd,
    r.reason,
  ]
    .map(csvCell)
    .join(',');
}

function toCsv(rows) {
  return `${[CSV_COLUMNS.join(','), ...rows.map(csvRow)].join('\n')}\n`;
}

const money = (n) => (n == null ? '' : `$${Number.isInteger(n) ? n : n.toFixed(2)}`);

/** Short evidence string: "ids:available/high rdap:unregistered dns:undelegated". */
function evidence(r) {
  const bits = [];
  if (r.ids)
    bits.push(
      r.ids.availability === 'error'
        ? 'ids:error'
        : `ids:${r.ids.availability}/${r.ids.trust}${r.ids.cached ? ` (remembered ${Math.max(1, Math.round(r.ids.ageSec / 60))}m ago)` : ''}`
    );
  if (r.rdap)
    bits.push(
      `rdap:${r.rdap.status}${r.rdap.expires ? ` exp ${r.rdap.expires.slice(0, 10)}` : ''}`
    );
  if (r.whois) bits.push(`whois:${r.whois.status}`);
  if (r.dns) bits.push(`dns:${r.dns.status}`);
  return bits.join(' ');
}

function verdictLabel(r) {
  if (r.tier === TIERS.AVAILABLE) {
    if (r.premium === true) return `AVAILABLE · PREMIUM ${money(r.premiumUsd)}`;
    return r.premium === false ? 'AVAILABLE' : 'AVAILABLE · premium status unchecked';
  }
  if (r.tier === TIERS.TAKEN) return 'taken';
  if (r.tier === TIERS.UNREGISTERED) return 'unregistered — confirm';
  return 'inconclusive';
}

function pad(s, n) {
  s = String(s);
  return s.length >= n ? s : s + ' '.repeat(n - s.length);
}

const tint = (c, row, text) => {
  if (row.tier === TIERS.AVAILABLE) return row.premium === true ? c.yellow(text) : c.green(text);
  if (row.tier === TIERS.TAKEN) return c.red(text);
  return c.yellow(text);
};

const LEGEND =
  '✓ AVAILABLE, standard price   $ AVAILABLE but PREMIUM (costs extra)   ? unregistered, confirm at a registrar   ✗ taken/reserved/blocked   ~ inconclusive   (available = registrable; it does not mean $0)';

function humanCheck(rows, c = plain) {
  const w = Math.max(6, ...rows.map((r) => r.domain.length));
  const v = Math.max(...rows.map((r) => verdictLabel(r).length), 8);
  const out = [''];
  for (const r of rows) {
    const g = tint(c, r, glyph(r));
    out.push(
      `  ${g} ${c.bold(pad(r.domain, w))}  ${tint(c, r, pad(verdictLabel(r), v))}  ${c.dim(evidence(r))}`
    );
    if (r.tier !== TIERS.AVAILABLE || r.conflict || r.premium !== false)
      out.push(`      ${c.dim(r.reason)}`);
    if (r.note) out.push(`      ${c.dim(`note: ${r.note}`)}`);
  }
  out.push('', `  ${c.dim(LEGEND)}`);
  return `${out.join('\n')}\n`;
}

function humanScan(_rows, labels, tlds, m, summary, { full = false } = {}, c = plain) {
  const out = [''];
  const tw = Math.max(5, ...tlds.map((t) => t.length));
  const cw = labels.map((l) => Math.max(l.length, 3));
  const head = `  ${pad('TLD', tw)}  ${labels.map((l, i) => pad(l, cw[i])).join('  ')}`;
  out.push(c.bold(head), c.dim(`  ${'─'.repeat(head.length - 2)}`));
  let hidden = 0;
  for (const line of m.rows) {
    const allTaken = line.cells.every((x) => x && x.tier === TIERS.TAKEN);
    if (allTaken && !full) {
      hidden++;
      continue;
    }
    const cells = line.cells.map((x, i) => {
      const g = x ? glyph(x) : ' ';
      return (x ? tint(c, x, g) : g) + ' '.repeat(cw[i] - 1);
    });
    out.push(`  ${pad(line.tld, tw)}  ${cells.join('  ')}`);
  }
  if (hidden)
    out.push(
      c.dim(`  … ${hidden} TLD(s) hidden because every label is taken (use --full to show them)`)
    );
  out.push('', `  ${c.dim(LEGEND)}`, '');
  const n = labels.length;
  const list = (xs) => xs.join(', ');
  out.push(
    `  ${c.bold(`AVAILABLE for ALL ${n} label(s)`)} ${c.dim('(high confidence; registrable — premium names cost extra)')}: ${m.allAvailable.length ? c.green(list(m.allAvailable)) : c.dim('none')}`
  );
  if (m.allAvailable.length) {
    out.push(
      `    ${c.dim('standard price for every label:')} ${m.allAvailableStandard.length ? list(m.allAvailableStandard) : 'none'}`
    );
    if (m.allAvailableButPremium.length)
      out.push(
        `    ${c.dim('with at least one PREMIUM label ($):')} ${c.yellow(list(m.allAvailableButPremium))}`
      );
    if (m.allAvailableUnchecked.length)
      out.push(
        `    ${c.dim('premium status not checked (--no-premium or lookup failed):')} ${list(m.allAvailableUnchecked)}`
      );
  }
  const maybe = m.allNotTaken.filter((t) => !m.allAvailable.includes(t));
  if (maybe.length)
    out.push(
      `  ${c.bold('Not taken for all, but needs confirmation / inconclusive')}: ${c.dim(list(maybe))}`
    );
  out.push('', `  ${c.dim(tierSummaryLine(summary))}`);
  return `${out.join('\n')}\n`;
}

function tierSummaryLine(s) {
  const t = s.tiers;
  return `${s.total} names: ${t[TIERS.AVAILABLE]} available-high-confidence (${s.standardPrice} standard price, ${s.premium} premium, ${s.premiumUnchecked} premium-unchecked), ${t[TIERS.UNREGISTERED]} unregistered-needs-confirmation, ${t[TIERS.INCONCLUSIVE]} inconclusive, ${t[TIERS.TAKEN]} taken-reserved-blocked`;
}

/** Stable JSON document shared by check and scan. */
function toJson({
  command,
  version,
  generatedAt,
  labels,
  tlds,
  rows,
  summary,
  matrix,
  sources,
  stats,
}) {
  const doc = {
    tool: 'domain-hoarding',
    version,
    command,
    generatedAt,
    sources,
    stats,
    tierOrder: TIER_ORDER,
    summary,
  };
  if (labels) doc.labels = labels;
  if (tlds) doc.tlds = tlds;
  if (matrix) {
    doc.allAvailable = matrix.allAvailable;
    doc.allAvailableStandard = matrix.allAvailableStandard;
    doc.allAvailableButPremium = matrix.allAvailableButPremium;
    doc.allAvailableUnchecked = matrix.allAvailableUnchecked;
    doc.allNotTaken = matrix.allNotTaken;
  }
  doc.results = rows;
  return doc;
}

module.exports = {
  CSV_COLUMNS,
  LEGEND,
  humanCheck,
  humanScan,
  plain,
  tierSummaryLine,
  toCsv,
  toJson,
};

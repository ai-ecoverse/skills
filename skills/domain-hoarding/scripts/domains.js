// domains.js — pure name handling: label/TLD/domain normalisation and the Instant
// Domain Search request hash. No I/O, no sliccy:*, so it is unit-testable.

const LABEL_RE = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;

/** IDN -> punycode via the WHATWG URL parser; null when the host is not parseable. */
function toAscii(host) {
  try {
    return new URL(`http://${host}`).hostname;
  } catch (_) {
    return null;
  }
}

/** One DNS label ("live", "bücher") -> lowercase ASCII, or throw with a usable message. */
function normalizeLabel(raw) {
  const s = String(raw ?? '')
    .trim()
    .toLowerCase();
  if (!s) throw new Error('empty label');
  if (s.includes('.')) {
    throw new Error(
      `label "${raw}" contains a dot — scan takes bare labels; use check for full domains`
    );
  }
  const ascii = toAscii(s);
  if (!ascii || !LABEL_RE.test(ascii)) {
    throw new Error(
      `"${raw}" is not a valid domain label (letters, digits, inner hyphens; max 63)`
    );
  }
  return ascii;
}

/** "com", ".CO.UK", "рф" -> lowercase ASCII suffix (may be multi-label). */
function normalizeTld(raw) {
  const s = String(raw ?? '')
    .trim()
    .toLowerCase()
    .replace(/^\.+|\.+$/g, '');
  if (!s) throw new Error('empty TLD');
  const ascii = toAscii(s);
  if (!ascii || !ascii.split('.').every((p) => LABEL_RE.test(p))) {
    throw new Error(`"${raw}" is not a valid TLD`);
  }
  return ascii;
}

/**
 * Split user input ("https://www.live.co.uk/x", "live.zip") into registrable parts.
 * `suffixes` is a Set of known (possibly multi-label) public suffixes; the longest
 * match wins, otherwise the last label is assumed to be the TLD and `tldKnown` is false.
 * Returns { input, domain, label, tld, tldKnown, note? }.
 */
function splitDomain(raw, suffixes) {
  let s = String(raw ?? '')
    .trim()
    .toLowerCase();
  if (!s) throw new Error('empty domain');
  s = s.replace(/^[a-z][a-z0-9+.-]*:\/\//, '');
  s = s.split(/[/?#]/)[0].replace(/^[^@]*@/, '');
  s = s.replace(/:\d+$/, '').replace(/^\*\./, '').replace(/\.+$/, '');
  const ascii = toAscii(s);
  if (!ascii) throw new Error(`"${raw}" is not a valid domain name`);
  const parts = ascii.split('.');
  if (parts.length < 2) {
    throw new Error(
      `"${raw}" has no TLD — use "domain-hoarding scan ${s} --tlds com,net" to try a bare label`
    );
  }
  if (!parts.every((p) => LABEL_RE.test(p))) throw new Error(`"${raw}" is not a valid domain name`);
  if (ascii.length > 253) throw new Error(`"${raw}" is longer than 253 characters`);
  if (/^\d+$/.test(parts[parts.length - 1]))
    throw new Error(`"${raw}" looks like an IP address, not a domain name`);
  let idx = -1;
  for (let i = 1; i < parts.length; i++) {
    if (suffixes?.has(parts.slice(i).join('.'))) {
      idx = i;
      break;
    }
  }
  const tldKnown = idx !== -1;
  if (!tldKnown) idx = parts.length - 1;
  const label = parts[idx - 1];
  const tld = parts.slice(idx).join('.');
  const out = { input: String(raw).trim(), domain: `${label}.${tld}`, label, tld, tldKnown };
  if (idx > 1)
    out.note = `subdomain "${parts.slice(0, idx - 1).join('.')}" ignored — registrability is decided at ${out.domain}`;
  return out;
}

/** Instant Domain Search request hash (site bundle `hashCode`, verified 2026-10-08). */
function hashCode(str, seed = 0) {
  let r = seed;
  for (const ch of str) {
    r = (r << 5) - r + (ch.codePointAt(0) ?? 0);
    r &= r;
  }
  return String(r);
}
const CHECK_SEED = 27; // BULK_HASH_SEED -> GET /services/check
const BULK_SEED = 42; // NOMINL_HASH_SEED -> POST /services/bulk-check

/** Parse a TLD list file: one per line, '#' comments, blank lines ignored. */
function parseTldList(text) {
  const out = [];
  const seen = new Set();
  for (const line of String(text || '').split(/\r?\n/)) {
    const t = line.replace(/#.*/, '').trim();
    if (!t) continue;
    const tld = normalizeTld(t);
    if (!seen.has(tld)) {
      seen.add(tld);
      out.push(tld);
    }
  }
  return out;
}

/** Split one CSV line into cells (RFC-4180 quotes, "" escapes). */
function splitCsvLine(line) {
  const cells = [];
  let cur = '';
  let q = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (q) {
      if (ch === '"' && line[i + 1] === '"') {
        cur += '"';
        i++;
      } else if (ch === '"') q = false;
      else cur += ch;
    } else if (ch === '"') q = true;
    else if (ch === ',') {
      cells.push(cur);
      cur = '';
    } else cur += ch;
  }
  cells.push(cur);
  return cells.map((c) => c.trim());
}

/** Domains from a --from file: one per line, or a CSV whose header has a `domain` column. */
function parseDomainFile(text) {
  const lines = String(text || '')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#'));
  if (!lines.length) return [];
  const header = splitCsvLine(lines[0]).map((h) => h.toLowerCase());
  const col = header.indexOf('domain');
  if (header.length > 1 && col !== -1) {
    return lines
      .slice(1)
      .map((l) => splitCsvLine(l)[col] || '')
      .filter(Boolean);
  }
  return lines.map((l) => l.split(/[,\s]/)[0]);
}

module.exports = {
  BULK_SEED,
  CHECK_SEED,
  LABEL_RE,
  hashCode,
  normalizeLabel,
  normalizeTld,
  parseDomainFile,
  parseTldList,
  splitCsvLine,
  splitDomain,
  toAscii,
};

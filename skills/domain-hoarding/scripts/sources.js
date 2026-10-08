// sources.js — the three evidence sources (+ TLD universe), each behind an
// injected client so the tst suite can run offline. No sliccy:* requires here;
// domain-hoarding.jsh wires in sliccy:http / sliccy:exec / fs.
//
//   1. Instant Domain Search  GET /services/check   primary, EPP-backed, trust-graded
//                             POST /services/bulk-check  premium price + isRegistered
//   2. RDAP                   IANA bootstrap -> registry server; secondary
//   3. WHOIS over HTTP        api.whois.vu JSON — conservative fallback only when IDS is
//                             unsettled AND RDAP has no server / is inconclusive. Port-43 WHOIS
//                             is unreachable from the SLICC runtime (no raw sockets).
//   4. DNS NS via `dig`       weaker last resort (DoH; may itself be blocked)

const { BULK_SEED, CHECK_SEED, hashCode, parseTldList, toAscii } = require('./domains.js');

const IDS_BATCH = 100; // same chunk size the site itself uses for /services/check
const PORKBUN_PRICING = 'https://api.porkbun.com/api/json/v3/pricing/get';
const IANA_BOOTSTRAP = 'https://data.iana.org/rdap/dns.json';
const DAY_MS = 24 * 3600 * 1000;

// RDAP servers missing from the IANA bootstrap. Each entry was probed on 2026-10-08:
// `google.<tld>` -> HTTP 200 with that ldhName AND a nonsense label -> HTTP 404, so the
// server demonstrably answers for the zone (a server that 404s everything, or 200s
// everything — rdap.gg, rdap.mynic.my — would be worse than no server, so those are
// deliberately absent). IANA bootstrap always wins when it has an entry.
const RDAP_OVERRIDES = {
  de: ['https://rdap.denic.de/'],
  us: ['https://rdap.nic.us/'],
  ws: ['https://rdap.website.ws/'],
  io: ['https://rdap.identitydigital.services/rdap/'],
  sh: ['https://rdap.identitydigital.services/rdap/'],
  me: ['https://rdap.identitydigital.services/rdap/'],
  ac: ['https://rdap.identitydigital.services/rdap/'],
  lc: ['https://rdap.identitydigital.services/rdap/'],
  mn: ['https://rdap.identitydigital.services/rdap/'],
  vc: ['https://rdap.identitydigital.services/rdap/'],
  ag: ['https://rdap.identitydigital.services/rdap/'],
  sc: ['https://rdap.identitydigital.services/rdap/'],
  bz: ['https://rdap.identitydigital.services/rdap/'],
};

const WHOIS_URL = 'https://api.whois.vu/';

const defaultSleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Hard wall-clock cap for ONE lookup, retries and Retry-After sleeps included. The http client's
 * timeoutMs is per attempt only, so without this a throttled source (measured: api.whois.vu hung
 * >60 s and then answered a 504 HTML page) can stall a whole run. fn receives an AbortSignal and
 * should pass it to the client; the race guarantees we return even if fn ignores it.
 * Rejects with err.timeout === true.
 */
async function timed(ms, fn) {
  const ctl = new AbortController();
  let timer;
  const limit = new Promise((_, reject) => {
    timer = setTimeout(() => {
      ctl.abort();
      reject(
        Object.assign(new Error(`timed out after ${Math.round(ms / 100) / 10}s`), { timeout: true })
      );
    }, ms);
  });
  try {
    return await Promise.race([fn(ctl.signal), limit]);
  } finally {
    clearTimeout(timer);
  }
}

const errText = (err) =>
  err?.status ? `HTTP ${err.status}` : String(err?.message || err).slice(0, 80);

/** Read cache file if fresher than ttlMs; null otherwise (missing, stale, corrupt). */
async function readCache(fs, file, ttlMs, now) {
  try {
    const st = await fs.stat(file);
    const mtime = st.mtimeMs ?? (st.mtime ? new Date(st.mtime).getTime() : 0);
    if (!mtime || now() - mtime > ttlMs) return null;
    return JSON.parse(await fs.readFile(file, 'utf8'));
  } catch (_) {
    return null;
  }
}
async function writeCache(fs, dir, file, data) {
  try {
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(file, JSON.stringify(data));
  } catch (_) {
    /* a cache that cannot be written only costs one refetch */
  }
}

// ── TLD universe ─────────────────────────────────────────────────────────────
/**
 * snapshot (default): the shipped 636-suffix Porkbun bulk-search list — offline and
 *   deterministic. live: Porkbun's public pricing endpoint (no key), a superset that
 *   also carries registration prices; cached 24 h. Returns { tlds, source, prices }.
 */
async function loadTlds({
  live,
  fs,
  api,
  snapshotPath,
  cacheDir,
  noCache,
  now = Date.now,
  capMs = 30000,
}) {
  if (!live) {
    const text = await fs.readFile(snapshotPath, 'utf8');
    return { tlds: parseTldList(text), source: 'snapshot:tlds-porkbun-2026-09-24', prices: {} };
  }
  const file = `${cacheDir}/porkbun-pricing.json`;
  let data = noCache ? null : await readCache(fs, file, DAY_MS, now);
  if (!data) {
    const res = await timed(capMs, (signal) => api.post(PORKBUN_PRICING, { body: {}, signal }));
    if (!res || res.status !== 'SUCCESS' || !res.pricing)
      throw new Error('Porkbun pricing endpoint returned no pricing table');
    data = res;
    await writeCache(fs, cacheDir, file, data);
  }
  const prices = {};
  const tlds = [];
  for (const [tld, p] of Object.entries(data.pricing)) {
    const n = toAscii(tld);
    if (!n) continue;
    tlds.push(n);
    const usd = Number.parseFloat(p?.registration);
    if (Number.isFinite(usd)) prices[n] = usd;
  }
  return { tlds, source: 'live:porkbun-pricing-api', prices };
}

// ── Instant Domain Search ────────────────────────────────────────────────────
/**
 * Local memory of IDS answers. WHY: measured 2026-10-08 — IDS grades trust=high only the
 * FIRST time a name is asked in a cache window; any later ask, even in a different request,
 * comes back trust=medium (fresh 30-name set: 29 high; same set again: 0 high; 35-60 min
 * later: still medium). So asking twice silently downgrades a good answer. We therefore
 * (a) never re-ask a name whose high-trust answer we hold and (b) keep the best answer seen.
 * Entries: domain -> { availability, trust, ts }. ttlMs <= 0 disables the cache.
 */
function createIdsCache({ fs, file, dir, ttlMs, now = Date.now }) {
  let data = null;
  let dirty = false;
  const rank = { high: 3, medium: 2, low: 1, none: 0 };
  async function load() {
    if (data) return data;
    data = {};
    if (ttlMs > 0) {
      try {
        const j = JSON.parse(await fs.readFile(file, 'utf8'));
        if (j && typeof j === 'object') data = j;
      } catch (_) {
        /* no cache yet */
      }
    }
    return data;
  }
  return {
    enabled: ttlMs > 0,
    /** Fresh high-trust entry or null. */
    async get(domain) {
      if (ttlMs <= 0) return null;
      const e = (await load())[domain];
      if (!e || now() - e.ts > ttlMs || e.trust !== 'high') return null;
      return {
        availability: e.availability,
        trust: e.trust,
        cached: true,
        ageSec: Math.round((now() - e.ts) / 1000),
      };
    },
    /** Merge a fresh answer; returns the one to use (a degraded repeat ask yields the older high one). */
    async merge(domain, fresh) {
      if (ttlMs <= 0 || fresh.availability === 'error') return fresh;
      const d = await load();
      const old = d[domain];
      const oldFresh = old && now() - old.ts <= ttlMs;
      if (
        oldFresh &&
        old.availability === fresh.availability &&
        (rank[old.trust] ?? 0) > (rank[fresh.trust] ?? 0)
      ) {
        return {
          availability: old.availability,
          trust: old.trust,
          cached: true,
          ageSec: Math.round((now() - old.ts) / 1000),
        };
      }
      d[domain] = { availability: fresh.availability, trust: fresh.trust, ts: now() };
      dirty = true;
      return fresh;
    },
    async save() {
      if (!dirty || ttlMs <= 0) return;
      try {
        await fs.mkdir(dir, { recursive: true });
        const d = data;
        for (const k of Object.keys(d)) if (now() - d[k].ts > ttlMs) delete d[k];
        await fs.writeFile(file, JSON.stringify(d));
      } catch (_) {
        /* losing the cache only costs a trust downgrade next time */
      }
      dirty = false;
    },
  };
}

/**
 * `api` = http.client({ baseUrl: 'https://instantdomainsearch.com', retry, timeoutMs }).
 * check(domains) -> Map(domain -> { availability, trust } | { availability:'error', error }).
 * A name the API silently drops comes back as availability 'missing' (that is what the
 * 191 "missing" rows in the 2026-09-24 CSV were — usually multi-label suffixes).
 */
function createIds({
  api,
  cache,
  sleep = defaultSleep,
  delayMs = 250,
  batchSize = IDS_BATCH,
  capMs = 30000,
}) {
  const stats = { checkCalls: 0, bulkCalls: 0, errors: 0, cacheHits: 0 };

  async function check(allDomains) {
    const results = new Map();
    const domains = [];
    for (const d of allDomains) {
      const hit = cache ? await cache.get(d) : null;
      if (hit) {
        results.set(d, hit);
        stats.cacheHits++;
      } else domains.push(d);
    }
    // One batch; on HTTP 400 (the API rejects the WHOLE batch for one bad name) bisect so a single
    // bad name costs O(log n) extra calls instead of turning 100 answers into 100 errors.
    async function askBatch(batch) {
      const names = batch.join(',');
      try {
        stats.checkCalls++;
        const res = await timed(capMs, (signal) =>
          api.get('/services/check', {
            params: { names, hash: hashCode(names, CHECK_SEED) },
            signal,
          })
        );
        const list = Array.isArray(res?.results) ? res.results : null;
        if (!list) throw new Error('response has no results array');
        const byName = new Map();
        for (const r of list) {
          const key =
            toAscii(
              String(r.name || '')
                .trim()
                .toLowerCase()
            ) || String(r.name || '').toLowerCase();
          byName.set(key, { availability: String(r.availability), trust: String(r.trust) });
        }
        for (const d of batch) {
          const fresh = byName.get(d) || { availability: 'missing', trust: 'none' };
          results.set(d, cache ? await cache.merge(d, fresh) : fresh);
        }
      } catch (err) {
        if (err?.status === 400 && batch.length > 1) {
          const mid = Math.ceil(batch.length / 2);
          await askBatch(batch.slice(0, mid));
          await askBatch(batch.slice(mid));
          return;
        }
        stats.errors++;
        const msg = err?.status
          ? `HTTP ${err.status}${err.body && typeof err.body === 'string' ? ` ${err.body.slice(0, 60)}` : ''}`
          : err?.message || String(err);
        for (const d of batch) results.set(d, { availability: 'error', trust: 'none', error: msg });
      }
    }
    for (let i = 0; i < domains.length; i += batchSize) {
      await askBatch(domains.slice(i, i + batchSize));
      if (i + batchSize < domains.length) await sleep(delayMs);
    }
    if (cache) await cache.save();
    return results;
  }

  /**
   * bulk(label, tlds) -> Map(tld -> { registered, premiumUsd }). Best-effort: any failure
   * yields an empty map, because this call only ENRICHES (premium price, a second opinion
   * on registration) and must never turn a good answer into an error.
   */
  async function bulk(label, tlds) {
    const out = new Map();
    try {
      stats.bulkCalls++;
      const res = await timed(capMs, (signal) =>
        api.post('/services/bulk-check', {
          body: { names: [{ name: label, hash: hashCode(label, BULK_SEED), tlds }] },
          signal,
        })
      );
      for (const r of res?.results || []) {
        const tld = toAscii(String(r.tld || '').toLowerCase()) || String(r.tld || '').toLowerCase();
        const cents = r.premium?.is_premium ? Number(r.premium.usd_cents) : null;
        out.set(tld, {
          registered: typeof r.isRegistered === 'boolean' ? r.isRegistered : null,
          premiumUsd: Number.isFinite(cents) ? cents / 100 : null,
        });
      }
    } catch (_) {
      stats.errors++;
    }
    return out;
  }

  return { check, bulk, stats };
}

// ── RDAP ─────────────────────────────────────────────────────────────────────
/** Load the IANA bootstrap as Map(tld -> [base urls]); cached 24 h. */
async function loadBootstrap({ fs, api, cacheDir, noCache, now = Date.now, capMs = 30000 }) {
  const file = `${cacheDir}/iana-rdap-dns.json`;
  let data = noCache ? null : await readCache(fs, file, DAY_MS, now);
  if (!data) {
    data = await timed(capMs, (signal) => api.get(IANA_BOOTSTRAP, { signal }));
    if (typeof data === 'string') data = JSON.parse(data);
    if (!Array.isArray(data?.services))
      throw new Error('IANA RDAP bootstrap has no services array');
    await writeCache(fs, cacheDir, file, data);
  }
  const map = new Map();
  for (const [tlds, urls] of data.services) for (const t of tlds) map.set(t.toLowerCase(), urls);
  return map;
}

function pickBase(urls) {
  const u = urls.find((x) => x.startsWith('https://')) || urls[0];
  return u.endsWith('/') ? u : `${u}/`;
}

/**
 * `api` = http.client({ retry: {on:[429,502,503], maxAttempts:3}, timeoutMs, headers:{Accept:'application/rdap+json'} }).
 * Politeness: at most `perHost` in flight per registry host, `spacingMs` between request
 * starts to one host, and a circuit breaker that stops hammering a host after
 * `breakAfter` consecutive throttle/network failures (remaining names become inconclusive).
 */
function createRdap({
  api,
  bootstrap,
  overrides = RDAP_OVERRIDES,
  perHost = 2,
  spacingMs = 200,
  breakAfter = 3,
  sleep = defaultSleep,
  capMs = 15000,
}) {
  const gates = new Map();
  const stats = { calls: 0, throttled: 0, skippedHosts: new Set() };

  function serverFor(tld) {
    const last = tld.split('.').pop();
    for (const key of [tld, last]) {
      const urls = bootstrap.get(key);
      if (urls?.length) return { base: pickBase(urls), via: 'iana' };
    }
    const o = overrides[last];
    if (o) return { base: pickBase(o), via: 'override' };
    return null;
  }

  async function gated(host, fn) {
    let g = gates.get(host);
    if (!g) {
      g = { active: 0, waiters: [], next: 0, failures: 0, open: false };
      gates.set(host, g);
    }
    if (g.open) return { skipped: true };
    while (g.active >= perHost) await new Promise((r) => g.waiters.push(r));
    g.active++;
    try {
      if (g.open) return { skipped: true };
      const wait = g.next - Date.now();
      g.next = Math.max(Date.now(), g.next) + spacingMs;
      if (wait > 0) await sleep(wait);
      const res = await fn();
      g.failures = res.transient ? g.failures + 1 : 0;
      if (g.failures >= breakAfter) {
        g.open = true;
        stats.skippedHosts.add(host);
      }
      return res;
    } finally {
      g.active--;
      const w = g.waiters.shift();
      if (w) w();
    }
  }

  function parseBody(body) {
    let b = body;
    if (typeof b === 'string') {
      try {
        b = JSON.parse(b);
      } catch (_) {
        b = {};
      }
    }
    const events = Array.isArray(b?.events) ? b.events : [];
    const exp = events.find((e) => e.eventAction === 'expiration');
    return { expires: exp?.eventDate || null, state: Array.isArray(b?.status) ? b.status : [] };
  }

  /** lookup(domain, tld, { capMs? }) -> { status, httpStatus?, server?, via?, expires?, state?, error? } */
  async function lookup(domain, tld, o = {}) {
    const cap = o.capMs || capMs;
    const srv = serverFor(tld);
    if (!srv) return { status: 'no-server' };
    const url = `${srv.base}domain/${encodeURIComponent(domain)}`;
    const host = new URL(srv.base).host;
    const res = await gated(host, async () => {
      stats.calls++;
      try {
        const r = await timed(cap, (signal) => api.get(url, { raw: true, signal }));
        return {
          transient: false,
          value: { status: 'registered', httpStatus: r.status, ...parseBody(r.body) },
        };
      } catch (err) {
        const code = err?.status;
        if (code === 404)
          return { transient: false, value: { status: 'unregistered', httpStatus: 404 } };
        if (code === 429) stats.throttled++;
        const transient = !code || code === 429 || code >= 500;
        return {
          transient,
          value: { status: 'inconclusive', httpStatus: code || null, error: errText(err) },
        };
      }
    });
    if (res.skipped)
      return {
        status: 'inconclusive',
        server: host,
        via: srv.via,
        error: 'host backed off after repeated failures',
      };
    return { server: host, via: srv.via, ...res.value };
  }

  return { lookup, serverFor, stats };
}

// ── WHOIS over HTTP (conservative fallback) ──────────────────────────────────
/**
 * api.whois.vu — a public, keyless JSON front-end to WHOIS: GET https://api.whois.vu/?q=<domain>
 * -> {"domain","available":"yes"|"no","type","whois":"<raw text>"}.  PRIVACY: the queried domain
 * name is sent to this third party. Measured 2026-10-08: ~0.6–1.4 s typical, but one call hung
 * >60 s and ended in an nginx 504 HTML page — hence the hard cap, the breaker and the call limit.
 *
 * Why the raw text is inspected instead of trusting `available`: for live.nagoya the service
 * answered available:"no" while its WHOIS text was only a notice that the registry RETIRED WHOIS
 * for RDAP. A bare "no" is therefore NOT evidence of registration. Mapping:
 *   "no"  + registration data in the text (Registrar:/Name servers:/Creation Date:…) -> registered
 *   "yes" and the text is not a service notice                                           -> unregistered (weak)
 *   anything else (notice, rate limit, retired, mismatched domain, 5xx, HTML, timeout)   -> inconclusive
 * Never produces more than unregistered-needs-confirmation (see classify.js).
 */
const WHOIS_NOTICE_RE =
  /\b(retired|discontinued|no longer|deprecated|rate[- ]?limit|too many|quota|query limit|limit exceeded|access denied|forbidden|try again|temporarily|not supported|unsupported|rdap)\b/i;
const WHOIS_DATA_RE =
  /^\s*(registrar|name servers?|nserver|creat(?:ed|ion date)|registry domain id|registrant|domain name|domain)\b\s*:/im;

function interpretWhois(body, domain) {
  let j = body;
  if (typeof j === 'string') {
    try {
      j = JSON.parse(j);
    } catch (_) {
      return { status: 'inconclusive', error: 'non-JSON response' };
    }
  }
  if (!j || typeof j !== 'object') return { status: 'inconclusive', error: 'empty response' };
  const answered =
    toAscii(
      String(j.domain || '')
        .trim()
        .toLowerCase()
    ) || String(j.domain || '').toLowerCase();
  if (answered !== domain)
    return { status: 'inconclusive', error: `answered for "${j.domain}" not "${domain}"` };
  const text = typeof j.whois === 'string' ? j.whois : '';
  const notice = WHOIS_NOTICE_RE.test(text);
  const av = String(j.available || '').toLowerCase();
  if (av === 'no') {
    if (!notice && WHOIS_DATA_RE.test(text)) return { status: 'registered', answer: 'no' };
    return {
      status: 'inconclusive',
      answer: 'no',
      error: notice
        ? 'available:"no" but the text is a service notice, not registration data'
        : 'available:"no" without registration data in the text',
    };
  }
  if (av === 'yes') {
    if (notice)
      return {
        status: 'inconclusive',
        answer: 'yes',
        error: 'available:"yes" but the text is a service notice',
      };
    return { status: 'unregistered', answer: 'yes' };
  }
  return { status: 'inconclusive', error: `unrecognised available:"${j.available}"` };
}

/**
 * `api` = http.client({ timeoutMs }) (no baseUrl; absolute URL used). Sequential by construction:
 * one request at a time, `spacingMs` between starts (default 1 s), at most `maxCalls` per run
 * (further names are skipped as inconclusive, which also bounds how many names are disclosed),
 * and a breaker that stops after `breakAfter` consecutive transient failures.
 */
function createWhois({
  api,
  url = WHOIS_URL,
  spacingMs = 1000,
  maxCalls = 25,
  breakAfter = 2,
  capMs = 15000,
  sleep = defaultSleep,
}) {
  const stats = { calls: 0, skippedOverLimit: 0, broken: false, sent: [] };
  let chain = Promise.resolve();
  let last = 0;
  let failures = 0;

  async function one(domain) {
    if (stats.broken)
      return {
        status: 'inconclusive',
        server: 'api.whois.vu',
        error: 'backed off after repeated failures',
      };
    if (stats.calls >= maxCalls) {
      stats.skippedOverLimit++;
      return {
        status: 'inconclusive',
        server: 'api.whois.vu',
        error: `--whois-max ${maxCalls} reached`,
      };
    }
    const wait = last + spacingMs - Date.now();
    if (wait > 0) await sleep(wait);
    last = Date.now();
    stats.calls++;
    stats.sent.push(domain);
    try {
      const r = await timed(capMs, (signal) => api.get(url, { params: { q: domain }, signal }));
      failures = 0;
      return { server: 'api.whois.vu', ...interpretWhois(r, domain) };
    } catch (err) {
      const code = err?.status;
      const transient = !code || code === 429 || code >= 500;
      failures = transient ? failures + 1 : 0;
      if (failures >= breakAfter) stats.broken = true;
      return {
        status: 'inconclusive',
        server: 'api.whois.vu',
        httpStatus: code || null,
        error: errText(err),
      };
    }
  }

  /** lookup(domain) -> { status, server, answer?, httpStatus?, error? }; calls are serialised. */
  function lookup(domain) {
    const p = chain.then(() => one(domain));
    chain = p.catch(() => {});
    return p;
  }
  return { lookup, interpret: interpretWhois, stats };
}

// ── DNS (weaker final fallback) ────────────────────────────────────────────────────────
/**
 * `run(argv) -> Promise<{stdout, exitCode}>` (sliccy:exec.spawn). Uses the built-in
 * `dig <name> NS --json` (DoH under the hood). A failure on the first call trips a
 * breaker so a blocked DoH path costs one call, not hundreds.
 */
function createDns({ run, capMs = 8000 }) {
  let broken = null;
  const stats = { calls: 0 };

  function interpret(stdout) {
    let j;
    try {
      j = JSON.parse(stdout);
    } catch (_) {
      return null;
    }
    const answers = [...(j.Answer || j.answer || []), ...(j.answers || [])];
    if (answers.some((a) => a.type === 2 || a.type === 'NS')) return 'delegated';
    const status = j.Status ?? j.status ?? j.rcode;
    if (status === 3 || status === 'NXDOMAIN') return 'undelegated';
    if (status === 0 || status === 'NOERROR') return 'undelegated';
    return null;
  }

  async function lookup(domain) {
    if (broken) return { status: 'unavailable', error: broken };
    stats.calls++;
    try {
      const r = await timed(capMs, () => run(['dig', domain, 'NS', '--json']));
      const verdict = r.exitCode === 0 ? interpret(r.stdout) : null;
      if (verdict) return { status: verdict };
      broken = (r.stderr || r.stdout || `dig exit ${r.exitCode}`)
        .toString()
        .trim()
        .split('\n')[0]
        .slice(0, 100);
    } catch (err) {
      broken = String(err?.message || err).slice(0, 100);
    }
    return { status: 'unavailable', error: broken };
  }
  return { lookup, interpret, stats };
}

module.exports = {
  DAY_MS,
  IANA_BOOTSTRAP,
  IDS_BATCH,
  PORKBUN_PRICING,
  RDAP_OVERRIDES,
  WHOIS_URL,
  createDns,
  createIds,
  createIdsCache,
  createRdap,
  createWhois,
  interpretWhois,
  loadBootstrap,
  loadTlds,
  timed,
};

// tst suite for the pure modules behind domain-hoarding.jsh.
//
//   tst skills/domain-hoarding/tests/domain-hoarding.test.js
//
// Offline and deterministic: every network source is an injected fake. Imports are
// literal relative specifiers (CLAUDE.md §16). The assertions that matter most are the
// ones that pin the tier rules — in particular "RDAP 404 is never available".

import test, { is, ok, throws } from 'tst';
import * as argvMod from '../scripts/argv.js';
import * as classifyMod from '../scripts/classify.js';
import * as domainsMod from '../scripts/domains.js';
import * as pipelineMod from '../scripts/pipeline.js';
import * as renderMod from '../scripts/render.js';
import * as sourcesMod from '../scripts/sources.js';

const { parseArgv, parseList, scanTlds } = argvMod.default || argvMod;
const { TIERS, classify, glyph } = classifyMod.default || classifyMod;
const {
  hashCode,
  normalizeLabel,
  normalizeTld,
  parseDomainFile,
  parseTldList,
  splitDomain,
  splitCsvLine,
} = domainsMod.default || domainsMod;
const { gather, matrix, noAnswer, summarize } = pipelineMod.default || pipelineMod;
const { toCsv, toJson, humanScan, humanCheck } = renderMod.default || renderMod;
const { createDns, createIds, createIdsCache, createRdap, createWhois, interpretWhois, timed } =
  sourcesMod.default || sourcesMod;

const SUFFIXES = new Set(['com', 'net', 'co.uk', 'uk', 'zip', 'ac.nz', 'nz']);
const seqPool = async (_n, items, fn) => {
  const out = [];
  for (const it of items) out.push(await fn(it));
  return out;
};

// ── argv ─────────────────────────────────────────────────────────────────────
test('--json before a domain does not swallow it', () => {
  const r = parseArgv(['check', '--json', 'live.zip']);
  is(r.flags.json, true);
  is(r.positional, ['check', 'live.zip']);
});
test('value flags accept = and space forms', () => {
  is(parseArgv(['scan', 'a', '--tlds=com,net']).flags.tlds, 'com,net');
  is(parseArgv(['scan', 'a', '--tlds', 'com,net']).flags.tlds, 'com,net');
});
test('unknown flag is an error, not ignored', () => {
  throws(() => parseArgv(['scan', 'a', '--tld', 'com']));
});
test('value flag without a value is an error', () => {
  throws(() => parseArgv(['scan', 'a', '--tlds']));
  throws(() => parseArgv(['scan', 'a', '--tlds', '--json']));
});
test('-h and -q aliases', () => {
  const r = parseArgv(['-h', '-q']);
  is(r.flags.help, true);
  is(r.flags.quiet, true);
});
test('parseList splits commas and whitespace', () => {
  is(parseList('com, net  org,,io'), ['com', 'net', 'org', 'io']);
});

// ── domains ──────────────────────────────────────────────────────────────────
test('hashCode matches the values captured from the live site', () => {
  is(hashCode('live', 42), '42109974');
  is(hashCode('live.zip', 27), '-140062662');
});
test('normalizeLabel lowercases, punycodes, rejects dots and junk', () => {
  is(normalizeLabel(' Live '), 'live');
  is(normalizeLabel('bücher'), 'xn--bcher-kva');
  throws(() => normalizeLabel('live.com'));
  throws(() => normalizeLabel('-bad'));
  throws(() => normalizeLabel('has space'));
  throws(() => normalizeLabel(''));
  throws(() => normalizeLabel('a'.repeat(64)));
});
test('normalizeTld strips dots and keeps multi-label suffixes', () => {
  is(normalizeTld('.COM'), 'com');
  is(normalizeTld('co.uk'), 'co.uk');
  is(normalizeTld('рф'), 'xn--p1ai');
  throws(() => normalizeTld('bad_tld'));
});
test('splitDomain picks the longest known suffix', () => {
  const d = splitDomain('live.co.uk', SUFFIXES);
  is(d.domain, 'live.co.uk');
  is(d.label, 'live');
  is(d.tld, 'co.uk');
  is(d.tldKnown, true);
});
test('splitDomain strips scheme, path, port, www-style subdomains (with a note)', () => {
  const d = splitDomain('https://www.Live.com:8080/x?y#z', SUFFIXES);
  is(d.domain, 'live.com');
  ok(/subdomain "www" ignored/.test(d.note));
});
test('splitDomain flags unknown TLDs and refuses bare labels', () => {
  is(splitDomain('live.nope', SUFFIXES).tldKnown, false);
  throws(() => splitDomain('live', SUFFIXES));
  throws(() => splitDomain('', SUFFIXES));
});
test('parseTldList ignores comments/blank lines and dedupes', () => {
  is(parseTldList('# hi\ncom\n\n.net # trailing\ncom\n'), ['com', 'net']);
});
test('parseDomainFile reads plain lists and CSVs with a domain column', () => {
  is(parseDomainFile('live.zip\n# c\npage.dad\n'), ['live.zip', 'page.dad']);
  is(parseDomainFile('domain,prefix,tld\nlive.ac,live,ac\npage.zip,page,zip\n'), [
    'live.ac',
    'page.zip',
  ]);
});

// ── classify: the tier rules ─────────────────────────────────────────────────
test('RDAP 404 alone is NEVER available', () => {
  const c = classify({ rdap: { status: 'unregistered' } });
  is(c.tier, TIERS.UNREGISTERED);
  is(c.available, false);
});
test('IDS available + trust high is the only route to available-high-confidence', () => {
  const c = classify({ ids: { availability: 'available', trust: 'high' } });
  is(c.tier, TIERS.AVAILABLE);
  is(c.available, true);
  is(c.premium, null); // no bulk answer: standard price is NOT claimed
});
test('IDS available + trust medium/low stays unregistered-needs-confirmation', () => {
  is(classify({ ids: { availability: 'available', trust: 'medium' } }).tier, TIERS.UNREGISTERED);
  is(classify({ ids: { availability: 'available', trust: 'low' } }).tier, TIERS.UNREGISTERED);
});
test('IDS available/high + RDAP unregistered is still only high-confidence available (RDAP adds nothing)', () => {
  is(
    classify({
      ids: { availability: 'available', trust: 'high' },
      rdap: { status: 'unregistered' },
    }).tier,
    TIERS.AVAILABLE
  );
});
test('inuse/reserved/blocked are taken at any trust level', () => {
  for (const a of ['inuse', 'reserved', 'blocked'])
    is(classify({ ids: { availability: a, trust: 'low' } }).tier, TIERS.TAKEN);
});
test('RDAP registered beats IDS available and is flagged as a conflict', () => {
  const c = classify({
    ids: { availability: 'available', trust: 'high' },
    rdap: { status: 'registered' },
  });
  is(c.tier, TIERS.TAKEN);
  is(c.conflict, true);
});
test('premium stays AVAILABLE (registrable) and is flagged premium, never "free of cost"', () => {
  const c = classify({
    ids: { availability: 'available', trust: 'high' },
    bulk: { registered: false, premiumUsd: 499 },
  });
  is(c.tier, TIERS.AVAILABLE);
  is(c.available, true);
  is(c.premium, true);
  is(c.premiumUsd, 499);
  ok(c.reason.includes('PREMIUM'));
  is(
    classify({
      ids: { availability: 'available', trust: 'high' },
      bulk: { registered: false, premiumUsd: null },
    }).premium,
    false
  );
});
test('bulk endpoint saying registered downgrades available/high to inconclusive', () => {
  const c = classify({
    ids: { availability: 'available', trust: 'high' },
    bulk: { registered: true, premiumUsd: null },
  });
  is(c.tier, TIERS.INCONCLUSIVE);
  is(c.conflict, true);
});
test('unsupported/missing IDS with no RDAP server is inconclusive, not unregistered', () => {
  is(
    classify({ ids: { availability: 'unsupported', trust: 'low' }, rdap: { status: 'no-server' } })
      .tier,
    TIERS.INCONCLUSIVE
  );
  is(classify({ ids: { availability: 'missing', trust: 'none' } }).tier, TIERS.INCONCLUSIVE);
});
test('DNS delegation means taken; DNS NXDOMAIN is only a weak unregistered signal', () => {
  is(classify({ dns: { status: 'delegated' } }).tier, TIERS.TAKEN);
  is(classify({ dns: { status: 'undelegated' } }).tier, TIERS.UNREGISTERED);
  is(classify({ dns: { status: 'unavailable' } }).tier, TIERS.INCONCLUSIVE);
});
test('IDS error with nothing else is inconclusive and says why', () => {
  const c = classify({ ids: { availability: 'error', error: 'HTTP 429' } });
  is(c.tier, TIERS.INCONCLUSIVE);
  ok(c.reason.includes('HTTP 429'));
});
test('WHOIS: "no" is taken, "yes" is only unregistered-needs-confirmation, neither beats IDS available/high', () => {
  is(
    classify({
      ids: { availability: 'unsupported', trust: 'low' },
      rdap: { status: 'no-server' },
      whois: { status: 'registered' },
    }).tier,
    TIERS.TAKEN
  );
  const y = classify({
    ids: { availability: 'unsupported', trust: 'low' },
    rdap: { status: 'no-server' },
    whois: { status: 'unregistered' },
  });
  is(y.tier, TIERS.UNREGISTERED);
  is(y.available, false);
  const c = classify({
    ids: { availability: 'available', trust: 'high' },
    whois: { status: 'registered' },
  });
  is(c.tier, TIERS.INCONCLUSIVE);
  is(c.conflict, true);
  const d = classify({
    ids: { availability: 'available', trust: 'high' },
    dns: { status: 'delegated' },
  });
  is(d.tier, TIERS.INCONCLUSIVE);
  is(d.conflict, true);
});
test('precedence: RDAP registered > IDS taken > weak taken > IDS high > IDS lower > RDAP/WHOIS/DNS weak > inconclusive', () => {
  is(
    classify({ ids: { availability: 'inuse', trust: 'high' }, rdap: { status: 'unregistered' } })
      .tier,
    TIERS.TAKEN
  );
  is(
    classify({
      ids: { availability: 'reserved', trust: 'high' },
      whois: { status: 'unregistered' },
    }).tier,
    TIERS.TAKEN
  );
  is(
    classify({
      ids: { availability: 'available', trust: 'medium' },
      whois: { status: 'registered' },
    }).tier,
    TIERS.TAKEN
  );
  is(
    classify({
      ids: { availability: 'available', trust: 'medium' },
      rdap: { status: 'unregistered' },
    }).tier,
    TIERS.UNREGISTERED
  );
  is(
    classify({ rdap: { status: 'unregistered' }, whois: { status: 'registered' } }).tier,
    TIERS.TAKEN
  );
  is(
    classify({ whois: { status: 'inconclusive' }, dns: { status: 'unavailable' } }).tier,
    TIERS.INCONCLUSIVE
  );
  is(classify({}).tier, TIERS.INCONCLUSIVE);
});
test('glyphs', () => {
  is(glyph({ tier: TIERS.AVAILABLE, premium: false }), '✓');
  is(glyph({ tier: TIERS.AVAILABLE, premium: null }), '✓');
  is(glyph({ tier: TIERS.AVAILABLE, premium: true }), '$');
  is(glyph({ tier: TIERS.UNREGISTERED }), '?');
  is(glyph({ tier: TIERS.TAKEN }), '✗');
  is(glyph({ tier: TIERS.INCONCLUSIVE }), '~');
});

// ── sources with fakes ───────────────────────────────────────────────────────
test('IDS check sends comma-joined names with the seed-27 hash and maps results by name', async () => {
  const calls = [];
  const api = {
    get: async (path, o) => {
      calls.push({ path, o });
      return { results: [{ name: 'live.zip', availability: 'available', trust: 'high' }] };
    },
  };
  const ids = createIds({ api, sleep: async () => {} });
  const res = await ids.check(['live.zip', 'live.xyz']);
  is(calls[0].path, '/services/check');
  is(calls[0].o.params.names, 'live.zip,live.xyz');
  is(calls[0].o.params.hash, hashCode('live.zip,live.xyz', 27));
  is(res.get('live.zip'), { availability: 'available', trust: 'high' });
  is(res.get('live.xyz'), { availability: 'missing', trust: 'none' }); // dropped by the API
});
test('IDS check batches at 100 names', async () => {
  let n = 0;
  const api = {
    get: async () => {
      n++;
      return { results: [] };
    },
  };
  const ids = createIds({ api, sleep: async () => {} });
  await ids.check(Array.from({ length: 250 }, (_, i) => `a${i}.com`));
  is(n, 3);
});
test('IDS HTTP failure becomes an error evidence row, not a throw', async () => {
  const api = {
    get: async () => {
      const e = new Error('x');
      e.status = 429;
      throw e;
    },
  };
  const ids = createIds({ api, sleep: async () => {} });
  const r = (await ids.check(['live.zip'])).get('live.zip');
  is(r.availability, 'error');
  ok(r.error.includes('429'));
});
test('IDS bulk reads premium cents and isRegistered; failure yields an empty map', async () => {
  const api = {
    post: async () => ({
      results: [
        { tld: 'dad', isRegistered: false, premium: { is_premium: true, usd_cents: 49900 } },
        { tld: 'tech', isRegistered: false },
      ],
    }),
  };
  const ids = createIds({ api, sleep: async () => {} });
  const m = await ids.bulk('page', ['dad', 'tech']);
  is(m.get('dad'), { registered: false, premium: true, premiumUsd: 499 });
  is(m.get('tech'), { registered: false, premium: false, premiumUsd: null });
  const bad = createIds({
    api: {
      post: async () => {
        throw new Error('boom');
      },
    },
    sleep: async () => {},
  });
  is((await bad.bulk('page', ['dad'])).size, 0);
});

function fakeRdap(map, extra = {}) {
  const hits = [];
  const api = {
    get: async (url) => {
      hits.push(url);
      const v = map[url];
      if (v === undefined) {
        const e = new Error('nf');
        e.status = 404;
        throw e;
      }
      if (v instanceof Error) throw v;
      return { status: 200, body: v };
    },
  };
  const bootstrap = new Map([
    ['zip', ['https://rdap.zip.example/']],
    ['com', ['http://rdap.com.example/', 'https://rdap.com.example/']],
  ]);
  return {
    rdap: createRdap({ api, bootstrap, spacingMs: 0, sleep: async () => {}, ...extra }),
    hits,
  };
}
test('RDAP: 200 registered with expiry, 404 unregistered, https preferred', async () => {
  const { rdap, hits } = fakeRdap({
    'https://rdap.com.example/domain/a.com': {
      events: [{ eventAction: 'expiration', eventDate: '2028-01-02T00:00:00Z' }],
      status: ['active'],
    },
  });
  const a = await rdap.lookup('a.com', 'com');
  is(a.status, 'registered');
  is(a.expires, '2028-01-02T00:00:00Z');
  is((await rdap.lookup('b.com', 'com')).status, 'unregistered');
  ok(hits.every((u) => u.startsWith('https://')));
});
test('RDAP: no server -> no-server; override used only when IANA has none', async () => {
  const { rdap } = fakeRdap({});
  is((await rdap.lookup('a.ac.nz', 'ac.nz')).status, 'no-server');
  is(rdap.serverFor('de').via, 'override');
  is(rdap.serverFor('com').via, 'iana');
});
test('RDAP: multi-label suffix falls back to the last label for the server', async () => {
  const { rdap } = fakeRdap({});
  ok(rdap.serverFor('co.zip').base.startsWith('https://rdap.zip.example'));
});
test('RDAP: 5xx is inconclusive; circuit breaker stops hammering a failing host', async () => {
  const err = new Error('x');
  err.status = 503;
  const map = {};
  for (const n of ['a', 'b', 'c', 'd', 'e']) map[`https://rdap.zip.example/domain/${n}.zip`] = err;
  const { rdap, hits } = fakeRdap(map, { breakAfter: 3 });
  const out = [];
  for (const n of ['a', 'b', 'c', 'd', 'e']) out.push(await rdap.lookup(`${n}.zip`, 'zip'));
  is(out[0].status, 'inconclusive');
  is(hits.length, 3);
  ok(out[4].error.includes('backed off'));
});
test('DNS: NS answer -> delegated; NXDOMAIN -> undelegated; tool failure trips the breaker once', async () => {
  let calls = 0;
  const dns = createDns({
    run: async () => {
      calls++;
      return {
        exitCode: 0,
        stdout: JSON.stringify({ Status: 0, Answer: [{ type: 2, data: 'ns1.x.' }] }),
      };
    },
  });
  is((await dns.lookup('a.com')).status, 'delegated');
  is(calls, 1);
  const nx = createDns({ run: async () => ({ exitCode: 0, stdout: '{"Status":3}' }) });
  is((await nx.lookup('a.com')).status, 'undelegated');
  let n = 0;
  const broken = createDns({
    run: async () => {
      n++;
      return { exitCode: 1, stdout: '', stderr: 'dig: Proxy fetch failed' };
    },
  });
  is((await broken.lookup('a.com')).status, 'unavailable');
  is((await broken.lookup('b.com')).status, 'unavailable');
  is(n, 1);
});

// ── pipeline ─────────────────────────────────────────────────────────────────
function fakeDeps({ idsMap, rdapMap = {}, bulkMap = {} }) {
  const rdapCalls = [];
  return {
    rdapCalls,
    deps: {
      pool: seqPool,
      ids: {
        check: async (ds) =>
          new Map(ds.map((d) => [d, idsMap[d] || { availability: 'missing', trust: 'none' }])),
        bulk: async (_l, tlds) =>
          new Map(tlds.map((t) => [t, bulkMap[t] || { registered: false, premiumUsd: null }])),
      },
      rdap: {
        lookup: async (d) => {
          rdapCalls.push(d);
          return rdapMap[d] || { status: 'no-server' };
        },
      },
      dns: { lookup: async () => ({ status: 'unavailable' }) },
    },
  };
}
const item = (label, tld) => ({ domain: `${label}.${tld}`, label, tld, tldKnown: true });
const SCAN = {
  mode: 'scan',
  rdap: true,
  dns: true,
  premium: true,
  verify: false,
  concurrency: 2,
  prices: {},
};

test('scan skips RDAP for names IDS already settled; check does not', async () => {
  const idsMap = {
    'a.com': { availability: 'inuse', trust: 'medium' },
    'a.xyz': { availability: 'available', trust: 'high' },
    'a.de': { availability: 'unsupported', trust: 'low' },
  };
  const items = [item('a', 'com'), item('a', 'xyz'), item('a', 'de')];
  const s = fakeDeps({ idsMap });
  await gather(items, s.deps, SCAN);
  is(s.rdapCalls, ['a.de']);
  const c = fakeDeps({ idsMap });
  await gather(items, c.deps, { ...SCAN, mode: 'check' });
  is(c.rdapCalls.length, 3);
  const v = fakeDeps({ idsMap });
  await gather(items, v.deps, { ...SCAN, verify: true });
  is(v.rdapCalls.length, 3);
});
test('end-to-end tiers: RDAP 404 on an unsupported TLD stays needs-confirmation', async () => {
  const s = fakeDeps({
    idsMap: { 'a.abogado': { availability: 'unsupported', trust: 'low' } },
    rdapMap: { 'a.abogado': { status: 'unregistered' } },
  });
  const [r] = await gather([item('a', 'abogado')], s.deps, SCAN);
  is(r.tier, TIERS.UNREGISTERED);
  is(r.available, false);
});
test('premium bulk data marks $ and keeps the name AVAILABLE', async () => {
  const s = fakeDeps({
    idsMap: { 'a.dad': { availability: 'available', trust: 'high' } },
    bulkMap: { dad: { registered: false, premiumUsd: 499 } },
  });
  const [r] = await gather([item('a', 'dad')], s.deps, SCAN);
  is(r.tier, TIERS.AVAILABLE);
  is(r.available, true);
  is(r.premium, true);
  is(r.premiumUsd, 499);
});
test('matrix: "all available" INCLUDES premium cells; unregistered, taken and inconclusive disqualify', () => {
  const mk = (label, tld, tier, premium) => ({
    label,
    tld,
    tier,
    premium,
    available: tier === TIERS.AVAILABLE,
  });
  const A = TIERS.AVAILABLE;
  const rows = [
    mk('a', 'one', A, false),
    mk('b', 'one', A, false),
    mk('a', 'two', A, false),
    mk('b', 'two', A, true),
    mk('a', 'three', A, false),
    mk('b', 'three', TIERS.UNREGISTERED, false),
    mk('a', 'four', A, false),
    mk('b', 'four', TIERS.TAKEN, false),
    mk('a', 'five', A, null),
    mk('b', 'five', A, false),
    mk('a', 'six', A, false),
    mk('b', 'six', TIERS.INCONCLUSIVE, null),
  ];
  const m = matrix(rows, ['a', 'b'], ['one', 'two', 'three', 'four', 'five', 'six']);
  is(m.allAvailable, ['one', 'two', 'five']); // premium-but-registrable "two" qualifies
  is(m.allAvailableStandard, ['one']);
  is(m.allAvailableButPremium, ['two']);
  is(m.allAvailableUnchecked, ['five']);
  is(m.allNotTaken, ['one', 'two', 'three', 'five', 'six']);
  const s = summarize(rows);
  is(s.available, 9);
  is(s.premium, 1);
  is(s.premiumUnchecked, 1);
  is(s.standardPrice, 7);
});
test('scan matrix over 3 labels x 4 TLDs end-to-end through gather()', async () => {
  const idsMap = {};
  const A = { availability: 'available', trust: 'high' };
  for (const l of ['live', 'page', 'preview']) {
    idsMap[`${l}.com`] = { availability: 'inuse', trust: 'medium' };
    idsMap[`${l}.dev`] = A;
    idsMap[`${l}.xyz`] = A;
    idsMap[`${l}.tld`] = l === 'preview' ? { availability: 'inuse', trust: 'high' } : A;
  }
  const s = fakeDeps({ idsMap, bulkMap: { xyz: { registered: false, premiumUsd: 250 } } });
  const labels = ['live', 'page', 'preview'];
  const tlds = ['com', 'dev', 'xyz', 'tld'];
  const items = labels.flatMap((l) => tlds.map((t) => item(l, t)));
  const rows = await gather(items, s.deps, SCAN);
  const m = matrix(rows, labels, tlds);
  is(m.allAvailable, ['dev', 'xyz']);
  is(m.allAvailableStandard, ['dev']);
  is(m.allAvailableButPremium, ['xyz']);
  is(s.rdapCalls.length, 0); // IDS settled every cell, so scan asked RDAP nothing
});
test('WHOIS stage runs only for IDS-unsettled names whose RDAP had no server / was inconclusive', async () => {
  const whoisCalls = [];
  const idsMap = {
    'a.de': { availability: 'unsupported', trust: 'low' },
    'b.de': { availability: 'unsupported', trust: 'low' },
    'c.xyz': { availability: 'unsupported', trust: 'low' },
    'd.xyz': { availability: 'available', trust: 'high' },
    'e.com': { availability: 'inuse', trust: 'high' },
  };
  const s = fakeDeps({
    idsMap,
    rdapMap: {
      'a.de': { status: 'no-server' },
      'b.de': { status: 'inconclusive', error: 'HTTP 503' },
      'c.xyz': { status: 'unregistered' },
    },
  });
  s.deps.whois = {
    lookup: async (d) => {
      whoisCalls.push(d);
      return d === 'a.de' ? { status: 'registered' } : { status: 'unregistered' };
    },
  };
  const items = [
    item('a', 'de'),
    item('b', 'de'),
    item('c', 'xyz'),
    item('d', 'xyz'),
    item('e', 'com'),
  ];
  const rows = await gather(items, s.deps, { ...SCAN, whois: true });
  is(whoisCalls, ['a.de', 'b.de']);
  is(
    rows.map((r) => r.tier),
    [TIERS.TAKEN, TIERS.UNREGISTERED, TIERS.UNREGISTERED, TIERS.AVAILABLE, TIERS.TAKEN]
  );
  const off = fakeDeps({ idsMap, rdapMap: { 'a.de': { status: 'no-server' } } });
  off.deps.whois = {
    lookup: async () => {
      throw new Error('must not be called');
    },
  };
  const r2 = await gather([item('a', 'de')], off.deps, { ...SCAN, whois: false });
  is(r2[0].tier, TIERS.INCONCLUSIVE);
});
test('an exhausted time budget leaves names inconclusive with a reason instead of waiting', async () => {
  const s = fakeDeps({ idsMap: { 'a.de': { availability: 'unsupported', trust: 'low' } } });
  s.deps.whois = {
    lookup: async () => {
      throw new Error('must not be called');
    },
  };
  const [r] = await gather([item('a', 'de')], s.deps, {
    ...SCAN,
    whois: true,
    deadline: Date.now() - 1,
  });
  is(r.tier, TIERS.INCONCLUSIVE);
  ok(r.rdap.error.includes('budget'));
  is(s.rdapCalls.length, 0);
});

// ── render ───────────────────────────────────────────────────────────────────
const sampleRow = (over = {}) => ({
  domain: 'live.zip',
  label: 'live',
  tld: 'zip',
  tier: TIERS.AVAILABLE,
  available: true,
  premium: false,
  premiumUsd: null,
  reason: 'Instant, "quoted"',
  ids: { availability: 'available', trust: 'high' },
  rdap: { status: 'unregistered', expires: null },
  dns: null,
  bulk: null,
  ...over,
});
test('CSV has a stable header, quotes commas/quotes, and one line per row', () => {
  const lines = toCsv([
    sampleRow(),
    sampleRow({ domain: 'page.zip', premiumUsd: 249, premium: true }),
  ])
    .trimEnd()
    .split('\n');
  is(lines.length, 3);
  is(
    lines[0],
    'domain,label,tld,tier,available,premium,premium_usd,instant_status,instant_trust,rdap_status,rdap_expires,whois_status,dns_status,porkbun_usd,reason'
  );
  ok(lines[1].endsWith(',"Instant, ""quoted"""'));
});
test('JSON document carries tierOrder, summary, allAvailable and results (no "free" key)', () => {
  const rows = [sampleRow()];
  const doc = toJson({
    command: 'scan',
    version: '1',
    generatedAt: 'x',
    labels: ['live'],
    tlds: ['zip'],
    rows,
    summary: summarize(rows),
    matrix: matrix(rows, ['live'], ['zip']),
    sources: {},
    stats: {},
  });
  is(doc.allAvailable, ['zip']);
  is(doc.allAvailableStandard, ['zip']);
  ok(!('allFree' in doc));
  ok(!JSON.stringify(doc).includes('"free"'));
  is(doc.results.length, 1);
  is(doc.tool, 'domain-hoarding');
});
test('human scan lists TLDs AVAILABLE for every label (premium included, explained) and hides all-taken rows unless --full', () => {
  const rows = [
    sampleRow(),
    sampleRow({ domain: 'live.com', tld: 'com', tier: TIERS.TAKEN, available: false }),
  ];
  const m = matrix(rows, ['live'], ['zip', 'com']);
  const txt = humanScan(rows, ['live'], ['zip', 'com'], m, summarize(rows));
  ok(txt.includes('AVAILABLE for ALL 1 label(s)'));
  ok(txt.includes('premium names cost extra'));
  ok(!txt.includes('Free for'));
  ok(txt.includes('1 TLD(s) hidden'));
  ok(
    !humanScan(rows, ['live'], ['zip', 'com'], m, summarize(rows), { full: true }).includes(
      'hidden'
    )
  );
});
test('human check explains non-free verdicts', () => {
  const txt = humanCheck([
    sampleRow({
      tier: TIERS.UNREGISTERED,
      available: false,
      reason: 'RDAP 404 = no registry record',
    }),
  ]);
  ok(txt.includes('unregistered'));
  ok(txt.includes('RDAP 404 = no registry record'));
});

test('human check labels premium as AVAILABLE · PREMIUM $N, never FREE', () => {
  const txt = humanCheck([sampleRow({ premium: true, premiumUsd: 24900 })]);
  ok(txt.includes('AVAILABLE · PREMIUM $24900'));
  ok(!txt.includes('FREE'));
  ok(humanCheck([sampleRow({ premium: null })]).includes('premium status unchecked'));
});

// ── new: argv, domains, whois, timing ────────────────────────────────────────
test('combined short flags and stray dashes are errors, not domains', () => {
  throws(() => parseArgv(['check', '-qh']));
  throws(() => parseArgv(['check', '-x']));
  is(parseArgv(['check', '-', 'a.com']).positional, ['check', '-', 'a.com']);
  is(
    parseArgv(['check', 'a.com', '--no-whois', '--whois-max=3', '--budget', '9']).flags[
      'whois-max'
    ],
    '3'
  );
});
test('splitCsvLine honours quotes; parseDomainFile finds the domain column past quoted commas', () => {
  is(splitCsvLine('a,"b,c","d""e"'), ['a', 'b,c', 'd"e']);
  is(parseDomainFile('reason,domain\n"x, y",live.zip\n'), ['live.zip']);
});
test('splitDomain rejects IP-looking input and over-long names', () => {
  throws(() => splitDomain('1.2.3.4', SUFFIXES));
  throws(() =>
    splitDomain(
      `${'a'.repeat(60)}.${'b'.repeat(60)}.${'c'.repeat(60)}.${'d'.repeat(60)}.${'e'.repeat(60)}.com`,
      SUFFIXES
    )
  );
});
test('hashCode equals an independent int32 reimplementation on a 100-name batch and Unicode', () => {
  const ref = (str, seed) => {
    let r = seed | 0;
    for (const ch of str) r = (Math.imul(r, 31) + ch.codePointAt(0)) | 0;
    return String(r);
  };
  const names = Array.from({ length: 100 }, (_, i) => `name${i}-xn--abc.example${i % 7}`).join(',');
  is(hashCode(names, 27), ref(names, 27));
  is(hashCode(names, 42), ref(names, 42));
  is(hashCode('bücher.de😀', 27), ref('bücher.de😀', 27));
  is(hashCode('', 27), '27');
});
test('IDS: HTTP 400 on a batch bisects so one bad name does not poison the rest', async () => {
  const bad = 'bad.com';
  const api = {
    get: async (_p, o) => {
      const names = o.params.names.split(',');
      if (names.includes(bad)) {
        const e = new Error('invalid domain name');
        e.status = 400;
        throw e;
      }
      return { results: names.map((n) => ({ name: n, availability: 'available', trust: 'high' })) };
    },
  };
  const ids = createIds({ api, sleep: async () => {} });
  const res = await ids.check(['a.com', 'b.com', bad, 'c.com', 'd.com']);
  is(res.get('a.com').availability, 'available');
  is(res.get('d.com').availability, 'available');
  is(res.get(bad).availability, 'error');
  ok(res.get(bad).error.includes('400'));
});
test('IDS: a call that never returns is cut off by the hard cap and recorded as an error', async () => {
  const api = { get: () => new Promise(() => {}) };
  const ids = createIds({ api, sleep: async () => {}, capMs: 30 });
  const r = (await ids.check(['a.com'])).get('a.com');
  is(r.availability, 'error');
  ok(r.error.includes('timed out'));
});
test('timed() rejects with timeout=true and aborts the signal', async () => {
  let sig;
  let err;
  try {
    await timed(20, (signal) => {
      sig = signal;
      return new Promise(() => {});
    });
  } catch (e) {
    err = e;
  }
  ok(err?.timeout === true);
  ok(sig.aborted);
  is(await timed(50, async () => 7), 7);
});
test('RDAP: a hanging registry is capped and reported inconclusive', async () => {
  const api = { get: () => new Promise(() => {}) };
  const rdap = createRdap({
    api,
    bootstrap: new Map([['zip', ['https://rdap.zip.example/']]]),
    spacingMs: 0,
    sleep: async () => {},
    capMs: 30,
  });
  const r = await rdap.lookup('a.zip', 'zip');
  is(r.status, 'inconclusive');
  ok(r.error.includes('timed out'));
});

const W = (o) => JSON.stringify({ domain: 'live.eu', type: 'European Union', ...o });
test('WHOIS interpret: "no" counts as registered ONLY with registration data in the text', () => {
  is(
    interpretWhois(
      W({
        available: 'no',
        whois: 'Domain: live.eu\nRegistrar:\n  Name: CSC\nName servers:\n  ns1.x',
      }),
      'live.eu'
    ).status,
    'registered'
  );
  // the live.nagoya case: available:"no" over a "WHOIS retired, use RDAP" notice
  const retired = interpretWhois(
    W({
      domain: 'live.nagoya',
      available: 'no',
      whois:
        "Notice: Effective May 1, 2026, the WHOIS service has been retired in accordance with ICANN's RDAP transition policy.",
    }),
    'live.nagoya'
  );
  is(retired.status, 'inconclusive');
  is(interpretWhois(W({ available: 'no', whois: '' }), 'live.eu').status, 'inconclusive');
});
test('WHOIS interpret: "yes" is unregistered (weak); notices, mismatches, junk are inconclusive', () => {
  is(
    interpretWhois(W({ available: 'yes', whois: 'No match for "live.eu".' }), 'live.eu').status,
    'unregistered'
  );
  is(
    interpretWhois(W({ available: 'yes', whois: 'Rate limit exceeded, try again' }), 'live.eu')
      .status,
    'inconclusive'
  );
  is(
    interpretWhois(W({ domain: 'other.eu', available: 'yes', whois: '' }), 'live.eu').status,
    'inconclusive'
  );
  is(interpretWhois('<html>504 Gateway Time-out</html>', 'live.eu').status, 'inconclusive');
  is(interpretWhois(W({ available: 'maybe' }), 'live.eu').status, 'inconclusive');
  is(interpretWhois(null, 'live.eu').status, 'inconclusive');
});
test('WHOIS client: serialised, spaced, capped by --whois-max, breaker after repeated failures', async () => {
  const urls = [];
  let inflight = 0;
  let maxInflight = 0;
  const api = {
    get: async (_u, o) => {
      inflight++;
      maxInflight = Math.max(maxInflight, inflight);
      await new Promise((r) => setTimeout(r, 5));
      inflight--;
      urls.push(o.params.q);
      return { domain: o.params.q, available: 'yes', whois: 'No match' };
    },
  };
  const sleeps = [];
  const w = createWhois({ api, spacingMs: 50, maxCalls: 2, sleep: async (ms) => sleeps.push(ms) });
  const out = await Promise.all(['a.eu', 'b.eu', 'c.eu'].map((d) => w.lookup(d)));
  is(maxInflight, 1);
  is(urls, ['a.eu', 'b.eu']);
  is(out[2].status, 'inconclusive');
  ok(out[2].error.includes('--whois-max'));
  is(w.stats.skippedOverLimit, 1);
  is(w.stats.sent, ['a.eu', 'b.eu']);
  ok(sleeps.length >= 1);
  const e504 = Object.assign(new Error('x'), { status: 504 });
  let n = 0;
  const bad = createWhois({
    api: {
      get: async () => {
        n++;
        throw e504;
      },
    },
    spacingMs: 0,
    sleep: async () => {},
    breakAfter: 2,
  });
  const r = [];
  for (const d of ['a.eu', 'b.eu', 'c.eu', 'd.eu']) r.push(await bad.lookup(d));
  is(n, 2);
  is(r[0].error, 'HTTP 504');
  ok(r[3].error.includes('backed off'));
});
test('WHOIS client: a hung service is capped, not waited on', async () => {
  const w = createWhois({
    api: { get: () => new Promise(() => {}) },
    spacingMs: 0,
    sleep: async () => {},
    capMs: 30,
  });
  const r = await w.lookup('a.eu');
  is(r.status, 'inconclusive');
  ok(r.error.includes('timed out'));
});
test('IDS answer cache: a repeat ask never downgrades a remembered high answer', async () => {
  const files = {};
  // Node's fs shape (fs.promises), as slicc-jsh and SLICC 6 both serve it (#487).
  const fs = {
    promises: {
      readFile: async (f) => {
        if (!(f in files)) throw new Error('ENOENT');
        return files[f];
      },
      writeFile: async (f, d) => {
        files[f] = d;
      },
      mkdir: async () => {},
    },
  };
  const cache = createIdsCache({ fs, file: '/c/ids.json', dir: '/c', ttlMs: 60000 });
  let calls = 0;
  const api = {
    get: async () => {
      calls++;
      return {
        results: [
          { name: 'a.com', availability: 'available', trust: calls === 1 ? 'high' : 'medium' },
        ],
      };
    },
  };
  const ids = createIds({ api, cache, sleep: async () => {} });
  is((await ids.check(['a.com'])).get('a.com').trust, 'high');
  const again = (
    await createIds({
      api,
      cache: createIdsCache({ fs, file: '/c/ids.json', dir: '/c', ttlMs: 60000 }),
      sleep: async () => {},
    }).check(['a.com'])
  ).get('a.com');
  is(again.trust, 'high');
  is(again.cached, true);
  is(calls, 1);
});

test('RDAP enrichment for IDS-settled names gets a short cap; unsettled names get the full cap', async () => {
  const caps = [];
  const s = fakeDeps({
    idsMap: {
      'a.com': { availability: 'inuse', trust: 'high' },
      'b.de': { availability: 'unsupported', trust: 'low' },
    },
  });
  s.deps.rdap = {
    lookup: async (d, _t, o) => {
      caps.push([d, o?.capMs ?? null]);
      return { status: 'no-server' };
    },
  };
  await gather([item('a', 'com'), item('b', 'de')], s.deps, {
    ...SCAN,
    mode: 'check',
    enrichCapMs: 123,
  });
  is(caps, [
    ['a.com', 123],
    ['b.de', null],
  ]);
});

// ── review fixes (Codex on ai-ecoverse/skills#482) ─────────────────────────────
test('normalizeLabel refuses URL syntax instead of reading another host out of it', () => {
  for (const bad of ['foo/bar', 'foo?bar', 'user@host', 'foo#x', 'foo:80', 'a b', 'foo%2e'])
    throws(() => normalizeLabel(bad), /not a valid domain label/);
  is(normalizeLabel('bücher'), 'xn--bcher-kva');
  is(normalizeLabel('Live'), 'live');
});

test('scanTlds: an explicitly empty --tlds is an error, not the defaults', () => {
  is(scanTlds({}, 'com,net', ['x']), ['com', 'net']);
  is(scanTlds({ tlds: 'zip, dev' }, 'com', ['x']), ['zip', 'dev']);
  is(scanTlds({ all: true }, 'com', ['a', 'b']), ['a', 'b']);
  throws(() => scanTlds({ tlds: '' }, 'com', []), /--tlds names no TLD/);
  throws(() => scanTlds({ tlds: ',,,' }, 'com', []), /--tlds names no TLD/);
  throws(() => scanTlds({ all: true, tlds: '' }, 'com', []), /mutually exclusive/);
});

test('parseDomainFile reads a one-column CSV with a domain header', () => {
  is(parseDomainFile('domain\nlive.zip\npage.tech\n'), ['live.zip', 'page.tech']);
  is(parseDomainFile('live.zip\npage.tech'), ['live.zip', 'page.tech']);
});

test('bulk "registered" contradicts every weak unregistered signal: inconclusive, conflict', () => {
  for (const evidence of [
    { ids: { availability: 'available', trust: 'medium' } },
    { ids: { availability: 'unsupported', trust: 'low' }, rdap: { status: 'unregistered' } },
    { ids: { availability: 'error' }, whois: { status: 'unregistered' } },
    { ids: { availability: 'error' }, dns: { status: 'undelegated' } },
  ]) {
    const c = classify({ ...evidence, bulk: { registered: true, premiumUsd: null } });
    is(c.tier, TIERS.INCONCLUSIVE, JSON.stringify(evidence));
    is(c.conflict, true);
    ok(c.reason.includes('bulk endpoint says registered'), c.reason);
  }
  const quiet = classify({
    ids: { availability: 'available', trust: 'medium' },
    bulk: { registered: false },
  });
  is(quiet.tier, TIERS.UNREGISTERED);
});

test('the --budget deadline cuts off a lookup already in flight, in every secondary source', async () => {
  const hang = () => new Promise(() => {});
  const rdap = createRdap({
    api: { get: hang },
    bootstrap: new Map([['de', ['https://rdap.de.example/']]]),
    spacingMs: 0,
    sleep: async () => {},
    capMs: 30000,
  });
  const whois = createWhois({
    api: { get: hang },
    spacingMs: 0,
    sleep: async () => {},
    capMs: 30000,
  });
  const dns = createDns({ run: hang, capMs: 30000 });
  for (const [name, call] of [
    ['rdap', (o) => rdap.lookup('a.de', 'de', o)],
    ['whois', (o) => whois.lookup('a.de', o)],
    ['dns', (o) => dns.lookup('a.de', o)],
  ]) {
    const t0 = Date.now();
    const r = await call({ deadline: Date.now() + 100 });
    ok(Date.now() - t0 < 1000, `${name} took ${Date.now() - t0} ms against a 100 ms budget`);
    is(r.status, 'inconclusive', name);
    is(r.error, 'time budget exhausted (--budget)', name);
  }
  // a budget cut is not a DoH failure: the breaker stays closed, the next call asks dig again
  await dns.lookup('b.de', { deadline: Date.now() + 20 });
  is(dns.stats.calls, 2);
});

test('gather hands the deadline to the source, so one hung registry cannot outlast --budget', async () => {
  const rdap = createRdap({
    api: { get: () => new Promise(() => {}) },
    bootstrap: new Map([['de', ['https://rdap.de.example/']]]),
    spacingMs: 0,
    sleep: async () => {},
    capMs: 30000,
  });
  const t0 = Date.now();
  const [r] = await gather(
    [item('a', 'de')],
    {
      pool: seqPool,
      ids: {
        check: async (ds) =>
          new Map(ds.map((d) => [d, { availability: 'unsupported', trust: 'low' }])),
        bulk: async () => new Map(),
      },
      rdap,
      dns: { lookup: async () => ({ status: 'unavailable' }) },
    },
    { ...SCAN, deadline: Date.now() + 150 }
  );
  ok(Date.now() - t0 < 2000, `took ${Date.now() - t0} ms against a 150 ms budget`);
  is(r.tier, TIERS.INCONCLUSIVE);
  is(r.rdap.error, 'time budget exhausted (--budget)');
});

// ── review fixes (Claude review on ai-ecoverse/skills#482) ─────────────────────
test("DNS: SLICC dig's NXDOMAIN (exit 1, rcode on stderr) is undelegated and keeps DNS on", async () => {
  const replies = {
    'gone.zz': { exitCode: 1, stdout: '', stderr: 'dig: gone.zz: NXDOMAIN\n' },
    'odd.zz': { exitCode: 1, stdout: '', stderr: 'dig: odd.zz: SERVFAIL\n' },
    'held.zz': {
      exitCode: 0,
      stdout: JSON.stringify({ Status: 0, Answer: [{ type: 2 }] }),
      stderr: '',
    },
  };
  const dns = createDns({ run: async (argv) => replies[argv[1]] });
  is(await dns.lookup('gone.zz'), { status: 'undelegated' });
  is(await dns.lookup('odd.zz'), { status: 'inconclusive', error: 'dig: SERVFAIL' });
  is(await dns.lookup('held.zz'), { status: 'delegated' });
  is(dns.stats.calls, 3);
  const broken = createDns({
    run: async () => ({
      exitCode: 1,
      stdout: '',
      stderr: 'dig: lookup failed: 503 Service Unavailable\n',
    }),
  });
  is((await broken.lookup('a.zz')).status, 'unavailable');
  is((await broken.lookup('b.zz')).status, 'unavailable');
  is(broken.stats.calls, 1, 'a transport failure trips the breaker');
});

test('--budget starts after the IDS stage: a slow IDS does not use up the secondary sources', async () => {
  const rows = await gather(
    [item('a', 'de'), item('b', 'de')],
    {
      pool: seqPool,
      ids: {
        check: async (ds) => {
          await new Promise((res) => setTimeout(res, 250));
          return new Map(ds.map((d) => [d, { availability: 'unsupported', trust: 'low' }]));
        },
        bulk: async () => new Map(),
      },
      rdap: {
        lookup: async () => {
          await new Promise((res) => setTimeout(res, 300));
          return { status: 'registered' };
        },
      },
      dns: { lookup: async () => ({ status: 'unavailable' }) },
    },
    { ...SCAN, budgetMs: 200 }
  );
  is(rows[0].rdap.status, 'registered', 'the budget had not started during the 250 ms IDS stage');
  is(rows[1].rdap.error, 'time budget exhausted (--budget)', 'and it does run out after it');
});

test('a premium flag without a price stays premium, priced unknown, never standard', async () => {
  const ids = createIds({
    api: {
      post: async () => ({
        results: [{ tld: 'dev', isRegistered: false, premium: { is_premium: true } }],
      }),
    },
  });
  const bulk = (await ids.bulk('live', ['dev'])).get('dev');
  is(bulk.premium, true);
  is(bulk.premiumUsd, null);
  const c = classify({ ids: { availability: 'available', trust: 'high' }, bulk });
  is(c.tier, TIERS.AVAILABLE);
  is(c.premium, true);
  const row = {
    ...sampleRow({ premium: c.premium, premiumUsd: c.premiumUsd }),
    domain: 'live.dev',
  };
  ok(humanCheck([row]).includes('PREMIUM (price unknown)'), humanCheck([row]));
});

test('WHOIS "no" with registration data is registered even beside terms-of-use boilerplate', () => {
  const text =
    'Domain Name: live.eu\nRegistrar: Example Registrar\nCreation Date: 2001-01-01\n' +
    'Automated queries are forbidden. For more information see RDAP.';
  is(interpretWhois(W({ available: 'no', whois: text }), 'live.eu').status, 'registered');
  is(
    interpretWhois(W({ available: 'no', whois: 'WHOIS has been retired; use RDAP.' }), 'live.eu')
      .status,
    'inconclusive'
  );
});

test('IDS answer cache: a later "missing" or no-trust reply does not erase a remembered high answer', async () => {
  const files = {};
  // Node's fs shape (fs.promises), as slicc-jsh and SLICC 6 both serve it (#487).
  const fsStub = {
    promises: {
      readFile: async (f) => {
        if (!(f in files)) throw new Error('ENOENT');
        return files[f];
      },
      writeFile: async (f, d) => {
        files[f] = d;
      },
      mkdir: async () => {},
    },
  };
  const cache = createIdsCache({ fs: fsStub, file: '/c/ids.json', dir: '/c', ttlMs: 60000 });
  await cache.merge('live.dev', { availability: 'available', trust: 'high' });
  const kept = await cache.merge('live.dev', { availability: 'missing', trust: 'none' });
  is(kept.availability, 'available');
  is(kept.trust, 'high');
  const changed = await cache.merge('live.dev', { availability: 'inuse', trust: 'medium' });
  is(changed.availability, 'inuse', 'a different real answer still replaces it');
});

test('RDAP: budget cuts neither trip nor reset the host breaker', async () => {
  let calls = 0;
  const rdap = createRdap({
    api: {
      get: () => {
        calls++;
        return new Promise(() => {});
      },
    },
    bootstrap: new Map([['de', ['https://rdap.de.example/']]]),
    spacingMs: 0,
    sleep: async () => {},
    capMs: 30000,
    breakAfter: 2,
  });
  for (const d of ['a.de', 'b.de', 'c.de']) {
    const r = await rdap.lookup(d, 'de', { deadline: Date.now() + 20 });
    is(r.error, 'time budget exhausted (--budget)');
  }
  is(calls, 3, 'every name was still asked');
  is([...rdap.stats.skippedHosts], []);
});

test('exit 2 when no source answered any name, whatever the reason', () => {
  const row = (tier) => ({ tier });
  is(noAnswer([row(TIERS.INCONCLUSIVE), row(TIERS.INCONCLUSIVE)]), true);
  is(noAnswer([row(TIERS.INCONCLUSIVE), row(TIERS.TAKEN)]), false);
  is(noAnswer([]), false);
});

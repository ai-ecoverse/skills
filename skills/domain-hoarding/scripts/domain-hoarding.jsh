  // domain-hoarding.jsh — "is this name available?" and "which TLDs have ALL of these names available?"
  // Evidence: Instant Domain Search (primary) -> RDAP via IANA bootstrap -> WHOIS over HTTP
  // (api.whois.vu, conservative fallback) -> DNS NS (weaker last resort).
  // Vocabulary: "free" in the brief means AVAILABLE (registrable), never zero-dollar; premium names qualify.
  // Wire formats verified live 2026-10-08; see references/sources-and-limits.md.
  // All logic lives in sibling .js modules so the tst suite can import it without a runtime.

  const cli = require('sliccy:cli');
  const color = require('sliccy:color');
  const http = require('sliccy:http');
  const pool = require('sliccy:pool');
  const { exec } = require('sliccy:exec');
  const skill = require('sliccy:skill');
  const fs = require('fs');
  const { parseArgv, parseList } = require('./argv.js');
  const { normalizeLabel, normalizeTld, parseDomainFile, splitDomain } = require('./domains.js');
  const { TIERS } = require('./classify.js');
  const { gather, matrix, summarize } = require('./pipeline.js');
  const {
    createDns,
    createIds,
    createIdsCache,
    createRdap,
    createWhois,
    loadBootstrap,
    loadTlds,
  } = require('./sources.js');
  const render = require('./render.js');

  const VERSION = '1.1.0';
  const P = { prefix: 'domain-hoarding' };
  const DEFAULT_TLDS = 'com,net,org,io,dev,app,ai,co,xyz,me,sh,tech,online,site,cloud,page,live,so';

  const HELP = `
domain-hoarding — is this name available to register, and on which TLDs are ALL my names available?
("free" = available/unregistered, NOT zero-dollar: premium names are available but cost extra)

USAGE
  domain-hoarding check <domain>… [--from FILE]     verdict + evidence for full domains
  domain-hoarding scan <label>… [--tlds a,b,c | --all]   per-TLD matrix + TLDs AVAILABLE for every label
  domain-hoarding tlds [--live-tlds]                 print the TLD universe the scan uses

OUTPUT
  (default)      human summary          --json   full JSON document      --csv   one row per name
  --out FILE     write --json/--csv output to FILE (human report still printed)
  --full         scan: also list TLDs where every label is taken
  --no-color     plain human output (NO_COLOR is honoured too)
  -q, --quiet    suppress the one-line stats on stderr

SCOPE
  --tlds LIST    comma/space separated, e.g. com,net,co.uk (default: ${DEFAULT_TLDS})
  --all          the shipped 636-suffix Porkbun snapshot (2026-09-24)
  --live-tlds    with --all/tlds: fetch Porkbun's public pricing list instead (~900 TLDs, adds prices)
  --from FILE    check: read domains from a .txt (one per line) or .csv with a 'domain' column

EVIDENCE
  --verify       scan: also RDAP-check names Instant Domain Search already settled
  --no-rdap  --no-whois  --no-dns  --no-premium    skip that source (premium = bulk-check price lookup)
  --whois-max N  at most N names sent to the WHOIS fallback per run (25)
                 NOTE: WHOIS fallback sends the domain name to a THIRD PARTY (api.whois.vu), and only for
                 names Instant Domain Search could not settle AND RDAP has no server for / could not answer.
  --no-cache     ignore the 24 h IANA/Porkbun caches AND the remembered-answers cache
  --cache-ttl M  minutes to remember high-trust answers instead of re-asking (60; 0 = off)

POLITENESS
  --concurrency N (6)   --delay MS (200, per registry host)   --timeout S (10, per attempt; one lookup is capped at 1.5x)
  --budget S     wall-clock cap for the RDAP/WHOIS/DNS stages (45 + 0.25 s per name beyond 60); after it,
                 remaining names stay inconclusive instead of the run waiting on a throttled source

EXIT  0 ok · 1 usage/error · 2 ran but NO source answered (all inconclusive)
TIERS available-high-confidence · unregistered-needs-confirmation · inconclusive · taken-reserved-blocked
      (RDAP 404 never means registrable — see references/confidence-tiers.md)
`.trim();

  const defaultBudgetSec = (n) => Math.min(900, Math.round(45 + Math.max(0, n - 60) * 0.25));
  const num = (v, def, lo, hi, name) => {
    if (v === undefined) return def;
    const n = Number(v);
    if (!Number.isFinite(n) || n < lo || n > hi)
      cli.die(`--${name} must be a number between ${lo} and ${hi}`, P);
    return n;
  };

  async function main() {
    let parsed;
    try {
      parsed = parseArgv(process.argv.slice(2));
    } catch (err) {
      cli.die(`${err.message}\nRun 'domain-hoarding --help' for usage.`, P);
    }
    const { positional, flags } = parsed;
    const cmd = positional[0];
    if (flags.version) {
      console.log(`domain-hoarding ${VERSION}`);
      return;
    }
    if (flags.help || !cmd || cmd === 'help') cli.help(HELP);
    if (!['check', 'scan', 'tlds'].includes(cmd))
      cli.die(`unknown command: ${cmd}\nRun 'domain-hoarding --help' for usage.`, P);
    if (flags.json && flags.csv) cli.die('--json and --csv are mutually exclusive', P);
    if (flags.out && !flags.json && !flags.csv)
      cli.die('--out needs --json or --csv to say what to write', P);

    const concurrency = Math.round(num(flags.concurrency, 6, 1, 16, 'concurrency'));
    const delayMs = Math.round(num(flags.delay, 200, 0, 5000, 'delay'));
    const timeoutMs = Math.round(num(flags.timeout, 10, 2, 120, 'timeout') * 1000);
    const capMs = Math.round(timeoutMs * 1.5); // hard cap on ONE lookup, retries included
    const whoisMax = Math.round(num(flags['whois-max'], 25, 0, 500, 'whois-max'));
    const cacheDir =
      process.env.DOMAIN_HOARDING_CACHE || `${process.env.TMPDIR || '/tmp'}/domain-hoarding`;
    const t0 = Date.now();

    const plainApi = http.client({ timeoutMs, retry: { on: [429, 502, 503], maxAttempts: 3 } });
    const snapshotPath = `${skill.assets}/tlds-porkbun-2026-09-24.txt`;
    const universe = await loadTlds({
      live: !!flags['live-tlds'],
      fs: fs,
      api: plainApi,
      snapshotPath,
      cacheDir,
      noCache: !!flags['no-cache'],
      capMs,
    }).catch((err) => cli.die(`could not load the TLD list: ${err.message}`, P));

    if (cmd === 'tlds') {
      if (flags.json)
        return cli.out({
          source: universe.source,
          count: universe.tlds.length,
          tlds: universe.tlds,
          prices: universe.prices,
        });
      console.log(universe.tlds.join('\n'));
      if (!flags.quiet) process.stderr.write(`${universe.tlds.length} TLDs (${universe.source})\n`);
      return;
    }

    // ── inputs ────────────────────────────────────────────────────────────────
    let bootstrap = new Map();
    let rdapOn = !flags['no-rdap'];
    if (rdapOn) {
      try {
        bootstrap = await loadBootstrap({
          fs: fs,
          api: plainApi,
          cacheDir,
          noCache: !!flags['no-cache'],
          capMs,
        });
      } catch (err) {
        process.stderr.write(
          `domain-hoarding: RDAP disabled — IANA bootstrap unavailable (${err.message})\n`
        );
        rdapOn = false;
      }
    }
    const suffixes = new Set([...universe.tlds, ...bootstrap.keys()]);

    let items;
    let labels = null;
    let tlds = null;
    try {
      if (cmd === 'check') {
        let inputs = positional.slice(1);
        if (flags.from)
          inputs = inputs.concat(parseDomainFile(await fs.readFile(flags.from, 'utf8')));
        if (!inputs.length) cli.die('usage: domain-hoarding check <domain>… [--from FILE]', P);
        items = [];
        const seen = new Set();
        for (const raw of inputs) {
          const d = splitDomain(raw, suffixes);
          if (seen.has(d.domain)) continue;
          seen.add(d.domain);
          items.push(d);
        }
      } else {
        labels = [...new Set(positional.slice(1).map(normalizeLabel))];
        if (!labels.length)
          cli.die('usage: domain-hoarding scan <label>… [--tlds a,b,c | --all]', P);
        if (flags.all && flags.tlds) cli.die('--all and --tlds are mutually exclusive', P);
        tlds = flags.all
          ? universe.tlds
          : [...new Set(parseList(flags.tlds || DEFAULT_TLDS).map(normalizeTld))];
        items = [];
        for (const label of labels)
          for (const tld of tlds)
            items.push({ domain: `${label}.${tld}`, label, tld, tldKnown: suffixes.has(tld) });
      }
    } catch (err) {
      if (err?.name === 'NodeExitError') throw err;
      cli.die(err.message, P);
    }

    // ── sources ───────────────────────────────────────────────────────────────
    const idsApi = http.client({
      baseUrl: 'https://instantdomainsearch.com',
      headers: { Accept: 'application/json' },
      retry: { on: [429, 502, 503], maxAttempts: 3 },
      timeoutMs,
    });
    const rdapApi = http.client({
      headers: { Accept: 'application/rdap+json, application/json' },
      retry: { on: [429, 502, 503], maxAttempts: 3 },
      timeoutMs,
    });
    // IDS grades trust=high only on the FIRST ask of a name; re-asking degrades it to medium.
    // Remember high-trust answers so a repeat check/scan reuses them (references/sources-and-limits.md).
    const cacheTtlMin = flags['no-cache'] ? 0 : num(flags['cache-ttl'], 60, 0, 1440, 'cache-ttl');
    const idsCache = createIdsCache({
      fs,
      file: `${cacheDir}/ids-answers.json`,
      dir: cacheDir,
      ttlMs: cacheTtlMin * 60000,
    });
    const ids = createIds({
      api: idsApi,
      cache: idsCache,
      delayMs: Math.max(delayMs, 100),
      capMs: capMs * 2,
    });
    const rdap = createRdap({ api: rdapApi, bootstrap, spacingMs: delayMs, capMs });
    const whoisApi = http.client({
      headers: { Accept: 'application/json' },
      timeoutMs: Math.min(timeoutMs, 10000),
    });
    const whois = createWhois({ api: whoisApi, maxCalls: whoisMax, capMs: Math.min(capMs, 10000) });
    const dns = createDns({ run: (argv) => exec.spawn(argv), capMs: Math.min(capMs, 8000) });
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

    const budgetSec = Math.round(
      num(flags.budget, defaultBudgetSec(items.length), 1, 3600, 'budget')
    );
    const whoisOn = !flags['no-whois'] && whoisMax > 0;
    const rows = await gather(
      items,
      { ids, rdap, whois, dns, pool, sleep },
      {
        mode: cmd,
        rdap: rdapOn,
        whois: whoisOn,
        dns: !flags['no-dns'],
        premium: !flags['no-premium'],
        verify: !!flags.verify,
        concurrency,
        delayMs,
        prices: universe.prices,
        deadline: t0 + budgetSec * 1000,
      }
    );

    const summary = summarize(rows);
    const m = cmd === 'scan' ? matrix(rows, labels, tlds) : null;
    const stats = {
      elapsedMs: Date.now() - t0,
      ids: {
        checkCalls: ids.stats.checkCalls,
        bulkCalls: ids.stats.bulkCalls,
        errors: ids.stats.errors,
        rememberedAnswersReused: ids.stats.cacheHits,
      },
      rdap: {
        calls: rdap.stats.calls,
        throttled: rdap.stats.throttled,
        backedOffHosts: [...rdap.stats.skippedHosts],
      },
      whois: {
        calls: whois.stats.calls,
        skippedOverLimit: whois.stats.skippedOverLimit,
        backedOff: whois.stats.broken,
        thirdParty: 'api.whois.vu',
        namesSent: whois.stats.sent,
      },
      dns: { calls: dns.stats.calls },
      budgetSec,
    };
    const idsAvail = rows.filter((r) => r.ids?.availability === 'available');
    const idsHigh = idsAvail.filter((r) => r.ids.trust === 'high').length;
    stats.ids.availableAnswers = idsAvail.length;
    stats.ids.availableHighTrust = idsHigh;
    const warnings = [];
    if (idsAvail.length >= 3 && idsHigh * 2 < idsAvail.length) {
      warnings.push(
        `Instant Domain Search graded only ${idsHigh} of ${idsAvail.length} 'available' answers trust=high. It grades high only the first time a name is asked in its cache window (repeat asks, from anyone on this network path, return medium), so these are tiered unregistered-needs-confirmation rather than available. Confirm at a registrar, or retry after the cache window.`
      );
    }
    if (whois.stats.calls > 0) {
      warnings.push(
        `${whois.stats.calls} name(s) were sent to the third-party WHOIS service api.whois.vu (Instant Domain Search could not settle them and RDAP had no server/answer): ${whois.stats.sent.join(', ')}. Disable with --no-whois.`
      );
    }
    if (
      Date.now() > t0 + budgetSec * 1000 &&
      rows.some((r) => /time budget exhausted/.test(JSON.stringify([r.rdap, r.whois, r.dns])))
    ) {
      warnings.push(
        `the ${budgetSec}s secondary-source budget ran out; some names were left inconclusive (raise --budget, or lower the scope).`
      );
    }
    stats.warnings = warnings;
    const sources = {
      tlds: universe.source,
      rdapEnabled: rdapOn,
      whoisEnabled: whoisOn,
      whoisProvider: whoisOn ? 'api.whois.vu (third party)' : null,
      dnsEnabled: !flags['no-dns'],
      premiumLookup: !flags['no-premium'],
    };
    const doc = render.toJson({
      command: cmd,
      version: VERSION,
      generatedAt: new Date().toISOString(),
      labels,
      tlds,
      rows,
      summary,
      matrix: m,
      sources,
      stats,
    });

    // ── output ────────────────────────────────────────────────────────────────
    const paint = flags['no-color'] ? render.plain : color; // SLICC reports isTTY=true even when piped; --no-color / NO_COLOR give plain text
    const human = () =>
      cmd === 'check'
        ? render.humanCheck(rows, paint)
        : render.humanScan(rows, labels, tlds, m, summary, { full: !!flags.full }, paint);
    if (flags.json || flags.csv) {
      const body = flags.json ? `${JSON.stringify(doc, null, 2)}\n` : render.toCsv(rows);
      if (flags.out) {
        await fs.writeFile(flags.out, body);
        process.stdout.write(human());
        if (!flags.quiet)
          process.stderr.write(
            `domain-hoarding: wrote ${flags.json ? 'JSON' : 'CSV'} to ${flags.out}\n`
          );
      } else {
        process.stdout.write(body);
      }
    } else {
      process.stdout.write(human());
    }
    if (!flags.quiet) {
      const s = stats;
      process.stderr.write(
        `domain-hoarding: ids ${s.ids.checkCalls}+${s.ids.bulkCalls} calls (${s.ids.errors} errors), rdap ${s.rdap.calls} calls (${s.rdap.throttled} throttled${s.rdap.backedOffHosts.length ? `, backed off: ${s.rdap.backedOffHosts.join(' ')}` : ''}), whois ${s.whois.calls}${s.whois.backedOff ? ' (backed off)' : ''}, dns ${s.dns.calls}, ${(s.elapsedMs / 1000).toFixed(1)}s\n`
      );
    }
    for (const w of warnings) process.stderr.write(`domain-hoarding: warning: ${w}\n`);
    if (rows.length && rows.every((r) => r.tier === TIERS.INCONCLUSIVE) && ids.stats.errors > 0) {
      process.stderr.write(
        'domain-hoarding: no source produced an answer for any name — check connectivity, then retry\n'
      );
      process.exitCode = 2;
    }
  }

  try {
    await main();
    // A lookup that timed out may still hold an un-aborted fetch open (measured: a throttled
    // service kept the realm alive for >90 s after all output was written). Everything is already
    // written, so end the process instead of waiting on abandoned requests.
    process.exit(process.exitCode || 0);
  } catch (err) {
    if (err?.name === 'NodeExitError') throw err;
    cli.die(err?.message || String(err), P);
  }

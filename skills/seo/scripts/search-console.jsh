// search-console.jsh — SLICC CLI that reads Google Search Console performance
// data for a property by parsing the inline AF_initDataCallback blocks from the
// logged-in Search Console HTML page. No OAuth credential needed — the request
// is issued by curlwright inside the logged-in search.google.com tab.
//
// WHY: The official Search Console API needs an OAuth token, but the Cloud SDK's
// public desktop client cannot request the webmasters scope (restricted_client),
// and fetching googleapis.com with the tab's cookies returns 401. So we parse
// what the browser already sees, following the gcloud-ext.jsh pattern.
//
// FRAGILITY: ds: indices and array offsets are undocumented; a UI release can
// silently reshape them. The verify command cross-checks parsed totals against
// the page's own rendered scorecards to catch that.

const cli     = require('sliccy:cli');
const exec    = require('sliccy:exec');
const c       = require('sliccy:color');
const browser = require('sliccy:browser');

const parse = require('./gsc-parse.js');

/** The parsing module raises GscParseError instead of exiting, so it stays
 *  importable by the tst suite. Translate that into the CLI contract here:
 *  a one-line diagnosis and a non-zero exit. Anything else is a real bug and
 *  is left to propagate. */
function orDie(fn) {
  try {
    return fn();
  } catch (err) {
    if (err?.name === 'GscParseError') {
      cli.die(err.message, { prefix: 'search-console' });
    }
    throw err;
  }
}

const DEFAULT_PROPERTY = 'sc-domain:sliccy.com';

/** Search Console properties are either a domain property (`sc-domain:example.com`)
 *  or a URL-prefix property (`https://example.com/`). Reject anything else up front
 *  rather than fetching a page that cannot contain a report. */
function resolveProperty(flags) {
  const property = flags.property || DEFAULT_PROPERTY;
  if (!parse.isValidProperty(property)) {
    cli.die(
      `Invalid --property "${property}".\n` +
      'Use a domain property ("sc-domain:example.com") or a URL-prefix property\n' +
      '("https://example.com/"), exactly as Search Console shows it.',
      { prefix: 'search-console' },
    );
  }
  return property;
}

// ─── Tab discovery ────────────────────────────────────────────────────────────

async function findGSCTab() {
  const tab = await browser.findTab({ urlMatch: /search\.google\.com/ });
  if (!tab) {
    cli.die(
      'No logged-in search.google.com tab found.\n' +
      'Open https://search.google.com/search-console (signed in) and retry.',
      { prefix: 'search-console' },
    );
  }
  return tab;
}

// ─── Fetch + parse ────────────────────────────────────────────────────────────

/** Fetch the Search Console performance page via curlwright, returning the raw
 *  HTML string. The request runs inside the GSC tab, carrying its cookies. */
async function fetchGSCPage(tab, property) {
  const resourceId = encodeURIComponent(property);
  const url =
    `https://search.google.com/u/1/search-console/performance/search-analytics` +
    `?resource_id=${resourceId}`;

  const { stdout, stderr, exitCode } = await exec.spawn([
    'curlwright', '--tab=' + tab.targetId, '-s', '-S',
    '-w', '%{http_code}',
    url,
  ]);
  if (exitCode !== 0) {
    cli.die(
      `curlwright failed (exit ${exitCode}): ${stderr || stdout}`,
      { prefix: 'search-console' },
    );
  }
  // stdout = body + http_code appended by -w
  const httpCode = stdout.slice(-3);
  const body = stdout.slice(0, -3);
  if (httpCode !== '200') {
    cli.die(
      `Search Console returned HTTP ${httpCode} for property "${property}".` +
      (httpCode === '404' ? ' Check the property name.' : ''),
      { prefix: 'search-console' },
    );
  }

  // A dead session does NOT 404: curlwright follows the redirect and returns 200
  // with a Google sign-in page, which is far larger than any size heuristic would
  // catch. The marker choice is explained in gsc-parse.js.
  if (parse.looksLikeSignInPage(body) || body.length < 1000) {
    cli.die(
      `Got a sign-in page instead of the report for "${property}".\n` +
      'The search.google.com session has expired. Open Search Console in the\n' +
      'browser, sign in, and retry.',
      { prefix: 'search-console' },
    );
  }
  return body;
}

// ─── Commands ─────────────────────────────────────────────────────────────────

async function cmdPerformance(flags) {
  const property = resolveProperty(flags);
  const tab = await findGSCTab();
  const html = await fetchGSCPage(tab, property);
  const blocks = orDie(() => parse.parseDataBlocks(html));
  const { totals, daily } = orDie(() => parse.parseTotalsAndDaily(blocks));

  const days = parseInt(flags.days, 10) || 0;
  const series = days > 0 ? daily.slice(-days) : daily;

  if (flags.json) {
    cli.out({ property, totals, daily: series });
    return;
  }

  console.log('');
  console.log(`  ${c.bold('Property')}  ${property}`);
  console.log('');
  console.log(`  ${c.bold('Total clicks')}       ${c.cyan(String(totals.clicks))}`);
  console.log(`  ${c.bold('Total impressions')}  ${c.cyan(String(totals.impressions))}`);
  console.log(`  ${c.bold('Average CTR')}        ${c.cyan((totals.ctr * 100).toFixed(2) + '%')}`);
  console.log(`  ${c.bold('Average position')}   ${c.cyan(totals.position.toFixed(1))}`);
  console.log('');

  if (series.length === 0) {
    console.log('  No daily data.');
    return;
  }

  console.log(`  ${c.dim('Date'.padEnd(12))} ${c.dim('Clicks'.padStart(8))} ${c.dim('Impressions'.padStart(13))} ${c.dim('CTR'.padStart(8))} ${c.dim('Position'.padStart(10))}`);
  for (const d of series) {
    console.log(
      `  ${d.date.padEnd(12)} ${String(d.clicks).padStart(8)} ${String(d.impressions).padStart(13)} ` +
      `${(d.ctr * 100).toFixed(1).padStart(7)}% ${d.position.toFixed(1).padStart(10)}`,
    );
  }
  console.log('');
  console.log(`  ${c.dim(series.length + ' days shown' + (days ? ' (last ' + days + ')' : ''))}`);
}

async function cmdQueries(flags) {
  const property = resolveProperty(flags);
  const limit = parseInt(flags.limit, 10) || 0;
  const tab = await findGSCTab();
  const html = await fetchGSCPage(tab, property);
  const blocks = orDie(() => parse.parseDataBlocks(html));
  const { totals } = orDie(() => parse.parseTotalsAndDaily(blocks));
  const queries = orDie(() => parse.parseQueryTable(blocks));

  const shown = limit > 0 ? queries.slice(0, limit) : queries;

  // Named-query sums.
  let namedClicks = 0, namedImpressions = 0;
  for (const q of queries) {
    namedClicks += q.clicks;
    namedImpressions += q.impressions;
  }

  if (flags.json) {
    cli.out({
      property,
      queries: shown,
      namedQueryTotals: { clicks: namedClicks, impressions: namedImpressions },
      propertyTotals: totals,
    });
    return;
  }

  console.log('');
  console.log(`  ${c.bold('Property')}  ${property}  (${queries.length} named queries)`);
  console.log('');

  const qw = Math.max(7, ...shown.map((q) => q.query.length));
  console.log(
    `  ${c.dim('Query'.padEnd(qw))} ${c.dim('Clicks'.padStart(8))} ${c.dim('Impressions'.padStart(13))} ` +
    `${c.dim('CTR'.padStart(8))} ${c.dim('Position'.padStart(10))}`,
  );
  for (const q of shown) {
    console.log(
      `  ${q.query.padEnd(qw)} ${String(q.clicks).padStart(8)} ${String(q.impressions).padStart(13)} ` +
      `${(q.ctr * 100).toFixed(1).padStart(7)}% ${q.position.toFixed(1).padStart(10)}`,
    );
  }

  console.log('');
  console.log(
    `  ${c.dim('Named queries:')} ${namedClicks} clicks, ${namedImpressions} impressions` +
    ` (${queries.length} queries)`,
  );
  console.log(
    `  ${c.dim('Property totals:')} ${c.bold(String(totals.clicks))} clicks, ` +
    `${c.bold(String(totals.impressions))} impressions`,
  );
  const clickGap = totals.clicks - namedClicks;
  const impGap = totals.impressions - namedImpressions;
  if (clickGap > 0 || impGap > 0) {
    console.log(
      `  ${c.dim('Anonymised gap:')} ${clickGap} clicks, ${impGap} impressions` +
      ` (${((clickGap / totals.clicks) * 100).toFixed(0)}% / ${((impGap / totals.impressions) * 100).toFixed(0)}% not attributed)`,
    );
  }
  console.log('');
}

async function cmdVerify(flags) {
  const property = resolveProperty(flags);
  const tab = await findGSCTab();
  const html = await fetchGSCPage(tab, property);
  const blocks = orDie(() => parse.parseDataBlocks(html));
  const { totals } = orDie(() => parse.parseTotalsAndDaily(blocks));

  const ui = parse.parseUIScorecards(html);
  const errors = parse.compareTotalsWithUI(totals, ui);

  // Report.
  console.log('');
  console.log(`  ${c.bold('Verify')}  ${property}`);
  console.log('');
  console.log(`  Parsed (ds:9):  clicks=${totals.clicks}  impressions=${totals.impressions}  ` +
    `CTR=${(totals.ctr * 100).toFixed(2)}%  position=${totals.position.toFixed(1)}`);
  console.log(`  UI scorecards:  clicks=${ui.clicks || '?'}  impressions=${ui.impressions || '?'}  ` +
    `CTR=${ui.ctrPct || '?'}  position=${ui.position || '?'}`);
  console.log('');

  if (errors.length === 0) {
    console.log(`  ${c.green('PASS')}  Parsed totals match the page's displayed values.`);
    console.log('');
  } else {
    for (const e of errors) console.log(`  ${c.red('FAIL')}  ${e}`);
    console.log('');
    process.exit(1);
  }
}

// ─── args + main ─────────────────────────────────────────────────────────────

const HELP = `
search-console — read Google Search Console performance data from the browser.

Parses the inline AF_initDataCallback blocks from the logged-in Search Console
page. No OAuth credential needed — curlwright fetches the page in the context
of your logged-in search.google.com tab.

USAGE
  search-console performance [--property P] [--days N] [--json]
  search-console queries     [--property P] [--limit N] [--json]
  search-console verify      [--property P]

COMMANDS
  performance   Property totals (clicks, impressions, CTR, position) plus the
                daily time series. --days limits to the last N days.

  queries       Per-query breakdown sorted by clicks descending. Footer shows
                named-query sums alongside property totals so the anonymised
                gap is visible. --limit caps the number of rows printed.

  verify        Cross-check parsed ds:9 totals against the scorecard values
                the page itself renders. Exits non-zero on mismatch.

OPTIONS
  --property P  Search Console property (default: sc-domain:sliccy.com)
  --days N      Show only the last N days (performance only)
  --limit N     Show only the top N queries (queries only)
  --json        Machine-readable JSON output
  --help        Show this help

REQUIREMENTS
  An open, signed-in search.google.com browser tab.
`.trim();

const PERF_HELP = `
search-console performance — property totals and daily series.

USAGE
  search-console performance [--property P] [--days N] [--json]

Shows the property-level totals (clicks, impressions, CTR, average position)
from ds:9, plus a daily breakdown. Totals always come from ds:9, never from
summing the query table.

OPTIONS
  --property P  Search Console property (default: sc-domain:sliccy.com)
  --days N      Show only the last N days
  --json        JSON output
`.trim();

const QUERIES_HELP = `
search-console queries — per-query performance table.

USAGE
  search-console queries [--property P] [--limit N] [--json]

Lists every named query from ds:16 sorted by clicks descending. The footer
shows named-query sums and property totals side by side — the gap is the
anonymised long-tail that Search Console omits from the query table but still
counts in totals.

OPTIONS
  --property P  Search Console property (default: sc-domain:sliccy.com)
  --limit N     Show only the top N queries
  --json        JSON output
`.trim();

const VERIFY_HELP = `
search-console verify — cross-check parsed totals against displayed values.

USAGE
  search-console verify [--property P]

Asserts that the clicks, impressions, CTR and position parsed from ds:9 match
the values the page renders in its scorecards. Exits 0 on match, non-zero on
mismatch with a message naming both numbers. Catches silent parse breakage
from UI changes.

OPTIONS
  --property P  Search Console property (default: sc-domain:sliccy.com)
`.trim();

const parsed     = process.argv.parseFlags();
const subcommand = parsed.subcommand || '';
const flags      = parsed.flags;

async function main() {
  if (flags.help || flags.h) {
    if (subcommand === 'performance') cli.help(PERF_HELP);
    if (subcommand === 'queries')     cli.help(QUERIES_HELP);
    if (subcommand === 'verify')      cli.help(VERIFY_HELP);
    cli.help(HELP);
  }
  if (!subcommand || subcommand === 'help') cli.help(HELP);

  try {
    if (subcommand === 'performance') return await cmdPerformance(flags);
    if (subcommand === 'queries')     return await cmdQueries(flags);
    if (subcommand === 'verify')      return await cmdVerify(flags);

    cli.die(
      `unknown command: ${subcommand}\nRun 'search-console --help' for usage.`,
      { prefix: 'search-console' },
    );
  } catch (err) {
    if (err?.name === 'NodeExitError') throw err;
    cli.die(err.message, { prefix: 'search-console' });
  }
}

await main();

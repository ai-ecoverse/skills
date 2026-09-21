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
 *  HTML string. The request runs inside the GSC tab, carrying its cookies.
 *
 *  `opts` is passed to buildReportUrl: { breakdown, query }. */
async function fetchGSCPage(tab, property, opts = {}) {
  // The account slot comes from the tab, never hard-coded: fetching under the
  // wrong slot returns 200 with a no-access page, which reads like a permission
  // problem. See accountSlotFromUrl in gsc-parse.js.
  const slot = parse.accountSlotFromUrl(tab.url);
  const url = parse.buildReportUrl(property, slot, opts);

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
  if (parse.looksLikeNoAccessPage(body)) {
    cli.die(parse.noAccessMessage(property, slot), { prefix: 'search-console' });
  }

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

  // Named-query sums and the unattributed remainder (see gsc-parse.js).
  const gap = parse.anonymisedGap(totals, queries);
  const { namedClicks, namedImpressions } = gap;

  if (flags.json) {
    cli.out({
      property,
      queries: shown,
      namedQueryTotals: { clicks: namedClicks, impressions: namedImpressions },
      propertyTotals: totals,
      unattributed: {
        clicks: gap.clickGap,
        impressions: gap.impressionGap,
        tableLikelyTruncated: gap.tableLikelyTruncated,
      },
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
  if (gap.clickGap > 0 || gap.impressionGap > 0) {
    // Named "anonymised" only when the table is plausibly complete. Past the row
    // cap the remainder also contains ordinary queries the table did not return,
    // and calling that anonymisation would be a false explanation.
    const label = gap.tableLikelyTruncated ? 'Unattributed gap:' : 'Anonymised gap:';
    console.log(
      `  ${c.dim(label)} ${gap.clickGap} clicks, ${gap.impressionGap} impressions` +
      ` (${gap.clickGapPct.toFixed(0)}% / ${gap.impressionGapPct.toFixed(0)}% not attributed)`,
    );
    if (gap.tableLikelyTruncated) {
      console.log(
        `  ${c.dim('Note:')} the query table returned ${queries.length} rows and is probably` +
        ' capped, so part of this gap is queries the table omitted rather than',
      );
      console.log('        queries Search Console anonymised.');
    }
  }
  console.log('');
}

/** Top pages by clicks, optionally restricted to one exact query.
 *
 *  The query-filtered form is the one that answers "which URL earns this query's
 *  impressions" — a question the query table cannot answer at all. */
async function cmdPages(flags) {
  const property = resolveProperty(flags);
  const limit = parseInt(flags.limit, 10) || 0;
  const query = typeof flags.query === 'string' ? flags.query.trim() : '';
  if (flags.query !== undefined && query === '') {
    cli.die('--query needs a value, e.g. --query slicc.', { prefix: 'search-console' });
  }

  const tab = await findGSCTab();
  const html = await fetchGSCPage(tab, property, {
    breakdown: 'page',
    ...(query ? { query } : {}),
  });
  const blocks = orDie(() => parse.parseDataBlocks(html));

  // Before reading a single row: make Search Console state that it applied the
  // filter. An ignored parameter comes back as HTTP 200 with the UNFILTERED
  // report, so without this check "pages for query X" would quietly become "all
  // pages" — the silent-wrong-answer failure this skill exists to avoid.
  if (query) orDie(() => parse.assertQueryFilterApplied(blocks, query));

  // A filter matching nothing yields totals of [0, 0, "NaN", "NaN"].
  const { totals } = orDie(() => parse.parseTotalsAndDaily(blocks, { allowNoData: !!query }));
  const pages = orDie(() => parse.parsePageTable(blocks));

  const shown = limit > 0 ? pages.slice(0, limit) : pages;
  const delta = parse.pageTableDelta(totals, pages);

  if (flags.json) {
    cli.out({
      property,
      query: query || null,
      pages: shown,
      pageTableTotals: { clicks: delta.pageClicks, impressions: delta.pageImpressions },
      reportTotals: totals,
      difference: {
        clicks: delta.clickDelta,
        impressions: delta.impressionDelta,
        pageSumExceedsTotals: delta.exceedsTotals,
      },
    });
    return;
  }

  const scope = query ? `query "${query}"` : 'all queries';
  console.log('');
  console.log(`  ${c.bold('Property')}  ${property}  (${scope}, ${pages.length} pages)`);
  console.log('');

  if (shown.length === 0) {
    console.log(`  No pages earned impressions for ${scope}.`);
    console.log(`  ${c.dim('Search Console echoed the filter back, so it was applied and matched nothing.')}`);
    console.log('');
    return;
  }

  printPageRows(shown);
  printPageFooter({ pages, totals, delta, query });
}

function printPageRows(shown) {
  const pw = Math.max(6, ...shown.map((p) => p.page.length));
  console.log(
    `  ${c.dim('Page'.padEnd(pw))} ${c.dim('Clicks'.padStart(8))} ${c.dim('Impressions'.padStart(13))} ` +
    `${c.dim('CTR'.padStart(8))} ${c.dim('Position'.padStart(10))}`,
  );
  for (const p of shown) {
    console.log(
      `  ${p.page.padEnd(pw)} ${String(p.clicks).padStart(8)} ${String(p.impressions).padStart(13)} ` +
      `${(p.ctr * 100).toFixed(1).padStart(7)}% ${p.position.toFixed(1).padStart(10)}`,
    );
  }
}

/** The page column does not add up to the totals in either direction, and the two
 *  directions mean different things, so neither is left implied. */
function printPageFooter({ pages, totals, delta, query }) {
  console.log('');
  console.log(
    `  ${c.dim('Page table:')} ${delta.pageClicks} clicks, ${delta.pageImpressions} impressions` +
    ` (${pages.length} pages)`,
  );
  console.log(
    `  ${c.dim(query ? 'Totals for this query:' : 'Property totals:')} ${c.bold(String(totals.clicks))} clicks, ` +
    `${c.bold(String(totals.impressions))} impressions`,
  );
  if (delta.exceedsTotals) {
    console.log(
      `  ${c.dim('Page sum exceeds totals by:')} ${delta.clickDelta} clicks, ` +
      `${delta.impressionDelta} impressions ` +
      `(+${delta.clickDeltaPct.toFixed(0)}% / +${delta.impressionDeltaPct.toFixed(0)}%)`,
    );
    console.log(
      `  ${c.dim('Note:')} page rows count per page, the totals per search. One result page listing` +
      ' two of your URLs',
    );
    console.log('        counts twice here and once in the totals, so this column is not a total.');
  } else if (delta.clickDelta < 0 || delta.impressionDelta < 0) {
    console.log(
      `  ${c.dim('Unattributed gap:')} ${-delta.clickDelta} clicks, ${-delta.impressionDelta} impressions` +
      ` (${(-delta.clickDeltaPct).toFixed(0)}% / ${(-delta.impressionDeltaPct).toFixed(0)}% not attributed)`,
    );
    console.log(`  ${c.dim('Note:')} the page table did not account for every total; do not sum it into one.`);
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
  search-console pages       [--property P] [--limit N] [--query Q] [--json]
  search-console verify      [--property P]

COMMANDS
  performance   Property totals (clicks, impressions, CTR, position) plus the
                daily time series. --days limits to the last N days.

  queries       Per-query breakdown sorted by clicks descending. Footer shows
                named-query sums alongside property totals so the anonymised
                gap is visible. --limit caps the number of rows printed.

  pages         Per-page breakdown sorted by clicks descending. --query Q
                restricts it to the pages that earned that EXACT query, which
                is how you find which URL ranks for a term. The page column
                does not add up to the totals; the footer prints the difference.

  verify        Cross-check parsed ds:9 totals against the scorecard values
                the page itself renders. Exits non-zero on mismatch.

OPTIONS
  --property P  Search Console property (default: sc-domain:sliccy.com)
  --days N      Show only the last N days (performance only)
  --limit N     Show only the top N rows (queries, pages)
  --query Q     Restrict pages to one exact query (pages only)
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

const PAGES_HELP = `
search-console pages — per-page performance table.

USAGE
  search-console pages [--property P] [--limit N] [--query Q] [--json]

Lists the pages Search Console reports for the property, sorted by clicks
descending, from the page breakdown (ds:16 fetched with breakdown=page).

With --query Q the rows are the pages that earned impressions for that EXACT
query, and the totals shown are that query's own totals. Exact, not "contains":
--query slicc excludes "sliccy" and "slicc ai". Search Console has to echo the
filter back in the response or the command fails, because an ignored filter
parameter returns the unfiltered report with HTTP 200.

The page sums and the totals are printed separately because they disagree by
design: one result page listing two of your URLs counts twice in this table and
once in the totals, so the column can exceed the total it sits under.

OPTIONS
  --property P  Search Console property (default: sc-domain:sliccy.com)
  --limit N     Show only the top N pages
  --query Q     Only pages that earned this exact query
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

const COMMANDS = {
  performance: { run: cmdPerformance, help: PERF_HELP },
  queries:     { run: cmdQueries,     help: QUERIES_HELP },
  pages:       { run: cmdPages,       help: PAGES_HELP },
  verify:      { run: cmdVerify,      help: VERIFY_HELP },
};

async function main() {
  const command = COMMANDS[subcommand];
  if (flags.help || flags.h) cli.help(command ? command.help : HELP);
  if (!subcommand || subcommand === 'help') cli.help(HELP);

  if (!command) {
    cli.die(
      `unknown command: ${subcommand}\nRun 'search-console --help' for usage.`,
      { prefix: 'search-console' },
    );
  }

  try {
    return await command.run(flags);
  } catch (err) {
    if (err?.name === 'NodeExitError') throw err;
    cli.die(err.message, { prefix: 'search-console' });
  }
}

await main();

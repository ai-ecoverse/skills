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

const DEFAULT_PROPERTY = 'sc-domain:sliccy.com';

/** Search Console properties are either a domain property (`sc-domain:example.com`)
 *  or a URL-prefix property (`https://example.com/`). Reject anything else up front
 *  rather than fetching a page that cannot contain a report. */
function resolveProperty(flags) {
  const property = flags.property || DEFAULT_PROPERTY;
  if (typeof property !== 'string' ||
      !(/^sc-domain:[a-z0-9.-]+$/i.test(property) || /^https?:\/\/[^\s]+$/i.test(property))) {
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
  // catch. The account-chooser machinery puts accounts.google.com/signin in the
  // GOOD page too (measured), so that is NOT a usable marker; the title is.
  const looksLikeLogin =
    /<title>[^<]*Sign in[^<]*<\/title>/i.test(body);
  if (looksLikeLogin || body.length < 1000) {
    cli.die(
      `Got a sign-in page instead of the report for "${property}".\n` +
      'The search.google.com session has expired. Open Search Console in the\n' +
      'browser, sign in, and retry.',
      { prefix: 'search-console' },
    );
  }
  return body;
}

/** Extract all AF_initDataCallback blocks from the HTML, keyed by ds:N.
 *  Each value is the parsed JSON of the `data:` field. */
function parseDataBlocks(html) {
  const blocks = {};
  const re = /AF_initDataCallback\(\{key:\s*'(ds:\d+)',\s*hash:\s*'[^']*',\s*data:([\s\S]*?),\s*sideChannel:\s*\{/g;
  for (const m of html.matchAll(re)) {
    const key = m[1];
    let raw = m[2];
    // Unescape \xNN sequences
    raw = raw.replace(/\\x([0-9a-fA-F]{2})/g, (_, hex) =>
      String.fromCharCode(parseInt(hex, 16)),
    );
    try {
      blocks[key] = JSON.parse(raw);
    } catch {
      // Record the error but don't die — caller checks required blocks.
    }
  }
  if (Object.keys(blocks).length === 0) {
    cli.die(
      'No AF_initDataCallback blocks in the response, so this is not a Search\n' +
      'Console report page. Either the session expired or the URL changed.\n' +
      'Open Search Console signed in and retry.',
      { prefix: 'search-console' },
    );
  }
  return blocks;
}

/** Parse ds:9 → { totals: {clicks,impressions,ctr,position}, daily: [...] }.
 *  Dies if the block is absent or reshaped. */
function parseTotalsAndDaily(blocks) {
  const d = blocks['ds:9'];
  if (!d) cli.die(
    'No ds:9 report block for this property. Most likely the signed-in account\n' +
    'has no access to it (check the property name against the Search Console\n' +
    'property picker). Less likely, Google reshaped the page.',
    { prefix: 'search-console' },
  );

  // data[1][1][1] = [clicks, impressions, ctr, position]
  const totalsTuple = d?.[1]?.[1]?.[1];
  if (!Array.isArray(totalsTuple) || totalsTuple.length < 4) {
    cli.die(
      'ds:9 totals tuple not found at data[1][1][1]. The UI may have reshaped.\n' +
      'Got: ' + JSON.stringify(d?.[1]?.[1]),
      { prefix: 'search-console' },
    );
  }

  const totals = {
    clicks:      totalsTuple[0],
    impressions: totalsTuple[1],
    ctr:         totalsTuple[2],
    position:    totalsTuple[3],
  };

  // Validate that totals contain numbers, not NaN or undefined.
  for (const [k, v] of Object.entries(totals)) {
    if (typeof v !== 'number' || Number.isNaN(v)) {
      cli.die(`ds:9 totals.${k} is ${v}, not a valid number.`, { prefix: 'search-console' });
    }
  }

  // data[1][0] = daily rows: [epochMs, [clicks, impressions, ctr, position], ...]
  const dailyRaw = d?.[1]?.[0];
  if (!Array.isArray(dailyRaw)) {
    cli.die('ds:9 daily rows not found at data[1][0].', { prefix: 'search-console' });
  }

  const daily = dailyRaw.map((row) => {
    const epochMs = row[0];
    const metrics = row[1]; // [clicks, impressions, ctr, position]
    if (!Array.isArray(metrics) || metrics.length < 2) return null;
    // Handle "NaN" strings for days with no data
    const clicks      = typeof metrics[0] === 'number' ? metrics[0] : 0;
    const impressions = typeof metrics[1] === 'number' ? metrics[1] : 0;
    const ctrVal      = typeof metrics[2] === 'number' ? metrics[2] : 0;
    const posVal      = typeof metrics[3] === 'number' ? metrics[3] : 0;
    return {
      date: new Date(epochMs).toISOString().slice(0, 10),
      clicks,
      impressions,
      ctr: ctrVal,
      position: posVal,
    };
  }).filter(Boolean);

  return { totals, daily };
}

/** Parse ds:16 → array of { query, clicks, impressions, ctr, position }.
 *  Dies if the block is absent or reshaped. */
function parseQueryTable(blocks) {
  const d = blocks['ds:16'];
  if (!d) cli.die(
    'No ds:16 query block for this property. Most likely the signed-in account\n' +
    'has no access to it. Less likely, Google reshaped the page.',
    { prefix: 'search-console' },
  );

  const rows = d?.[1]?.[0];
  if (!Array.isArray(rows)) {
    cli.die(
      'ds:16 query rows not found at data[1][0]. The UI may have reshaped.',
      { prefix: 'search-console' },
    );
  }

  const queries = [];
  for (const row of rows) {
    const container = row?.[0];
    if (!Array.isArray(container) || container.length < 2) continue;

    const query = container[0]?.[0];
    if (typeof query !== 'string') continue;

    let clicks = 0, impressions = 0, ctr = 0, position = 0;

    // Metric arrays: element at index 8 is the type id.
    // Type 5 = clicks (value at [1]), type 6 = impressions (value at [1]),
    // type 7 = CTR (value at long index, last non-null), type 8 = position (ditto).
    for (let i = 1; i < container.length; i++) {
      const metric = container[i];
      if (!Array.isArray(metric)) continue;
      const typeId = metric[8];
      if (typeId === 5)      clicks      = metric[1] || 0;
      else if (typeId === 6) impressions = metric[1] || 0;
      else if (typeId === 7) {
        // CTR is at the last non-null position after index 8
        for (let j = metric.length - 1; j > 8; j--) {
          if (metric[j] != null) { ctr = metric[j]; break; }
        }
      } else if (typeId === 8) {
        for (let j = metric.length - 1; j > 8; j--) {
          if (metric[j] != null) { position = metric[j]; break; }
        }
      }
    }

    queries.push({ query, clicks, impressions, ctr, position });
  }

  // Sort by clicks desc, then impressions desc.
  queries.sort((a, b) => b.clicks - a.clicks || b.impressions - a.impressions);
  return queries;
}

/** Extract the displayed scorecard values from the HTML for cross-checking.
 *  Returns { clicks, impressions, ctrPct, position } as the page renders them. */
function parseUIScoreconds(html) {
  // The scorecard label appears multiple times (in data attributes, aria labels,
  // and the rendered text). The rendered scorecard uses this specific pattern:
  //   >Total clicks</span></div><div class="nnLLaf ... title="196">196</div>
  // We match on ">Label</span></div><div class=\"nnLLaf" to hit the right one.
  const result = {};
  const labels = [
    { label: 'Total clicks',      key: 'clicks' },
    { label: 'Total impressions', key: 'impressions' },
    { label: 'Average CTR',       key: 'ctrPct' },
    { label: 'Average position',  key: 'position' },
  ];
  for (const { label, key } of labels) {
    const needle = '>' + label + '</span></div><div class="nnLLaf';
    const idx = html.indexOf(needle);
    if (idx < 0) continue;
    const after = html.slice(idx, idx + 300);
    const tm = after.match(/title="([^"]+)"/);
    if (tm) result[key] = tm[1];
  }
  return result;
}

/** Parse a UI-formatted number: "196" → 196, "2,790" → 2790, "2.79K" → ~2790. */
function parseUINumber(s) {
  if (!s) return NaN;
  // Remove commas
  const n = s.replace(/,/g, '');
  // Handle K suffix
  if (n.endsWith('K')) return parseFloat(n.slice(0, -1)) * 1000;
  if (n.endsWith('M')) return parseFloat(n.slice(0, -1)) * 1_000_000;
  // Handle % suffix
  if (n.endsWith('%')) return parseFloat(n.slice(0, -1));
  return parseFloat(n);
}

// ─── Commands ─────────────────────────────────────────────────────────────────

async function cmdPerformance(flags) {
  const property = resolveProperty(flags);
  const tab = await findGSCTab();
  const html = await fetchGSCPage(tab, property);
  const blocks = parseDataBlocks(html);
  const { totals, daily } = parseTotalsAndDaily(blocks);

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
  const blocks = parseDataBlocks(html);
  const { totals } = parseTotalsAndDaily(blocks);
  const queries = parseQueryTable(blocks);

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
  const blocks = parseDataBlocks(html);
  const { totals } = parseTotalsAndDaily(blocks);

  const ui = parseUIScoreconds(html);
  const errors = [];

  // --- Clicks: exact match ---
  if (ui.clicks != null) {
    const uiClicks = parseUINumber(ui.clicks);
    if (totals.clicks !== uiClicks) {
      errors.push(
        `Clicks mismatch: parsed ds:9 = ${totals.clicks}, UI displays "${ui.clicks}" (${uiClicks})`,
      );
    }
  } else {
    errors.push('Could not find "Total clicks" scorecard in the page HTML.');
  }

  // --- Impressions: tolerance for K/M abbreviation ---
  if (ui.impressions != null) {
    const uiImpressions = parseUINumber(ui.impressions);
    // The UI title= attribute has the exact number (e.g. "2,790"), but the
    // displayed text uses "2.79K". We parse the title, so compare exactly
    // when title is the raw number, or with ±5% tolerance for abbreviations.
    const diff = Math.abs(totals.impressions - uiImpressions);
    const tol = uiImpressions * 0.01; // 1% tolerance for rounding
    if (diff > tol) {
      errors.push(
        `Impressions mismatch: parsed ds:9 = ${totals.impressions}, ` +
        `UI displays "${ui.impressions}" (${uiImpressions}), diff=${diff}`,
      );
    }
  } else {
    errors.push('Could not find "Total impressions" scorecard in the page HTML.');
  }

  // --- CTR: tolerance for percentage rounding ---
  if (ui.ctrPct != null) {
    const uiCtrPct = parseUINumber(ui.ctrPct);
    const parsedCtrPct = totals.ctr * 100;
    // UI shows "7%" which is Math.round(7.025…) — allow ±1pp tolerance.
    if (Math.abs(parsedCtrPct - uiCtrPct) > 1.0) {
      errors.push(
        `CTR mismatch: parsed ds:9 = ${parsedCtrPct.toFixed(2)}%, ` +
        `UI displays "${ui.ctrPct}" (${uiCtrPct}%)`,
      );
    }
  } else {
    errors.push('Could not find "Average CTR" scorecard in the page HTML.');
  }

  // --- Position: tolerance for rounding ---
  if (ui.position != null) {
    const uiPos = parseUINumber(ui.position);
    if (Math.abs(totals.position - uiPos) > 0.15) {
      errors.push(
        `Position mismatch: parsed ds:9 = ${totals.position.toFixed(2)}, ` +
        `UI displays "${ui.position}" (${uiPos})`,
      );
    }
  } else {
    errors.push('Could not find "Average position" scorecard in the page HTML.');
  }

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

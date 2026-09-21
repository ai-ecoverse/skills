// Pure parsing, validation and cross-check logic for search-console.jsh.
//
// Deliberately free of `sliccy:*`, `fs` and `path` so the tst suite can import it
// in the test realm (CLAUDE.md §16). Nothing here does I/O or exits the process:
// a bad page raises GscParseError and the caller decides how to report it. That
// keeps the branch that decides "the numbers are wrong" testable without a live
// Search Console session.

/** Conservative row count above which the inline query table is assumed to be
 *  capped rather than complete. Not a documented figure. */
const QUERY_TABLE_ROW_CAP = 1000;

/** Dimension ids Search Console tags a breakdown table with, at
 *  `data[0][5][0][0]`. Verified 2026-09-21 by fetching each breakdown and reading
 *  the id beside the table's own dimension name ("QUERIES", "PAGES", ...). */
const DIMENSION = { date: 1, query: 2, page: 3, country: 4, searchAppearance: 8 };

/** The active breakdown table always lands in ds:16, whatever dimension it holds:
 *  with no `breakdown` parameter that is the query table (id 2), with
 *  `breakdown=page` the page table (id 3). Same key, different content — so the id
 *  has to be checked, or an ignored parameter would print query strings under a
 *  "Page" heading. */
const BREAKDOWN_BLOCK = 'ds:16';

/** Where a page row keeps its URL inside the row label array. Measured: the label
 *  is 41 long with the URL at 40 and nothing else but a `1` at 16, on every row of
 *  the unfiltered and both filtered page reports (2026-09-21). Query rows put
 *  their label at [0] instead, so the two are not interchangeable. */
const PAGE_URL_INDEX = 40;

/** Operator ids in an echoed query filter, read off the URLs the Search Console UI
 *  itself produces: "Exact query" gives `&query=!slicc` and echoes operator 1;
 *  "Queries containing" gives `&query=*slicc` and echoes operator 2. */
const QUERY_FILTER_OPERATOR = { exact: 1, contains: 2 };

/** The operator prefix this skill sends. Exact, not "contains": "which page earned
 *  the impressions for this query" is a question about one query, and `*slicc`
 *  folds in `sliccy` and `slicc ai` (measured: 4 pages / 527 impressions for
 *  `*slicc` against 2 pages / 380 for `!slicc`). */
const EXACT_QUERY_PREFIX = '!';

class GscParseError extends Error {
  constructor(message) {
    super(message);
    this.name = 'GscParseError';
  }
}

function fail(message) {
  throw new GscParseError(message);
}

/** Search Console properties are either a domain property (`sc-domain:example.com`)
 *  or a URL-prefix property (`https://example.com/`). Anything else cannot address
 *  a report, so it is rejected before a page is fetched. */
function isValidProperty(property) {
  if (typeof property !== 'string') return false;
  return /^sc-domain:[a-z0-9.-]+$/i.test(property) || /^https?:\/\/[^\s]+$/i.test(property);
}

/** The Google account slot ("/u/N/") a Search Console tab is signed in under.
 *  Returns null when the URL carries no slot.
 *
 *  This must be taken from the tab rather than hard-coded: requesting a report
 *  under the wrong slot returns HTTP 200 with an "Oops, you don't have access to
 *  this property" page, so the mistake reads exactly like a missing permission.
 *  Measured: /u/1 returns the report (20 data blocks), /u/0 and /u/7 return the
 *  no-access page (6 blocks) for the same property. */
function accountSlotFromUrl(url) {
  const m = /^https?:\/\/search\.google\.com\/u\/(\d+)(?:\/|$)/.exec(String(url || ''));
  return m ? m[1] : null;
}

/** Build the performance report URL for a property, under a given account slot.
 *
 *  `hl=en` is forced deliberately. A localized report renames the scorecards
 *  ("Klicks insgesamt"), which alone would only break `verify`; the real hazard
 *  is that it also localizes NUMBER FORMAT, rendering 2778 as title="2.778" and
 *  6.9% as "6,9 %". Parsed with English rules that silently becomes 2.778 — a
 *  wrong number rather than an error. Measured against hl=de.
 *
 *  `opts.breakdown` selects which table is inlined into ds:16 ('page' for page
 *  rows) and `opts.query` adds an exact-query filter. Both parameter shapes were
 *  taken from the URLs the Search Console UI produced when its own Pages tab and
 *  "Exact query" filter were clicked, rather than invented. */
function buildReportUrl(property, slot, opts = {}) {
  const seg = slot == null ? '' : `/u/${slot}`;
  let url =
    `https://search.google.com${seg}/search-console/performance/search-analytics` +
    `?resource_id=${encodeURIComponent(property)}&hl=en`;
  if (opts.breakdown) url += `&breakdown=${encodeURIComponent(opts.breakdown)}`;
  if (opts.query) url += `&query=${EXACT_QUERY_PREFIX}${encodeURIComponent(opts.query)}`;
  return url;
}

/** What to tell the user when the no-access page comes back.
 *
 *  The cause differs by whether the tab carried an account slot, and so does the
 *  fix, so the two are not collapsed into one message. Measured: a URL with no
 *  "/u/N/" segment also returns the no-access page, so a slotless tab is a real
 *  failure path rather than a harmless default. */
function noAccessMessage(property, slot) {
  if (slot == null) {
    return (
      `Search Console reports no access to "${property}".\n` +
      'The browser tab URL carries no /u/N/ account slot, and a slotless request\n' +
      'is not served the report. Reload Search Console in the tab (Google adds the\n' +
      'slot on navigation) and retry. If the tab already shows the property, check\n' +
      'the property name against the property picker.'
    );
  }
  return (
    `Search Console reports no access to "${property}" for account slot /u/${slot}/.\n` +
    'Either the property name does not match one in the property picker, or the\n' +
    'tab is signed in as a different Google account than the one the property\n' +
    'belongs to. Both return this same page.'
  );
}

/** Search Console answers a request for a property the signed-in account cannot
 *  see with HTTP 200 and this page, not with 403. */
function looksLikeNoAccessPage(html) {
  return /<title>[^<]*don(?:&#39;|&#x27;|')t have access to this property/i.test(String(html));
}

/** A dead session does NOT 404: the fetch follows the redirect and returns 200
 *  with a Google sign-in page, far larger than any size heuristic would catch.
 *
 *  Note the marker that is NOT used: the signed-in report page also contains
 *  `accounts.google.com/signin`, from the account-chooser markup. Measured, not
 *  assumed — matching on it would refuse every valid page. The page title is a
 *  real discriminator, and the absence of report blocks is the stronger one. */
function looksLikeSignInPage(html) {
  if (typeof html !== 'string') return false;
  return /<title>[^<]*Sign in[^<]*<\/title>/i.test(html);
}

/** Search Console inlines its report as AF_initDataCallback blocks. Returns
 *  { 'ds:N': <parsed JSON> }. Raises when the response carries none, which means
 *  the response is not a report page at all. */
function parseDataBlocks(html) {
  const blocks = {};
  const re = /AF_initDataCallback\(\{key:\s*'(ds:\d+)',\s*hash:\s*'[^']*',\s*data:([\s\S]*?),\s*sideChannel:\s*\{/g;
  for (const m of String(html).matchAll(re)) {
    const key = m[1];
    let raw = m[2];
    // Unescape \xNN sequences.
    raw = raw.replace(/\\x([0-9a-fA-F]{2})/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)));
    try {
      blocks[key] = JSON.parse(raw);
    } catch {
      // Skip an unparseable block rather than dying — the caller checks for the
      // specific blocks it needs, and one malformed unrelated block is survivable.
    }
  }
  if (Object.keys(blocks).length === 0) {
    fail(
      'No AF_initDataCallback blocks in the response, so this is not a Search\n' +
      'Console report page. Either the session expired or the URL changed.\n' +
      'Open Search Console signed in and retry.',
    );
  }
  return blocks;
}

/** Parse ds:9 → { totals: {clicks,impressions,ctr,position}, daily: [...] }.
 *
 *  Totals come from the totals tuple and NEVER from summing the query table:
 *  Search Console omits anonymised rare queries from the table while still
 *  counting them in the totals, so a table sum under-reports badly.
 *
 *  `opts.allowNoData` covers one measured shape that is not a reshape: a filtered
 *  report matching nothing returns the tuple [0, 0, "NaN", "NaN"], because a CTR
 *  and a position are undefined with no impressions. Only the two ratios may be
 *  non-numeric, and only while both counts are zero, so the guard against a
 *  reshaped index still fires on everything else. */
function parseTotalsAndDaily(blocks, opts = {}) {
  const d = blocks['ds:9'];
  if (!d) {
    fail(
      'No ds:9 report block for this property. Most likely the signed-in account\n' +
      'has no access to it (check the property name against the Search Console\n' +
      'property picker). Less likely, Google reshaped the page.',
    );
  }

  // data[1][1][1] = [clicks, impressions, ctr, position]
  const totalsTuple = d?.[1]?.[1]?.[1];
  if (!Array.isArray(totalsTuple) || totalsTuple.length < 4) {
    fail(
      'ds:9 totals tuple not found at data[1][1][1]. The UI may have reshaped.\n' +
      `Got: ${JSON.stringify(d?.[1]?.[1])}`,
    );
  }

  const totals = {
    clicks: totalsTuple[0],
    impressions: totalsTuple[1],
    ctr: totalsTuple[2],
    position: totalsTuple[3],
  };

  const noData =
    opts.allowNoData === true && totals.clicks === 0 && totals.impressions === 0;
  if (noData) {
    if (typeof totals.ctr !== 'number' || Number.isNaN(totals.ctr)) totals.ctr = 0;
    if (typeof totals.position !== 'number' || Number.isNaN(totals.position)) totals.position = 0;
  }

  // A reshape that lands a string or undefined here would otherwise print as a
  // confident wrong number, so reject non-numbers explicitly.
  for (const [k, v] of Object.entries(totals)) {
    if (typeof v !== 'number' || Number.isNaN(v)) {
      fail(`ds:9 totals.${k} is ${v}, not a valid number.`);
    }
  }

  // data[1][0] = daily rows: [epochMs, [clicks, impressions, ctr, position], ...]
  const dailyRaw = d?.[1]?.[0];
  if (!Array.isArray(dailyRaw)) {
    fail('ds:9 daily rows not found at data[1][0].');
  }

  const daily = dailyRaw
    .map((row) => {
      const epochMs = row[0];
      const metrics = row[1];
      if (!Array.isArray(metrics) || metrics.length < 2) return null;
      // Days with no data carry "NaN" strings rather than numbers.
      return {
        date: new Date(epochMs).toISOString().slice(0, 10),
        clicks: typeof metrics[0] === 'number' ? metrics[0] : 0,
        impressions: typeof metrics[1] === 'number' ? metrics[1] : 0,
        ctr: typeof metrics[2] === 'number' ? metrics[2] : 0,
        position: typeof metrics[3] === 'number' ? metrics[3] : 0,
      };
    })
    .filter(Boolean);

  return { totals, daily };
}

/** Decode the metric arrays of one table row, for any dimension.
 *
 *  Metric arrays are self-describing: element 8 is a type id, so metrics are read
 *  by tag rather than by column order. 5 = clicks, 6 = impressions, 7 = CTR,
 *  8 = position. Clicks/impressions carry the value at [1]; the two ratios carry
 *  it in a trailing slot, so the last non-null element is taken. Page rows use the
 *  identical encoding as query rows — checked, not assumed: a page row's clicks
 *  and impressions arrays are also 9 long with the value at [1], and its CTR and
 *  position arrays 45 and 44 long with the value last. */
function readRowMetrics(container) {
  let clicks = 0;
  let impressions = 0;
  let ctr = 0;
  let position = 0;

  for (let i = 1; i < container.length; i++) {
    const metric = container[i];
    if (!Array.isArray(metric)) continue;
    const typeId = metric[8];
    if (typeId === 5) {
      clicks = metric[1] || 0;
    } else if (typeId === 6) {
      impressions = metric[1] || 0;
    } else if (typeId === 7 || typeId === 8) {
      let value = 0;
      for (let j = metric.length - 1; j > 8; j--) {
        if (metric[j] != null) {
          value = metric[j];
          break;
        }
      }
      if (typeId === 7) ctr = value;
      else position = value;
    }
  }

  return { clicks, impressions, ctr, position };
}

/** The dimension id of the breakdown table currently inlined into ds:16, or null
 *  when the block or the tag is absent. */
function tableDimensionId(blocks, key = BREAKDOWN_BLOCK) {
  const id = blocks?.[key]?.[0]?.[5]?.[0]?.[0];
  return typeof id === 'number' ? id : null;
}

/** Parse ds:16 → array of { query, clicks, impressions, ctr, position },
 *  sorted by clicks then impressions, both descending. */
function parseQueryTable(blocks) {
  const d = blocks['ds:16'];
  if (!d) {
    fail(
      'No ds:16 query block for this property. Most likely the signed-in account\n' +
      'has no access to it. Less likely, Google reshaped the page.',
    );
  }

  const rows = d?.[1]?.[0];
  if (!Array.isArray(rows)) {
    fail('ds:16 query rows not found at data[1][0]. The UI may have reshaped.');
  }

  // ds:16 holds whichever breakdown the URL asked for, so a request that
  // accidentally carried breakdown=page would fill this table with page URLs.
  // Refuse that rather than listing URLs in a column headed "Query".
  if (tableDimensionId(blocks) === DIMENSION.page) {
    fail(
      'ds:16 holds the page table (dimension 3), not the query table. The request\n' +
      'asked for the page breakdown. This is a bug in search-console, not in the\n' +
      'Search Console page.',
    );
  }

  const queries = [];
  for (const row of rows) {
    const container = row?.[0];
    if (!Array.isArray(container) || container.length < 2) continue;

    const query = container[0]?.[0];
    if (typeof query !== 'string') continue;

    queries.push({ query, ...readRowMetrics(container) });
  }

  queries.sort((a, b) => b.clicks - a.clicks || b.impressions - a.impressions);
  return queries;
}

/** Parse the page breakdown (ds:16 fetched with `breakdown=page`) into an array of
 *  { page, clicks, impressions, ctr, position }, sorted by clicks then impressions,
 *  both descending.
 *
 *  Two guards matter more than the decoding:
 *
 *  1. The dimension id is checked. The page table occupies the SAME ds:16 key as
 *     the query table; if `breakdown=page` were renamed by a UI release the
 *     response would be a perfectly well-formed QUERY table, and a parser that
 *     only read offsets would print `sliccy` and `slicc ai` as if they were URLs.
 *  2. Rows that carry no URL at the measured index fail the whole parse rather
 *     than being skipped. Skipping would turn a shifted label index into a silent
 *     "no pages found", which reads like a property with no traffic. */
function parsePageTable(blocks) {
  const d = blocks[BREAKDOWN_BLOCK];
  if (!d) {
    fail(
      'No ds:16 page block for this property. Most likely the signed-in account\n' +
      'has no access to it. Less likely, Google reshaped the page.',
    );
  }

  const dim = tableDimensionId(blocks);
  if (dim !== DIMENSION.page) {
    fail(
      `ds:16 carries dimension ${dim === null ? 'none' : dim}, not the page` +
      ` dimension (${DIMENSION.page}).\n` +
      'The breakdown=page parameter was not honoured, so these rows are some other\n' +
      'breakdown — query rows would otherwise be printed as page URLs. Check\n' +
      'whether the Search Console UI still uses &breakdown=page for its Pages tab.',
    );
  }

  // A filter that matches nothing returns data[1][0] = null, not an empty array.
  // Measured with an exact-query filter on a query the property never served.
  const rows = d?.[1]?.[0];
  if (rows === null || rows === undefined) return [];
  if (!Array.isArray(rows)) {
    fail('ds:16 page rows not found at data[1][0]. The UI may have reshaped.');
  }

  const pages = [];
  let unlabelled = 0;
  for (const row of rows) {
    const container = row?.[0];
    if (!Array.isArray(container) || container.length < 2) {
      unlabelled++;
      continue;
    }

    const page = container[0]?.[PAGE_URL_INDEX];
    if (typeof page !== 'string' || !/^https?:\/\//.test(page)) {
      unlabelled++;
      continue;
    }

    pages.push({ page, ...readRowMetrics(container) });
  }

  if (unlabelled > 0 && pages.length === 0) {
    fail(
      `ds:16 returned ${unlabelled} page rows but no URL at label index ` +
      `${PAGE_URL_INDEX} in any of them.\n` +
      'The row label has probably been reshaped. Reporting "no pages" here would\n' +
      'read like a property with no traffic, so this fails instead.',
    );
  }

  pages.sort((a, b) => b.clicks - a.clicks || b.impressions - a.impressions);
  return pages;
}

/** The filters Search Console echoes back in a block header, at data[0][5][3].
 *  Returns [{ dimensionId, values, operator }]. The search-type entry
 *  (dimension 6, ["WEB"]) is present on every report and comes back with it.
 *
 *  This echo is what makes a filter verifiable rather than hoped-for: the request
 *  puts the filter in the URL, and the response states which filters it applied. */
function appliedFilters(blocks, key = BREAKDOWN_BLOCK) {
  const raw = blocks?.[key]?.[0]?.[5]?.[3];
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((f) => Array.isArray(f))
    .map((f) => ({
      dimensionId: f[0],
      values: Array.isArray(f[1]) ? f[1] : [],
      operator: typeof f[2] === 'number' ? f[2] : null,
    }));
}

/** Raise unless the response states it applied the exact-query filter that was
 *  requested, on BOTH the table block and the totals block.
 *
 *  Without this the failure mode is the worst kind: an unrecognised or renamed URL
 *  parameter is ignored, Search Console returns HTTP 200 with the UNFILTERED
 *  report, and "pages for the query X" silently becomes "all pages". Checking ds:9
 *  as well as ds:16 matters because the totals printed beside the table have to be
 *  the filtered totals; an unfiltered ds:9 would make a 380-impression query look
 *  like a 2778-impression one. */
function assertQueryFilterApplied(blocks, query, keys = [BREAKDOWN_BLOCK, 'ds:9']) {
  const wanted = String(query).trim().toLowerCase();
  for (const key of keys) {
    const filters = appliedFilters(blocks, key);
    const match = filters.find(
      (f) =>
        f.dimensionId === DIMENSION.query &&
        f.values.some((v) => String(v).trim().toLowerCase() === wanted),
    );
    if (!match) {
      const seen = filters.length
        ? filters.map((f) => `[${f.dimensionId}, ${JSON.stringify(f.values)}, ${f.operator}]`).join(' ')
        : 'none';
      fail(
        `Search Console did not apply the query filter "${query}" to ${key}.\n` +
        `Filters it reports for that block: ${seen}\n` +
        'The response is therefore the unfiltered report and these rows would not\n' +
        'be the pages for that query. Most likely Search Console changed the\n' +
        '&query= filter parameter; check what its own UI puts in the URL.',
      );
    }
    if (match.operator !== QUERY_FILTER_OPERATOR.exact) {
      fail(
        `Search Console applied the query filter "${query}" to ${key} with operator ` +
        `${match.operator}, not exact (${QUERY_FILTER_OPERATOR.exact}).\n` +
        'A "contains" match would fold in every query containing this string, so the\n' +
        'rows would not belong to this query alone.',
      );
    }
  }
}

/** How the page table relates to the totals for the same period.
 *
 *  Unlike the query table, the page table can OVERSHOOT the totals. Measured on
 *  sc-domain:sliccy.com, 2026-09-21: 8 page rows summing to 194 clicks /
 *  3569 impressions against property totals of 192 / 2778 — 28% more impressions
 *  than the property earned. So neither direction of difference may be presented
 *  as "the rest is anonymised", and the column must never be summed into a total.
 *
 *  `exceedsTotals` distinguishes the two cases for the caller, which needs
 *  different wording for each. */
function pageTableDelta(totals, pages) {
  const pageClicks = pages.reduce((a, p) => a + p.clicks, 0);
  const pageImpressions = pages.reduce((a, p) => a + p.impressions, 0);
  const clickDelta = pageClicks - totals.clicks;
  const impressionDelta = pageImpressions - totals.impressions;
  return {
    pageClicks,
    pageImpressions,
    clickDelta,
    impressionDelta,
    clickDeltaPct: totals.clicks ? (clickDelta / totals.clicks) * 100 : 0,
    impressionDeltaPct: totals.impressions ? (impressionDelta / totals.impressions) * 100 : 0,
    exceedsTotals: clickDelta > 0 || impressionDelta > 0,
  };
}

/** Extract the values the page itself renders in its scorecards, for cross-checking.
 *  Returns { clicks, impressions, ctrPct, position } as display strings.
 *
 *  Each label also appears in data attributes and aria labels, so the match is
 *  anchored on the rendered scorecard's markup and reads the exact number from
 *  `title=` (the visible text may be abbreviated, e.g. "2.79K"). */
function parseUIScorecards(html) {
  const result = {};
  const labels = [
    { label: 'Total clicks', key: 'clicks' },
    { label: 'Total impressions', key: 'impressions' },
    { label: 'Average CTR', key: 'ctrPct' },
    { label: 'Average position', key: 'position' },
  ];
  for (const { label, key } of labels) {
    const needle = `>${label}</span></div><div class="nnLLaf`;
    const idx = String(html).indexOf(needle);
    if (idx < 0) continue;
    const after = String(html).slice(idx, idx + 300);
    const tm = after.match(/title="([^"]+)"/);
    if (tm) result[key] = tm[1];
  }
  return result;
}

/** Parse a UI-formatted number: "196" → 196, "2,790" → 2790, "2.79K" → 2790. */
function parseUINumber(s) {
  if (!s) return NaN;
  const n = String(s).replace(/,/g, '');
  if (n.endsWith('K')) return parseFloat(n.slice(0, -1)) * 1000;
  if (n.endsWith('M')) return parseFloat(n.slice(0, -1)) * 1_000_000;
  if (n.endsWith('%')) return parseFloat(n.slice(0, -1));
  return parseFloat(n);
}

/** The share of traffic the query table cannot account for, because Search Console
 *  drops anonymised rare queries from the table but counts them in the totals.
 *  Reported explicitly so nobody assumes the columns add up to the totals. */
function anonymisedGap(totals, queries) {
  const namedClicks = queries.reduce((a, q) => a + q.clicks, 0);
  const namedImpressions = queries.reduce((a, q) => a + q.impressions, 0);
  // The inline table is not guaranteed to hold every named query: a large
  // property's table is capped, and the rows beyond the cap are ordinary named
  // queries, not anonymised ones. When the row count is at or above the cap the
  // gap can no longer be attributed to anonymisation alone, so say so instead of
  // labelling it wrongly. The exact cap is not documented and could not be
  // measured here (the property under test returns 78 rows), so this is a
  // conservative threshold, not a verified constant.
  const clickGap = totals.clicks - namedClicks;
  const impressionGap = totals.impressions - namedImpressions;
  return {
    namedClicks,
    namedImpressions,
    clickGap,
    impressionGap,
    tableLikelyTruncated: queries.length >= QUERY_TABLE_ROW_CAP,
    clickGapPct: totals.clicks ? (clickGap / totals.clicks) * 100 : 0,
    impressionGapPct: totals.impressions ? (impressionGap / totals.impressions) * 100 : 0,
  };
}

/** Cross-check parsed totals against the scorecards the page rendered, and return
 *  a list of human-readable problems ([] means agreement).
 *
 *  This exists because the failure mode of reading positional arrays is WRONG
 *  NUMBERS, not an error: a UI release shifts an index and the tool keeps printing
 *  confidently. Note each missing scorecard is itself an error — if the reference
 *  silently disappeared, a comparison that skipped it would start passing
 *  everything, so the check fails closed.
 *
 *  Tolerances absorb display rounding only: impressions ±1% (abbreviation),
 *  CTR ±1 percentage point ("7%" for 7.025…), position ±0.15. Clicks are exact. */
function compareTotalsWithUI(totals, ui) {
  const errors = [];

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

  if (ui.impressions != null) {
    const uiImpressions = parseUINumber(ui.impressions);
    const diff = Math.abs(totals.impressions - uiImpressions);
    if (diff > uiImpressions * 0.01) {
      errors.push(
        `Impressions mismatch: parsed ds:9 = ${totals.impressions}, ` +
          `UI displays "${ui.impressions}" (${uiImpressions}), diff=${diff}`,
      );
    }
  } else {
    errors.push('Could not find "Total impressions" scorecard in the page HTML.');
  }

  if (ui.ctrPct != null) {
    const uiCtrPct = parseUINumber(ui.ctrPct);
    const parsedCtrPct = totals.ctr * 100;
    if (Math.abs(parsedCtrPct - uiCtrPct) > 1.0) {
      errors.push(
        `CTR mismatch: parsed ds:9 = ${parsedCtrPct.toFixed(2)}%, ` +
          `UI displays "${ui.ctrPct}" (${uiCtrPct}%)`,
      );
    }
  } else {
    errors.push('Could not find "Average CTR" scorecard in the page HTML.');
  }

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

  return errors;
}

module.exports = {
  GscParseError,
  QUERY_TABLE_ROW_CAP,
  DIMENSION,
  BREAKDOWN_BLOCK,
  PAGE_URL_INDEX,
  QUERY_FILTER_OPERATOR,
  accountSlotFromUrl,
  buildReportUrl,
  looksLikeNoAccessPage,
  noAccessMessage,
  isValidProperty,
  looksLikeSignInPage,
  parseDataBlocks,
  parseTotalsAndDaily,
  parseQueryTable,
  parsePageTable,
  tableDimensionId,
  appliedFilters,
  assertQueryFilterApplied,
  pageTableDelta,
  parseUIScorecards,
  parseUINumber,
  anonymisedGap,
  compareTotalsWithUI,
};

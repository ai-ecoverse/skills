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
 *  wrong number rather than an error. Measured against hl=de. */
function buildReportUrl(property, slot) {
  const seg = slot == null ? '' : `/u/${slot}`;
  return (
    `https://search.google.com${seg}/search-console/performance/search-analytics` +
    `?resource_id=${encodeURIComponent(property)}&hl=en`
  );
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
 *  counting them in the totals, so a table sum under-reports badly. */
function parseTotalsAndDaily(blocks) {
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

  const queries = [];
  for (const row of rows) {
    const container = row?.[0];
    if (!Array.isArray(container) || container.length < 2) continue;

    const query = container[0]?.[0];
    if (typeof query !== 'string') continue;

    let clicks = 0;
    let impressions = 0;
    let ctr = 0;
    let position = 0;

    // Metric arrays are self-describing: element 8 is a type id, so metrics are
    // read by tag rather than by column order. 5 = clicks, 6 = impressions,
    // 7 = CTR, 8 = position. Clicks/impressions carry the value at [1]; the two
    // ratios carry it in a trailing slot, so take the last non-null.
    for (let i = 1; i < container.length; i++) {
      const metric = container[i];
      if (!Array.isArray(metric)) continue;
      const typeId = metric[8];
      if (typeId === 5) {
        clicks = metric[1] || 0;
      } else if (typeId === 6) {
        impressions = metric[1] || 0;
      } else if (typeId === 7) {
        for (let j = metric.length - 1; j > 8; j--) {
          if (metric[j] != null) {
            ctr = metric[j];
            break;
          }
        }
      } else if (typeId === 8) {
        for (let j = metric.length - 1; j > 8; j--) {
          if (metric[j] != null) {
            position = metric[j];
            break;
          }
        }
      }
    }

    queries.push({ query, clicks, impressions, ctr, position });
  }

  queries.sort((a, b) => b.clicks - a.clicks || b.impressions - a.impressions);
  return queries;
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
  accountSlotFromUrl,
  buildReportUrl,
  looksLikeNoAccessPage,
  noAccessMessage,
  isValidProperty,
  looksLikeSignInPage,
  parseDataBlocks,
  parseTotalsAndDaily,
  parseQueryTable,
  parseUIScorecards,
  parseUINumber,
  anonymisedGap,
  compareTotalsWithUI,
};

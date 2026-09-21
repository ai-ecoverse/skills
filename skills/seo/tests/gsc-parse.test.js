import test, { is, ok, throws } from 'tst';
import * as mod from '../scripts/gsc-parse.js';

const P = mod.default || mod;

// ─── Fixtures ────────────────────────────────────────────────────────────────
//
// Shapes copied from a live sc-domain:sliccy.com report on 2026-09-21, not
// invented: the totals tuple, a daily row, and a ds:16 query row with its four
// metric arrays at the real lengths (clicks/impressions carry the value at [1];
// CTR and position carry it in a trailing slot, 44 and 43 here). A fixture that
// guessed those offsets would prove nothing about the real parser. Inlined as
// literals because the test realm cannot require `fs` (CLAUDE.md §16).

const TOTALS_TUPLE = [196, 2790, 0.07025089605734768, 11.554121863799283];

/** A metric array tagged with `typeId` at index 8, value at index 1. */
const countMetric = (typeId, value) => {
  const a = new Array(9).fill(null);
  a[1] = value;
  a[8] = typeId;
  return a;
};

/** A ratio metric: tag at 8, value in a trailing slot (as Search Console emits). */
const ratioMetric = (typeId, value, len) => {
  const a = new Array(len).fill(null);
  a[8] = typeId;
  a[len - 1] = value;
  return a;
};

const queryRow = (name, clicks, impressions, ctr, position) => {
  const label = new Array(17).fill(null);
  label[0] = name;
  label[16] = 1;
  return [
    [
      label,
      countMetric(5, clicks),
      countMetric(6, impressions),
      ratioMetric(7, ctr, 45),
      ratioMetric(8, position, 44),
    ],
  ];
};

const ds9 = (totals = TOTALS_TUPLE) => ({
  'ds:9': [
    null,
    [
      [[1781870400000, [4, 29, 0.13793103448275862, 14.448275862068966], null, null, null, null, 1781870400000]],
      [null, totals],
    ],
  ],
});

const ds16 = (rows) => ({ 'ds:16': [null, [rows]] });

const scorecard = (label, title) =>
  `<span>${label}</span></div><div class="nnLLaf vtZz6e" title="${title}">${title}</div>`;

const REAL_UI = { clicks: '196', impressions: '2,790', ctrPct: '7%', position: '11.6' };
const REAL_TOTALS = { clicks: 196, impressions: 2790, ctr: 0.07025089605734768, position: 11.554121863799283 };

// ─── The cross-check that guards every number this skill prints ──────────────
//
// Reading positional arrays fails by printing WRONG NUMBERS, not by erroring, so
// these are the assertions that matter most.

test('parsed totals agreeing with the rendered scorecards reports no problems', () => {
  is(P.compareTotalsWithUI(REAL_TOTALS, REAL_UI).length, 0);
});

test('a reshaped index that yields a plausible wrong number is caught', () => {
  // The exact defect a UI release causes: totals read from the first daily row
  // (4 clicks / 29 impressions) instead of the totals tuple. Both are plausible
  // numbers; only the comparison against the page can tell them apart.
  const errors = P.compareTotalsWithUI(
    { clicks: 4, impressions: 29, ctr: 0.1379, position: 14.45 },
    REAL_UI,
  );
  is(errors.length, 4);
  ok(errors[0].includes('Clicks mismatch'));
  ok(errors[0].includes('196'), 'the error must quote what the page displayed');
});

test('a missing scorecard is an error, so the check cannot pass vacuously', () => {
  // If Google renames the scorecard class, the reference disappears. A comparison
  // that merely skipped the absent value would start passing everything — the
  // guard would evaporate exactly when the page changed. It must fail closed.
  const errors = P.compareTotalsWithUI(REAL_TOTALS, {});
  is(errors.length, 4);
  ok(errors.some((e) => e.includes('"Total clicks" scorecard')));
  ok(errors.some((e) => e.includes('"Average position" scorecard')));
});

test('display rounding is tolerated but a real divergence is not', () => {
  // The page rounds 7.025…% to "7%" and abbreviates; that must not be an error.
  is(P.compareTotalsWithUI(REAL_TOTALS, { ...REAL_UI, impressions: '2.79K' }).length, 0);
  // Ten times the impressions is not rounding.
  const errors = P.compareTotalsWithUI({ ...REAL_TOTALS, impressions: 27900 }, REAL_UI);
  is(errors.length, 1);
  ok(errors[0].includes('Impressions mismatch'));
});

// ─── Totals come from ds:9, never from the query table ───────────────────────

test('totals are read from the totals tuple', () => {
  const { totals } = P.parseTotalsAndDaily(ds9());
  is(totals.clicks, 196);
  is(totals.impressions, 2790);
  is(totals.position, 11.554121863799283);
});

test('the daily series is parsed, and a no-data day reads as zero rather than NaN', () => {
  const blocks = ds9();
  blocks['ds:9'][1][0].push([1781956800000, ['NaN', 'NaN', 'NaN', 'NaN']]);
  const { daily } = P.parseTotalsAndDaily(blocks);
  is(daily.length, 2);
  is(daily[0].clicks, 4);
  is(daily[0].date, '2026-06-19');
  is(daily[1].clicks, 0);
  is(daily[1].impressions, 0);
});

test('a reshaped totals tuple raises instead of returning a wrong number', () => {
  const blocks = ds9();
  blocks['ds:9'][1][1] = [null, 'not-a-tuple'];
  throws(() => P.parseTotalsAndDaily(blocks), /totals tuple not found/);
});

test('a non-numeric total raises rather than printing undefined as a figure', () => {
  throws(() => P.parseTotalsAndDaily(ds9([196, undefined, 0.07, 11.5])), /impressions is undefined/);
});

test('a property the account cannot see names access before a UI change', () => {
  // The likeliest cause of an absent block is no access to that property, so the
  // message must say so first; blaming the UI sends the user chasing nothing.
  throws(() => P.parseTotalsAndDaily({ 'ds:1': [] }), /has no access to it/);
});

// ─── The query table ─────────────────────────────────────────────────────────

test('query metrics are read by type id, not by column position', () => {
  const row = queryRow('sliccy', 64, 126, 0.5079365079365079, 1);
  const [parsedNormal] = P.parseQueryTable(ds16([row]));
  is(parsedNormal.clicks, 64);
  is(parsedNormal.impressions, 126);
  is(parsedNormal.position, 1);

  // Reorder the metric arrays: a positional reader would now report impressions
  // as clicks. Reading the type id keeps the mapping correct.
  const shuffled = [[[row[0][0], row[0][2], row[0][4], row[0][1], row[0][3]]]];
  const [parsedShuffled] = P.parseQueryTable(ds16(shuffled));
  is(parsedShuffled.clicks, 64);
  is(parsedShuffled.impressions, 126);
});

test('queries sort by clicks then impressions, both descending', () => {
  const rows = [
    queryRow('aemcoder', 0, 129, 0, 20),
    queryRow('sliccy', 64, 126, 0.5, 1),
    queryRow('slicc', 3, 379, 0.008, 5.3),
    queryRow('slicc ai', 5, 5, 1, 1),
  ];
  const parsed = P.parseQueryTable(ds16(rows));
  is(parsed.map((q) => q.query).join(','), 'sliccy,slicc ai,slicc,aemcoder');
});

test('a row without a string query label is skipped, not parsed as a query', () => {
  is(P.parseQueryTable(ds16([queryRow('sliccy', 1, 2, 0.5, 1), [[[null], countMetric(5, 9)]]])).length, 1);
});

// ─── The anonymised gap: the reason totals never come from the table ─────────

test('the gap between named queries and property totals is reported, not hidden', () => {
  // Measured live: the table sums to 76/848 while the property reports 196/2790,
  // because Search Console omits anonymised rare queries from the table but
  // counts them in the totals. A tool that summed the table would under-report
  // clicks by 61%. These are the real figures.
  const queries = [
    { query: 'sliccy', clicks: 64, impressions: 126 },
    { query: 'slicc ai', clicks: 5, impressions: 5 },
    { query: 'slicc', clicks: 3, impressions: 379 },
    { query: 'rest', clicks: 4, impressions: 338 },
  ];
  const gap = P.anonymisedGap({ clicks: 196, impressions: 2790 }, queries);
  is(gap.namedClicks, 76);
  is(gap.namedImpressions, 848);
  is(gap.clickGap, 120);
  is(gap.impressionGap, 1942);
  is(Math.round(gap.clickGapPct), 61);
  is(Math.round(gap.impressionGapPct), 70);
});

test('a property with no traffic yields a zero gap rather than dividing by zero', () => {
  const gap = P.anonymisedGap({ clicks: 0, impressions: 0 }, []);
  is(gap.clickGapPct, 0);
  is(gap.impressionGapPct, 0);
});

// ─── Session and property handling ───────────────────────────────────────────

test('the signed-in report page is NOT mistaken for a sign-in page', () => {
  // Measured, and the reason the obvious marker is not used: the real report page
  // contains accounts.google.com/signin in its account-chooser markup. Matching
  // on that string would refuse every valid page.
  const good = '<html><title>Search Console</title><a href="https://accounts.google.com/signin/x">';
  is(P.looksLikeSignInPage(good), false);
});

test('an actual sign-in page is recognised', () => {
  is(P.looksLikeSignInPage('<html><head><title>Sign in - Google Accounts</title>'), true);
});

test('both property shapes are accepted and anything else is refused', () => {
  ok(P.isValidProperty('sc-domain:sliccy.com'));
  ok(P.isValidProperty('https://www.sliccy.com/'));
  is(P.isValidProperty('sliccy.com'), false, 'a bare domain is not a property');
  is(P.isValidProperty(''), false);
  is(P.isValidProperty(undefined), false);
  // Shell metacharacters are refused up front. The fetch passes an argv array so
  // nothing is interpolated anyway, but a property that cannot address a report
  // should never reach the network.
  is(P.isValidProperty('sc-domain:x"; echo INJECTED; #'), false);
});

// ─── Block extraction ────────────────────────────────────────────────────────

test('data blocks are extracted and \\xNN escapes decoded', () => {
  const html =
    "AF_initDataCallback({key: 'ds:9', hash: '3', data:[null,[\"a\\x3db\"]], sideChannel: {}});";
  const blocks = P.parseDataBlocks(html);
  is(blocks['ds:9'][1][0], 'a=b');
});

test('one unparseable block does not discard the others', () => {
  const html =
    "AF_initDataCallback({key: 'ds:9', hash: '3', data:[1], sideChannel: {}});" +
    "AF_initDataCallback({key: 'ds:16', hash: '4', data:[not json, sideChannel: {}});";
  is(P.parseDataBlocks(html)['ds:9'][0], 1);
});

test('a response with no data blocks is reported as not a report page', () => {
  throws(() => P.parseDataBlocks('<html>nothing here</html>'), /not a Search\nConsole report page/);
});

// ─── UI scorecard scraping ───────────────────────────────────────────────────

test('scorecards are read from title=, which holds the exact number', () => {
  const html =
    scorecard('Total clicks', '196') +
    scorecard('Total impressions', '2,790') +
    scorecard('Average CTR', '7%') +
    scorecard('Average position', '11.6');
  const ui = P.parseUIScorecards(html);
  is(ui.clicks, '196');
  is(ui.impressions, '2,790');
  is(ui.ctrPct, '7%');
  is(ui.position, '11.6');
});

test('a label appearing outside the scorecard markup is not picked up', () => {
  // "Total clicks" also occurs in aria labels and data attributes; only the
  // rendered scorecard should match.
  is(P.parseUIScorecards('<div aria-label="Total clicks">196</div>').clicks, undefined);
});

test('UI numbers parse through commas, abbreviations and percent signs', () => {
  is(P.parseUINumber('196'), 196);
  is(P.parseUINumber('2,790'), 2790);
  is(P.parseUINumber('2.79K'), 2790);
  is(P.parseUINumber('1.5M'), 1500000);
  is(P.parseUINumber('7%'), 7);
  ok(Number.isNaN(P.parseUINumber('')));
});

// ─── Account slot, locale and the no-access page ─────────────────────────────
//
// Three findings from review, each verified against the live endpoint before
// being fixed. The slot one matters most: it worked only because the machine it
// was written on happened to be signed in at /u/1.

test('the account slot is taken from the tab URL, not assumed', () => {
  is(P.accountSlotFromUrl('https://search.google.com/u/0/search-console/performance'), '0');
  is(P.accountSlotFromUrl('https://search.google.com/u/3/search-console'), '3');
  is(P.accountSlotFromUrl('https://search.google.com/search-console/performance'), null);
  is(P.accountSlotFromUrl('https://evil.example/u/1/'), null, 'the host must match');
  is(P.accountSlotFromUrl(undefined), null);
});

test('the report URL carries the tab slot and forces the English locale', () => {
  const url = P.buildReportUrl('sc-domain:sliccy.com', '0');
  ok(url.startsWith('https://search.google.com/u/0/search-console/'));
  ok(url.includes('resource_id=sc-domain%3Asliccy.com'), 'the property must be encoded');
  ok(url.includes('hl=en'));
  // A slotless tab must not gain a fabricated /u/0.
  ok(!P.buildReportUrl('sc-domain:sliccy.com', null).includes('/u/'));
});

test('the no-access page is recognised, since it arrives as HTTP 200', () => {
  // Measured: requesting a property under the wrong account slot returns 200 with
  // this title and no ds:9, which would otherwise be reported as a missing block.
  ok(P.looksLikeNoAccessPage("<title>Oops, you don&#39;t have access to this property</title>"));
  ok(P.looksLikeNoAccessPage("<title>Oops, you don't have access to this property</title>"));
  is(P.looksLikeNoAccessPage('<title>Performance on Search results</title>'), false);
});

test('a capped query table is not labelled as anonymisation', () => {
  // Past the row cap the remainder also holds ordinary queries the table never
  // returned, so attributing all of it to anonymisation would be a false
  // explanation of the user's own data.
  const many = Array.from({ length: P.QUERY_TABLE_ROW_CAP }, (_, i) => ({
    query: `q${i}`,
    clicks: 1,
    impressions: 1,
  }));
  ok(P.anonymisedGap({ clicks: 5000, impressions: 9000 }, many).tableLikelyTruncated);
  is(P.anonymisedGap({ clicks: 196, impressions: 2790 }, many.slice(0, 78)).tableLikelyTruncated, false);
});

test('the no-access message distinguishes a wrong account from a slotless tab', () => {
  // Measured: a URL with no /u/N/ segment is served the no-access page too, so
  // the two causes need different advice — reload the tab, versus check the
  // account. Collapsing them would send half the users to the wrong fix.
  const withSlot = P.noAccessMessage('sc-domain:sliccy.com', '0');
  ok(withSlot.includes('/u/0/'));
  ok(withSlot.includes('different Google account'));

  const slotless = P.noAccessMessage('sc-domain:sliccy.com', null);
  ok(slotless.includes('no /u/N/ account slot'));
  ok(slotless.includes('Reload'));
  ok(!slotless.includes('different Google account'), 'slotless advice must not blame the account');
});

// ─── The page dimension ──────────────────────────────────────────────────────
//
// Shapes copied from a live sc-domain:sliccy.com page report on 2026-09-21
// (breakdown=page), not invented. A page row's label array is 41 long with the
// URL at index 40 and a bare `1` at 16 — nothing like a query row, which carries
// its label at [0]. The metric arrays are identical to the query table's: clicks
// and impressions 9 long with the value at [1], CTR and position 45 and 44 long
// with the value in the last slot.

const PAGE_LABEL_LEN = 41;

const pageRow = (url, clicks, impressions, ctr, position) => {
  const label = new Array(PAGE_LABEL_LEN).fill(null);
  label[16] = 1;
  label[P.PAGE_URL_INDEX] = url;
  return [
    [
      label,
      countMetric(5, clicks),
      countMetric(6, impressions),
      ratioMetric(7, ctr, 45),
      ratioMetric(8, position, 44),
    ],
  ];
};

/** A ds:16 block with the header Search Console really sends, so the dimension id
 *  and the echoed filter list are where the parser looks for them. */
const breakdownBlock = (dimId, rows, filters = [[6, ['WEB']]]) => ({
  'ds:16': [
    [
      'sc-domain:sliccy.com',
      32,
      null,
      null,
      null,
      [[dimId], null, [[null, null, null, 3]], filters, null, null, null, null, null, null, 1, null, null, 2, null, 1],
    ],
    [rows, null, null, [null, null, 1]],
  ],
});

/** ds:9 carrying an echoed filter list, as a filtered report does. */
const ds9Filtered = (totals, filters) => ({
  'ds:9': [
    [
      'sc-domain:sliccy.com',
      27,
      null,
      null,
      null,
      [[1], null, [[null, null, null, 3]], filters, null, null, null, null, null, null, 1, null, null, 2, null, 1],
    ],
    [
      [[1781870400000, [3, 380, 0.007894736842105263, 5.328947368421052], null, null, null, null, 1781870400000]],
      [null, totals],
    ],
  ],
});

// The real unfiltered and exact-filtered page tables, at the values the Search
// Console UI displayed for the same period.
const REAL_PAGE_ROWS = [
  pageRow('https://www.sliccy.com/security', 4, 674, 0.005934718100890208, 10.629080118694363),
  pageRow('https://www.sliccy.com/', 156, 1760, 0.08863636363636364, 9.999431818181819),
  pageRow('https://www.sliccy.com/automate-website-migration', 32, 655, 0.04885496183206107, 8.4),
];
const EXACT_SLICC_FILTERS = [[6, ['WEB']], [2, ['slicc'], 1, 0]];
const CONTAINS_SLICC_FILTERS = [[6, ['WEB']], [2, ['slicc'], 2, 0]];

test('page rows are read from label index 40 and sorted by clicks', () => {
  const pages = P.parsePageTable(breakdownBlock(P.DIMENSION.page, REAL_PAGE_ROWS));
  is(pages.length, 3);
  is(pages[0].page, 'https://www.sliccy.com/');
  is(pages[0].clicks, 156);
  is(pages[0].impressions, 1760);
  is(Number((pages[0].ctr * 100).toFixed(1)), 8.9, 'CTR comes from the trailing slot');
  is(Number(pages[0].position.toFixed(1)), 10.0);
  is(pages.map((p) => p.clicks).join(','), '156,32,4');
});

test('the page table refuses to parse a query table served in the same block', () => {
  // The worst realistic defect: breakdown=page stops being honoured and ds:16
  // comes back as a well-formed QUERY table. Every offset still parses, so
  // without the dimension check the tool would print "sliccy" and "slicc ai" in
  // a column headed Page — a confident wrong answer, not an error.
  throws(
    () => P.parsePageTable(breakdownBlock(P.DIMENSION.query, [queryRow('sliccy', 64, 126, 0.5, 1)])),
    /carries dimension 2, not the page dimension/,
  );
});

test('an untagged breakdown block is refused rather than read hopefully', () => {
  throws(() => P.parsePageTable({ 'ds:16': [null, [REAL_PAGE_ROWS]] }), /carries dimension none/);
});

test('the dimension id of the active breakdown table is readable', () => {
  is(P.tableDimensionId(breakdownBlock(P.DIMENSION.page, [])), 3);
  is(P.tableDimensionId(breakdownBlock(P.DIMENSION.query, [])), 2);
  is(P.tableDimensionId({}), null);
});

test('the query table refuses to parse the page table', () => {
  throws(
    () => P.parseQueryTable(breakdownBlock(P.DIMENSION.page, REAL_PAGE_ROWS)),
    /holds the page table/,
  );
});

test('a filter that matches nothing yields no pages, and that is not an error', () => {
  // Measured: with an exact-query filter on a query the property never served,
  // data[1][0] is null rather than an empty array.
  is(P.parsePageTable(breakdownBlock(P.DIMENSION.page, null)).length, 0);
});

test('page rows without a URL at the measured index fail instead of vanishing', () => {
  // If the label index shifts, skipping the rows would report "no pages" — which
  // reads like a property with no traffic instead of a broken parser.
  const shifted = REAL_PAGE_ROWS.map((row) => {
    const label = [...row[0][0]];
    label[P.PAGE_URL_INDEX] = null;
    label[39] = 'https://www.sliccy.com/';
    return [[label, ...row[0].slice(1)]];
  });
  throws(() => P.parsePageTable(breakdownBlock(P.DIMENSION.page, shifted)), /no URL at label index 40/);
});

test('a label holding something other than a URL is not accepted as a page', () => {
  const notAUrl = pageRow('sliccy', 1, 2, 0.5, 1);
  throws(() => P.parsePageTable(breakdownBlock(P.DIMENSION.page, [notAUrl])), /no URL at label index 40/);
});

// ─── Proving the query filter was really applied ──────────────────────────────
//
// Search Console echoes the filters it applied in the block header at
// data[0][5][3]. That echo is the only in-band evidence available: an ignored or
// renamed filter parameter returns the UNFILTERED report with HTTP 200, and the
// rows look perfectly valid.

test('the echoed filter list is parsed, search type included', () => {
  const filters = P.appliedFilters(breakdownBlock(P.DIMENSION.page, [], EXACT_SLICC_FILTERS));
  is(filters.length, 2);
  is(filters[0].dimensionId, 6);
  is(filters[0].values[0], 'WEB');
  is(filters[1].dimensionId, P.DIMENSION.query);
  is(filters[1].values[0], 'slicc');
  is(filters[1].operator, P.QUERY_FILTER_OPERATOR.exact);
  is(P.appliedFilters({}).length, 0);
});

test('an exact-query filter echoed by both blocks passes the check', () => {
  const blocks = {
    ...breakdownBlock(P.DIMENSION.page, REAL_PAGE_ROWS, EXACT_SLICC_FILTERS),
    ...ds9Filtered([3, 380, 0.007894736842105263, 5.328947368421052], EXACT_SLICC_FILTERS),
  };
  P.assertQueryFilterApplied(blocks, 'slicc');
  P.assertQueryFilterApplied(blocks, '  SLICC  ');
});

test('an unfiltered response is refused, not returned as if it were filtered', () => {
  // The silent failure this whole check exists for: the response carries only the
  // search-type filter, so these rows are every page on the property.
  const blocks = {
    ...breakdownBlock(P.DIMENSION.page, REAL_PAGE_ROWS),
    ...ds9Filtered([192, 2778, 0.069, 11.49], [[6, ['WEB']]]),
  };
  throws(() => P.assertQueryFilterApplied(blocks, 'slicc'), /did not apply the query filter "slicc"/);
});

test('a filter applied to the table but not the totals is refused', () => {
  // The totals are printed beside the table. If ds:9 were unfiltered, a
  // 380-impression query would be shown against 2778 property impressions and
  // read as a 0.1% CTR story that is not real.
  const blocks = {
    ...breakdownBlock(P.DIMENSION.page, REAL_PAGE_ROWS, EXACT_SLICC_FILTERS),
    ...ds9Filtered([192, 2778, 0.069, 11.49], [[6, ['WEB']]]),
  };
  throws(() => P.assertQueryFilterApplied(blocks, 'slicc'), /to ds:9/);
});

test('a "contains" match is refused where an exact query was requested', () => {
  // Measured: &query=*slicc echoes operator 2 and returns 4 pages / 527
  // impressions, against 2 pages / 380 for the exact filter. Accepting it would
  // attribute `sliccy` and `slicc ai` traffic to the query `slicc`.
  const blocks = {
    ...breakdownBlock(P.DIMENSION.page, REAL_PAGE_ROWS, CONTAINS_SLICC_FILTERS),
    ...ds9Filtered([75, 527, 0.1423, 4.36], CONTAINS_SLICC_FILTERS),
  };
  throws(() => P.assertQueryFilterApplied(blocks, 'slicc'), /with operator 2, not exact/);
});

test('a filter for a different query than the one requested is refused', () => {
  const blocks = {
    ...breakdownBlock(P.DIMENSION.page, REAL_PAGE_ROWS, [[6, ['WEB']], [2, ['sliccy'], 1, 0]]),
    ...ds9Filtered([64, 126, 0.5, 1], [[6, ['WEB']], [2, ['sliccy'], 1, 0]]),
  };
  throws(() => P.assertQueryFilterApplied(blocks, 'slicc'), /did not apply the query filter/);
});

// ─── Report URL: breakdown and filter parameters ──────────────────────────────

test('the page breakdown and an exact query filter are put in the URL', () => {
  // Both parameter shapes were read off the URL the Search Console UI produced
  // when its own Pages tab and "Exact query" filter were used.
  const url = P.buildReportUrl('sc-domain:sliccy.com', '1', { breakdown: 'page', query: 'slicc' });
  ok(url.includes('&breakdown=page'));
  ok(url.includes('&query=!slicc'), 'the ! prefix is the exact-match operator');
  ok(url.includes('hl=en'), 'locale is still forced, or numbers come back localized');
  // A multi-word query must be encoded, not concatenated raw into the URL.
  ok(P.buildReportUrl('sc-domain:sliccy.com', '1', { query: 'slicc ai' }).includes('&query=!slicc%20ai'));
  // Unchanged when neither is asked for.
  const plain = P.buildReportUrl('sc-domain:sliccy.com', '1');
  ok(!plain.includes('breakdown'));
  ok(!plain.includes('query='));
});

// ─── Totals for a filtered report with no data ────────────────────────────────

test('a no-match filtered report reads as zeros instead of raising', () => {
  // Measured shape: [0, 0, "NaN", "NaN"] — a CTR and a position are undefined
  // with no impressions, which is data, not a reshape.
  const blocks = ds9Filtered([0, 0, 'NaN', 'NaN'], EXACT_SLICC_FILTERS);
  const { totals } = P.parseTotalsAndDaily(blocks, { allowNoData: true });
  is(totals.clicks, 0);
  is(totals.impressions, 0);
  is(totals.ctr, 0);
  is(totals.position, 0);
  // Without the option the strict guard still fires, so `performance` keeps it.
  throws(() => P.parseTotalsAndDaily(blocks), /totals.ctr is NaN/);
});

test('allowNoData does not excuse a non-numeric total next to real traffic', () => {
  // A reshape that drops the CTR while clicks and impressions still have values
  // must stay an error, or the leniency would swallow the very defect the check
  // was written for.
  throws(
    () => P.parseTotalsAndDaily(ds9Filtered([3, 380, 'NaN', 5.3], EXACT_SLICC_FILTERS), { allowNoData: true }),
    /totals.ctr is NaN/,
  );
});

// ─── The page table does not add up to the totals, in either direction ────────

test('the page table exceeding the property totals is reported as an excess', () => {
  // Measured live: 8 page rows summing to 194 clicks / 3569 impressions against
  // property totals of 192 / 2778. Unlike the query table, the page table can
  // OVERSHOOT — one result page listing two of the site's URLs counts twice here
  // and once in the totals — so neither sum may be presented as the other.
  const pages = [
    { page: 'https://www.sliccy.com/', clicks: 156, impressions: 1760 },
    { page: 'https://www.sliccy.com/automate-website-migration', clicks: 32, impressions: 655 },
    { page: 'https://www.sliccy.com/security', clicks: 4, impressions: 674 },
    { page: 'https://www.sliccy.com/privacy', clicks: 1, impressions: 448 },
    { page: 'https://www.sliccy.com/use-cases/sandbox', clicks: 1, impressions: 23 },
    { page: 'https://www.sliccy.com/#how-it-works', clicks: 0, impressions: 3 },
    { page: 'https://www.sliccy.com/#use-cases', clicks: 0, impressions: 3 },
    { page: 'https://www.sliccy.com/#video', clicks: 0, impressions: 3 },
  ];
  const delta = P.pageTableDelta({ clicks: 192, impressions: 2778 }, pages);
  is(delta.pageClicks, 194);
  is(delta.pageImpressions, 3569);
  is(delta.clickDelta, 2);
  is(delta.impressionDelta, 791);
  is(Math.round(delta.impressionDeltaPct), 28);
  ok(delta.exceedsTotals, 'the excess must be flagged, not folded into a "gap"');
});

test('a page table falling short of the totals is reported as a shortfall', () => {
  const delta = P.pageTableDelta(
    { clicks: 192, impressions: 2778 },
    [{ page: 'https://www.sliccy.com/', clicks: 156, impressions: 1760 }],
  );
  is(delta.clickDelta, -36);
  is(delta.impressionDelta, -1018);
  is(delta.exceedsTotals, false);
});

test('an empty page table against zero totals does not divide by zero', () => {
  const delta = P.pageTableDelta({ clicks: 0, impressions: 0 }, []);
  is(delta.clickDeltaPct, 0);
  is(delta.impressionDeltaPct, 0);
  is(delta.exceedsTotals, false);
});

// ─── Review findings from PR #413 (all three were real) ──────────────────────

test('a single undecodable page row is fatal, not silently dropped', () => {
  // Finding: failing only when EVERY row is undecodable meant a partially
  // decoded table was returned as if complete, and its summed columns then
  // understated real traffic. A wrong number, not an error.
  const good = pageRow('https://www.sliccy.com/a', 5, 9, 0.5, 2);
  // Same row with the URL removed from its label — a reshape of one row only.
  const bad = pageRow('https://www.sliccy.com/b', 3, 4, 0.7, 3);
  bad[0][0][P.PAGE_URL_INDEX] = null;
  is(P.parsePageTable(breakdownBlock(P.DIMENSION.page, [good])).length, 1, 'a decodable table still parses');
  throws(
    () => P.parsePageTable(breakdownBlock(P.DIMENSION.page, [good, bad])),
    /1 of 2 page rows with/,
  );
});

test('an empty report coerces only the measured "NaN" sentinel', () => {
  // Finding: coercing every non-number disabled the reshape check exactly when a
  // query has no traffic — the case where a wrong zero is hardest to spot.
  const ok = P.parseTotalsAndDaily(ds9([0, 0, P.NO_DATA_SENTINEL, P.NO_DATA_SENTINEL]), { allowNoData: true });
  is(ok.totals.ctr, 0);
  is(ok.totals.position, 0);
  // Anything else at those offsets is a reshape and must still be refused.
  throws(
    () => P.parseTotalsAndDaily(ds9([0, 0, { unexpected: true }, 'NaN']), { allowNoData: true }),
    /not a valid number/,
  );
  throws(
    () => P.parseTotalsAndDaily(ds9([0, 0, undefined, 'NaN']), { allowNoData: true }),
    /not a valid number/,
  );
});

test('mixed-direction page deltas are reported as mixed, not as an excess', () => {
  // Finding: `exceedsTotals` is an OR, so one metric over and the other short
  // labelled both as excesses and formatted the negative as "+-10%".
  const mixed = P.pageTableDelta({ clicks: 100, impressions: 1000 }, [{ clicks: 102, impressions: 900 }]);
  is(mixed.direction, 'mixed');
  is(mixed.clickDelta, 2);
  is(mixed.impressionDelta, -100);
  ok(mixed.exceedsTotals, 'the legacy OR flag is still true, which is why callers must use direction');

  is(P.pageTableDelta({ clicks: 100, impressions: 1000 }, [{ clicks: 102, impressions: 1100 }]).direction, 'over');
  is(P.pageTableDelta({ clicks: 100, impressions: 1000 }, [{ clicks: 90, impressions: 900 }]).direction, 'under');
  is(P.pageTableDelta({ clicks: 100, impressions: 1000 }, [{ clicks: 100, impressions: 1000 }]).direction, 'over',
    'an exact match counts as over, so the zero case takes the non-shortfall wording');
});

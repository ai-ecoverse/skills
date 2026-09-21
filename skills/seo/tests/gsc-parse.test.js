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

// fastly-ext.jsh — SLICC-only extensions to the `fastly` skill.
//
// The official Fastly CLI (github.com/fastly/cli) has NO billing command group:
// its 32 groups are apisecurity … whoami, and none of them touch invoices. To
// keep `fastly` command-compatible with the upstream tool, billing lives here,
// in a separate binary (`fastly-ext`), exactly as the gcloud skill splits
// cost/usage reporting into `gcloud-ext`.
//
// Backed by the Fastly Billing v3 API (documented, stable, cursor-paginated):
//   GET /billing/v3/invoices                  list, newest first
//   GET /billing/v3/invoices/{invoice_id}     one closed invoice
//   GET /billing/v3/invoices/month-to-date    synthetic in-progress invoice
// Everything else under /billing (v2 endpoints, /billing/v3/estimate,
// service-level-usage) is 404 on current accounts — see references/billing-api.md.
//
// All HTTP goes through the sibling `fastly api` command so that token
// resolution, host allow-listing and 401 re-harvest live in exactly one place.

const cli = require('sliccy:cli');
const exec = require('sliccy:exec');
const c = require('sliccy:color');

// ─── Billing domain constants ────────────────────────────────────────────────

// Product groups that are FIXED monthly charges, not usage: they land on day 1
// of the billing period at full value and must be excluded from any run rate.
//   "CS: CSE" = Enterprise Support subscription
//   "TLS"     = certificate subscription (per-cert monthly fee)
const FIXED_GROUPS = new Set(['CS: CSE', 'TLS']);

// Measured day-of-week traffic profile for this account (fraction of the
// month's mean day, 2024-01 → 2026-08). Used only to compare the *billable
// size* of two calendar months: months differ by up to ~3% purely from how
// many weekdays they contain. Index 0 = Sunday.
const DOW_WEIGHT = [0.694, 1.079, 1.154, 1.113, 1.162, 1.058, 0.738];

const PAGE_LIMIT = 100; // API rejects limits above ~200; 100 paginates safely.
const MAX_PAGES = 20;
const DEFAULT_BACKTEST_WINDOW = 12;
const MIN_BACKTEST_SAMPLES = 4; // below this we refuse to print an interval

// ANSI SGR escape matcher, built from a char code so the source carries no
// literal control character (Biome's noControlCharactersInRegex).
const ANSI = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, 'g');

function str(v) {
  return typeof v === 'string' ? v : undefined;
}

function num(v, dflt) {
  const s = str(v);
  if (s === undefined) return dflt;
  const n = Number(s);
  return Number.isFinite(n) ? n : dflt;
}

// ─── Transport: delegate to `fastly api` ─────────────────────────────────────

async function bfetch(path) {
  const { stdout, stderr, exitCode } = await exec.spawn(['fastly', 'api', path]);
  if (exitCode !== 0) {
    // Strip the child's ANSI colouring and its own "fastly:" prefix so the
    // message isn't double-labelled when we re-emit it.
    const msg =
      (stderr || stdout || '').replace(ANSI, '').replace(/^\s*fastly:\s*/, '').trim() ||
      `fastly api ${path} failed`;
    cli.die(msg, { prefix: 'fastly-ext' });
  }
  try {
    return JSON.parse(stdout);
  } catch {
    cli.die(`Could not parse the Fastly response for ${path}.`, { prefix: 'fastly-ext' });
  }
}

/** Cursor-paginated invoice list, newest first. `want` caps how many we fetch. */
async function fetchInvoices(want) {
  const out = [];
  let cursor = '';
  for (let page = 0; page < MAX_PAGES; page++) {
    const limit = Math.min(PAGE_LIMIT, Math.max(1, want - out.length));
    // The cursor is base64 and can contain '+' and '=', both of which change
    // meaning inside a query string — always percent-encode it.
    const q = `?limit=${limit}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`;
    const res = await bfetch(`/billing/v3/invoices${q}`);
    const data = Array.isArray(res.data) ? res.data : [];
    out.push(...data);
    cursor = res?.meta?.next_cursor || '';
    if (!cursor || out.length >= want || !data.length) break;
  }
  return out;
}

// ─── Invoice analysis ────────────────────────────────────────────────────────

function amount(v) {
  // Closed invoices return monthly_transaction_amount as a number;
  // month-to-date returns it as a STRING. Normalise.
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

/** Split an invoice into fixed vs usage dollars, plus per-product_group totals. */
function analyse(inv) {
  const groups = {};
  const products = {};
  let fixed = 0;
  let usage = 0;
  for (const li of inv.transaction_line_items || []) {
    const a = amount(li.amount);
    const g = li.product_group || 'Unknown';
    groups[g] = (groups[g] || 0) + a;
    const key = li.product_name || li.description || g;
    products[key] = (products[key] || 0) + a;
    if (FIXED_GROUPS.has(g)) fixed += a;
    else usage += a;
  }
  return {
    invoice_id: inv.invoice_id,
    month: String(inv.billing_start_date || '').slice(0, 7),
    start: inv.billing_start_date,
    end: inv.billing_end_date,
    total: amount(inv.monthly_transaction_amount),
    currency: inv.currency_code || 'USD',
    payment_status: inv.payment_status || null,
    fixed,
    usage,
    groups,
    products,
    lineItems: (inv.transaction_line_items || []).length,
  };
}

// ─── Calendar weighting ──────────────────────────────────────────────────────

function daysInMonth(year, month1) {
  return new Date(Date.UTC(year, month1, 0)).getUTCDate();
}

/** Day-of-week-weighted "billable size" of a month, optionally only the first
 *  `upto` days (fractional `upto` weights the final partial day). */
function monthWeight(year, month1, upto) {
  const total = daysInMonth(year, month1);
  const limit = upto === undefined ? total : Math.min(upto, total);
  let sum = 0;
  for (let d = 1; d <= Math.floor(limit); d++) {
    sum += DOW_WEIGHT[new Date(Date.UTC(year, month1 - 1, d)).getUTCDay()];
  }
  const frac = limit - Math.floor(limit);
  if (frac > 0 && Math.floor(limit) + 1 <= total) {
    sum += DOW_WEIGHT[new Date(Date.UTC(year, month1 - 1, Math.floor(limit) + 1)).getUTCDay()] * frac;
  }
  return sum;
}

function ymOf(row) {
  return [Number(row.month.slice(0, 4)), Number(row.month.slice(5, 7))];
}

function isPrecededBy(row, prev) {
  const [py, pm] = ymOf(prev);
  const d = new Date(Date.UTC(py, pm - 1, 1));
  d.setUTCMonth(d.getUTCMonth() + 1);
  const [y, m] = ymOf(row);
  return d.getUTCFullYear() === y && d.getUTCMonth() + 1 === m;
}

function quantile(sorted, p) {
  if (!sorted.length) return 0;
  const i = (sorted.length - 1) * p;
  const lo = Math.floor(i);
  const hi = Math.ceil(i);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (i - lo);
}

function usd(n, cur = 'USD') {
  const sign = n < 0 ? '-' : '';
  return `${sign}${cur === 'USD' ? '$' : `${cur} `}${Math.abs(n).toFixed(2)}`;
}

// ─── billing invoices ────────────────────────────────────────────────────────

async function cmdInvoices(flags) {
  const limit = num(flags.limit, 12);
  const invoices = await fetchInvoices(limit);
  if (flags.json) {
    cli.out(invoices);
    return;
  }
  if (!invoices.length) {
    console.log(c.dim('  No invoices found.'));
    return;
  }
  console.log('');
  console.log(
    `  ${c.dim('INVOICE'.padEnd(13))}${c.dim('PERIOD'.padEnd(10))}${c.dim('TOTAL'.padStart(11))}  ` +
      `${c.dim('FIXED'.padStart(10))}${c.dim('USAGE'.padStart(11))}  ${c.dim('STATUS')}`,
  );
  for (const inv of invoices) {
    const a = analyse(inv);
    const paid = a.payment_status === 'paid';
    console.log(
      `  ${c.cyan((a.invoice_id || '').padEnd(13))}${a.month.padEnd(10)}` +
        `${usd(a.total, a.currency).padStart(11)}  ` +
        `${c.dim(usd(a.fixed).padStart(10))}${c.dim(usd(a.usage).padStart(11))}  ` +
        `${paid ? c.green('paid') : c.yellow(a.payment_status || 'unknown')}`,
    );
  }
  const unpaid = invoices.map(analyse).filter((a) => a.payment_status !== 'paid');
  console.log('');
  console.log(c.dim(`  ${invoices.length} invoice(s) shown (--limit N for more)`));
  if (unpaid.length) {
    const owed = unpaid.reduce((s, a) => s + a.total, 0);
    console.log(
      `  ${c.yellow(`${unpaid.length} not marked paid`)}  ${c.dim(`${usd(owed)} across ${unpaid.map((a) => a.month).join(', ')}`)}`,
    );
  }
}

// ─── billing invoice <id> ────────────────────────────────────────────────────

async function cmdInvoice(positional, flags) {
  const id = str(positional[0]) || str(flags.id);
  if (!id) {
    cli.die('usage: fastly-ext billing invoice <INV-id|month-to-date>', { prefix: 'fastly-ext' });
  }
  const inv = await bfetch(`/billing/v3/invoices/${encodeURIComponent(id)}`);
  if (flags.json) {
    cli.out(inv);
    return;
  }
  const a = analyse(inv);
  console.log('');
  console.log(`  ${c.cyan(c.bold(a.invoice_id))}  ${c.dim(`${a.start?.slice(0, 10)} → ${a.end?.slice(0, 10)}`)}`);
  console.log(`  ${c.bold(usd(a.total, a.currency))}  ${a.payment_status ? (a.payment_status === 'paid' ? c.green(a.payment_status) : c.yellow(a.payment_status)) : c.dim('in progress')}`);
  console.log('');
  console.log(`  ${c.bold('by product group')}`);
  for (const [g, v] of Object.entries(a.groups).sort((x, y) => y[1] - x[1])) {
    const tag = FIXED_GROUPS.has(g) ? c.dim(' fixed') : c.dim(' usage');
    console.log(`    ${g.padEnd(24)} ${usd(v).padStart(11)}${tag}`);
  }
  console.log('');
  console.log(`    ${c.dim('fixed subtotal'.padEnd(24))} ${usd(a.fixed).padStart(11)}`);
  console.log(`    ${c.dim('usage subtotal'.padEnd(24))} ${usd(a.usage).padStart(11)}`);
  console.log('');
  console.log(`  ${c.bold('top line items')}`);
  const top = Object.entries(a.products)
    .sort((x, y) => y[1] - x[1])
    .slice(0, 12);
  for (const [p, v] of top) console.log(`    ${p.padEnd(48).slice(0, 48)} ${usd(v).padStart(11)}`);
  if (a.lineItems > top.length) console.log(c.dim(`    … ${a.lineItems - top.length} more line item(s) (--json for all)`));
}

// ─── billing mtd ─────────────────────────────────────────────────────────────

async function cmdMtd(flags) {
  const mtd = await bfetch('/billing/v3/invoices/month-to-date');
  const a = analyse(mtd);
  // The previous closed invoice tells us what the fixed charges really are —
  // month-to-date does not always include them all yet (observed: the TLS
  // certificate subscription appears as $0 lines mid-month and is only priced
  // at invoice close).
  const history = (await fetchInvoices(2)).map(analyse);
  const prior = history.find((h) => h.month !== a.month) || null;

  if (flags.json) {
    cli.out({
      month: a.month,
      as_of: a.end,
      total: a.total,
      fixed: a.fixed,
      usage: a.usage,
      groups: a.groups,
      prior_month: prior ? { month: prior.month, total: prior.total, fixed: prior.fixed, usage: prior.usage } : null,
      warning:
        'month-to-date is NOT a run rate: fixed monthly charges are billed in full on day 1. ' +
        'Compare the usage component only, and note that fixed charges may still be incomplete mid-month.',
    });
    return;
  }

  console.log('');
  console.log(`  ${c.bold(`month to date — ${a.month}`)}  ${c.dim(`as of ${String(a.end).replace('T', ' ').slice(0, 16)} UTC`)}`);
  console.log('');
  console.log(`  ${'total so far'.padEnd(24)} ${c.bold(usd(a.total, a.currency).padStart(11))}`);
  console.log(`  ${c.dim('fixed (billed on day 1)'.padEnd(24))} ${usd(a.fixed).padStart(11)}`);
  console.log(`  ${c.dim('usage (accrues daily)'.padEnd(24))} ${usd(a.usage).padStart(11)}`);
  console.log('');
  for (const [g, v] of Object.entries(a.groups).sort((x, y) => y[1] - x[1])) {
    console.log(`    ${c.dim(g.padEnd(24))} ${usd(v).padStart(11)}${FIXED_GROUPS.has(g) ? c.dim(' fixed') : ''}`);
  }
  console.log('');
  console.log(c.yellow('  ⚠ This is not a run rate.'));
  console.log(
    c.dim(
      `    ${usd(a.fixed)} of the ${usd(a.total)} above is a fixed monthly subscription charged in\n` +
        '    full on day 1, so extrapolating the total linearly over-states the month badly.\n' +
        '    Only the usage component scales with elapsed days.',
    ),
  );
  if (prior) {
    const missingFixed = prior.fixed - a.fixed;
    console.log('');
    console.log(
      c.dim(`    prior month (${prior.month}): total ${usd(prior.total)} = fixed ${usd(prior.fixed)} + usage ${usd(prior.usage)}`),
    );
    if (missingFixed > 0.5) {
      console.log(
        c.yellow(
          `    ⚠ ${usd(missingFixed)} of last month's fixed charges are not in month-to-date yet\n` +
            "      (Fastly prices the TLS certificate subscription at invoice close), so the\n" +
            '      final invoice will include them on top of whatever usage accrues.',
        ),
      );
    }
  }
  console.log('');
  console.log(c.dim('    For a full-month estimate: fastly-ext billing forecast'));
}

// ─── billing forecast ────────────────────────────────────────────────────────

/** One-month-ahead usage prediction: carry the prior month's usage forward,
 *  rescaled by the day-of-week-weighted billable size of the two months.
 *  This is the ONLY estimator we can backtest, because the API exposes no
 *  historical month-to-date snapshots — only closed invoices. */
function predictUsage(prior, targetYear, targetMonth) {
  const [py, pm] = ymOf(prior);
  const wPrior = monthWeight(py, pm);
  const wTarget = monthWeight(targetYear, targetMonth);
  return { pred: (prior.usage * wTarget) / wPrior, wPrior, wTarget };
}

function backtest(rows, window) {
  // rows: oldest → newest, closed invoices only.
  const errs = [];
  for (let i = 1; i < rows.length; i++) {
    const prev = rows[i - 1];
    const act = rows[i];
    if (!isPrecededBy(act, prev)) continue; // gap in the series
    if (prev.usage <= 0 || act.usage <= 0) continue;
    const [y, m] = ymOf(act);
    const { pred } = predictUsage(prev, y, m);
    errs.push({ month: act.month, rel: (pred - act.usage) / act.usage });
  }
  return errs.slice(-window);
}

async function cmdForecast(flags) {
  const window = num(flags.window, DEFAULT_BACKTEST_WINDOW);
  const mtdRaw = await bfetch('/billing/v3/invoices/month-to-date');
  const mtd = analyse(mtdRaw);
  const [curYear, curMonth] = ymOf(mtd);

  // Enough history for the requested backtest window plus the carry-forward.
  const invoices = await fetchInvoices(Math.max(window + 2, 14));
  const closed = invoices
    .map(analyse)
    .filter((a) => a.month !== mtd.month)
    .sort((x, y) => x.month.localeCompare(y.month));
  if (!closed.length) {
    cli.die('No closed invoices available — cannot forecast.', { prefix: 'fastly-ext' });
  }
  const prior = closed[closed.length - 1];
  if (!isPrecededBy(mtd, prior)) {
    cli.die(
      `The most recent closed invoice (${prior.month}) does not immediately precede the current month (${mtd.month}).\n` +
        '  The carry-forward estimator needs consecutive months; refusing to guess.',
      { prefix: 'fastly-ext' },
    );
  }

  const { pred: usageNaive, wPrior, wTarget } = predictUsage(prior, curYear, curMonth);
  const fixedHat = Math.max(prior.fixed, mtd.fixed);

  const errs = backtest(closed, window);
  const rels = errs.map((e) => e.rel).sort((x, y) => x - y);
  const haveInterval = rels.length >= MIN_BACKTEST_SAMPLES;
  const mape = rels.length ? rels.reduce((s, x) => s + Math.abs(x), 0) / rels.length : null;

  // If pred = actual · (1 + e), then actual = pred / (1 + e). Invert the
  // empirical error distribution to turn the raw prediction into a corrected
  // point estimate plus a band. Guard the degenerate 1 + e <= 0 case.
  const invert = (e) => (1 + e > 0.05 ? usageNaive / (1 + e) : null);
  const median = haveInterval ? quantile(rels, 0.5) : null;
  const usagePoint = haveInterval ? invert(median) ?? usageNaive : usageNaive;
  const usageLow = haveInterval ? invert(quantile(rels, 0.9)) : null;
  const usageHigh = haveInterval ? invert(quantile(rels, 0.1)) : null;

  // Independent cross-check from this month's accrued usage. Not backtestable:
  // the API keeps no historical month-to-date snapshots, so we label it as such.
  let mtdProjection = null;
  const endDate = mtd.end ? new Date(mtd.end) : null;
  if (endDate && !Number.isNaN(endDate.getTime())) {
    const elapsedDays = endDate.getUTCDate() - 1 + (endDate.getUTCHours() * 3600 + endDate.getUTCMinutes() * 60) / 86400;
    const wElapsed = monthWeight(curYear, curMonth, elapsedDays);
    if (wElapsed >= 2 && mtd.usage > 0) {
      mtdProjection = { value: (mtd.usage * wTarget) / wElapsed, elapsedDays, wElapsed };
    }
  }

  const totalPoint = fixedHat + usagePoint;

  if (flags.json) {
    cli.out({
      month: mtd.month,
      basis_month: prior.month,
      fixed_forecast: fixedHat,
      usage_forecast_raw: usageNaive,
      usage_forecast: usagePoint,
      usage_low: usageLow,
      usage_high: usageHigh,
      total_forecast: totalPoint,
      total_low: usageLow === null ? null : fixedHat + usageLow,
      total_high: usageHigh === null ? null : fixedHat + usageHigh,
      month_weight: { current: wTarget, basis: wPrior },
      backtest: {
        samples: rels.length,
        window,
        mape: mape,
        median_relative_error: median,
        p10_relative_error: haveInterval ? quantile(rels, 0.1) : null,
        p90_relative_error: haveInterval ? quantile(rels, 0.9) : null,
        months: errs.map((e) => ({ month: e.month, relative_error: e.rel })),
      },
      mtd_cross_check: mtdProjection ? { usage_projection: mtdProjection.value, elapsed_days: mtdProjection.elapsedDays, backtested: false } : null,
      interval_meaning: haveInterval
        ? `10th-90th percentile of one-month-ahead backtest errors over the last ${rels.length} month(s); 80% of those backtests fell inside it by construction. Empirical error band, NOT a statistical confidence interval.`
        : `fewer than ${MIN_BACKTEST_SAMPLES} backtest samples — point estimate only, no interval.`,
    });
    return;
  }

  console.log('');
  console.log(`  ${c.bold(`forecast for ${mtd.month}`)}  ${c.dim(`basis: ${prior.month} invoice`)}`);
  console.log('');
  console.log(`  ${'fixed (subscriptions)'.padEnd(26)} ${usd(fixedHat).padStart(11)}  ${c.dim('carried from ' + prior.month)}`);
  console.log(`  ${'usage (forecast)'.padEnd(26)} ${usd(usagePoint).padStart(11)}`);
  console.log(`  ${c.bold('total (point estimate)'.padEnd(26))} ${c.bold(usd(totalPoint).padStart(11))}`);
  if (usageLow !== null && usageHigh !== null) {
    console.log(
      `  ${c.dim('total (error band)'.padEnd(26))} ${c.dim(`${usd(fixedHat + usageLow)} – ${usd(fixedHat + usageHigh)}`)}`,
    );
  }
  console.log('');
  console.log(`  ${c.bold('how this is computed')}`);
  console.log(
    c.dim(
      `    usage = ${prior.month} usage ${usd(prior.usage)} × billable-month-size ${wTarget.toFixed(2)}/${wPrior.toFixed(2)}\n` +
        `          = ${usd(usageNaive)} raw` +
        (haveInterval ? `, bias-corrected to ${usd(usagePoint)} using the backtest median error` : ''),
    ),
  );
  console.log(
    c.dim(
      '    "billable month size" weights each calendar day by this account\'s measured\n' +
        '    day-of-week traffic profile, so a month with more weekdays scores higher.',
    ),
  );
  console.log('');
  if (haveInterval) {
    console.log(`  ${c.bold('backtest')}  ${c.dim(`${rels.length} one-month-ahead predictions, out of sample`)}`);
    console.log(
      c.dim(
        `    MAPE ${(mape * 100).toFixed(1)}%   median error ${(median * 100).toFixed(1)}%   ` +
          `p10 ${(quantile(rels, 0.1) * 100).toFixed(1)}%   p90 ${(quantile(rels, 0.9) * 100).toFixed(1)}%`,
      ),
    );
    console.log(
      c.dim(
        '    The band above is the 10th–90th percentile of those errors, inverted onto the\n' +
          '    prediction. 80% of the backtested months fall inside it BY CONSTRUCTION — it is\n' +
          '    an empirical error band, not a statistical confidence interval, and it says\n' +
          '    nothing about months whose traffic pattern differs from the last ' +
          `${rels.length}.`,
      ),
    );
  } else {
    console.log(
      c.yellow(
        `  Only ${rels.length} backtest sample(s) (need ${MIN_BACKTEST_SAMPLES}) — point estimate only, no interval.`,
      ),
    );
  }
  if (mtdProjection) {
    console.log('');
    console.log(`  ${c.bold('cross-check')}  ${c.dim('from usage accrued so far this month')}`);
    console.log(
      c.dim(
        `    ${usd(mtd.usage)} usage over ${mtdProjection.elapsedDays.toFixed(2)} elapsed day(s) →\n` +
          `    ${usd(mtdProjection.value)} full-month usage (${usd(fixedHat + mtdProjection.value)} total).`,
      ),
    );
    console.log(
      c.dim(
        '    NOT backtested: the API exposes no historical month-to-date snapshots, so this\n' +
          '    estimator has no measurable error. Treat a large gap between the two as a\n' +
          '    signal that this month is genuinely off-trend.',
      ),
    );
  }
}

// ─── billing summary ─────────────────────────────────────────────────────────

async function cmdSummary(flags) {
  const year = str(flags.year);
  // Whole history: 105 invoices for this account today, so one bounded walk.
  const invoices = (await fetchInvoices(PAGE_LIMIT * MAX_PAGES)).map(analyse);
  if (!invoices.length) {
    console.log(c.dim('  No invoices found.'));
    return;
  }
  const scoped = year ? invoices.filter((a) => a.month.startsWith(year)) : invoices;
  if (year && !scoped.length) {
    cli.die(`No invoices for ${year}. Available years: ${[...new Set(invoices.map((a) => a.month.slice(0, 4)))].sort().join(', ')}`, {
      prefix: 'fastly-ext',
    });
  }
  const byYear = {};
  for (const a of invoices) {
    const y = a.month.slice(0, 4);
    byYear[y] = byYear[y] || { total: 0, fixed: 0, usage: 0, months: 0 };
    byYear[y].total += a.total;
    byYear[y].fixed += a.fixed;
    byYear[y].usage += a.usage;
    byYear[y].months += 1;
  }
  const unpaid = invoices.filter((a) => a.payment_status && a.payment_status !== 'paid');

  if (flags.json) {
    cli.out({
      months: scoped.map((a) => ({
        month: a.month,
        invoice_id: a.invoice_id,
        total: a.total,
        fixed: a.fixed,
        usage: a.usage,
        payment_status: a.payment_status,
      })),
      years: byYear,
      unpaid: unpaid.map((a) => ({ month: a.month, invoice_id: a.invoice_id, total: a.total, payment_status: a.payment_status })),
    });
    return;
  }

  const detail = year ? scoped : scoped.filter((a) => a.month.startsWith(String(new Date().getUTCFullYear())));
  const detailYear = year || String(new Date().getUTCFullYear());
  console.log('');
  console.log(`  ${c.bold(detailYear)}  ${c.dim('per month')}`);
  console.log('');
  if (!detail.length) {
    console.log(c.dim(`    No invoices in ${detailYear}.`));
  }
  for (const a of [...detail].sort((x, y) => x.month.localeCompare(y.month))) {
    const paid = a.payment_status === 'paid';
    console.log(
      `    ${a.month}  ${c.dim((a.invoice_id || '').padEnd(12))} ${usd(a.total, a.currency).padStart(11)}  ` +
        `${c.dim(`fixed ${usd(a.fixed)}  usage ${usd(a.usage)}`)}  ${paid ? c.green('paid') : c.yellow(a.payment_status || 'open')}`,
    );
  }
  console.log('');
  console.log(`  ${c.bold('annual totals')}`);
  for (const [y, v] of Object.entries(byYear).sort()) {
    console.log(
      `    ${y}  ${usd(v.total).padStart(12)}  ${c.dim(`fixed ${usd(v.fixed)}  usage ${usd(v.usage)}  (${v.months} month(s))`)}`,
    );
  }
  console.log('');
  if (unpaid.length) {
    const owed = unpaid.reduce((s, a) => s + a.total, 0);
    console.log(`  ${c.yellow(c.bold(`⚠ ${unpaid.length} invoice(s) not marked paid — ${usd(owed)} outstanding`))}`);
    for (const a of unpaid.sort((x, y) => x.month.localeCompare(y.month))) {
      console.log(`    ${a.month}  ${c.cyan(a.invoice_id)}  ${usd(a.total)}  ${c.yellow(a.payment_status)}`);
    }
  } else {
    console.log(c.green('  ✓ every invoice is marked paid'));
  }
}

// ─── args + main ─────────────────────────────────────────────────────────────

const HELP = `
fastly-ext — SLICC-only extensions to the fastly skill. The upstream Fastly CLI
             has no billing command group, so billing lives here and \`fastly\`
             stays command-compatible with github.com/fastly/cli.

USAGE
  fastly-ext billing invoices [--limit N] [--json]
      Recent invoices, newest first, with the fixed/usage split and payment
      status. Cursor-paginated behind the scenes (--limit 105 gets the lot).

  fastly-ext billing invoice <INV-id|month-to-date> [--json]
      One invoice broken down by product_group (fixed vs usage) plus the
      largest line items.

  fastly-ext billing mtd [--json]
      Month-to-date. Splits fixed subscriptions from accrued usage and warns
      that the raw figure is NOT a run rate: fixed charges land on day 1.

  fastly-ext billing forecast [--window N] [--json]
      Forecast this month's invoice. Fixed charges are carried from the prior
      invoice; usage is the prior month's usage rescaled by day-of-week-weighted
      month size. The error band is derived from an out-of-sample backtest of
      that same estimator over the last N months (default ${DEFAULT_BACKTEST_WINDOW}): it is the
      10th-90th percentile of observed relative errors, inverted onto the
      prediction. 80% of the backtested months fall inside it BY CONSTRUCTION.
      It is an empirical error band, NOT a statistical confidence interval.
      With fewer than ${MIN_BACKTEST_SAMPLES} usable samples, only a point estimate is printed.

  fastly-ext billing summary [--year YYYY] [--json]
      Per-month totals for a year plus annual sums for the whole history, and
      an explicit list of invoices whose payment_status is not "paid".

FLAGS
  --json            Raw JSON instead of the formatted view
  --limit N         How many invoices to fetch (invoices)
  --window N        Backtest window in months (forecast, default ${DEFAULT_BACKTEST_WINDOW})
  --year YYYY       Restrict the per-month detail (summary)

REQUIRES
  Authentication is shared with \`fastly\`: run \`fastly auth login --token <tok>\`
  once (or keep a logged-in manage.fastly.com tab open). Every request here is
  issued through \`fastly api\`, so there is a single token implementation.
`.trim();

const parsed = process.argv.parseFlags();
const subcommand = parsed.subcommand || '';
const positional = parsed.positional.slice(1);
const flags = parsed.flags;

async function main() {
  if (flags.help || flags.h || !subcommand || subcommand === 'help') cli.help(HELP);

  try {
    if (subcommand !== 'billing') {
      cli.die(`unknown command: ${subcommand}\nRun 'fastly-ext --help' for usage.`, { prefix: 'fastly-ext' });
    }
    const sub = str(positional[0]);
    const rest = positional.slice(1);
    if (sub === 'invoices' || sub === 'list') return await cmdInvoices(flags);
    if (sub === 'invoice' || sub === 'describe') return await cmdInvoice(rest, flags);
    if (sub === 'mtd' || sub === 'month-to-date') return await cmdMtd(flags);
    if (sub === 'forecast' || sub === 'estimate') return await cmdForecast(flags);
    if (sub === 'summary') return await cmdSummary(flags);
    cli.die(
      `unknown billing subcommand: ${sub || '(none)'}\n` +
        '  fastly-ext billing invoices | invoice <id> | mtd | forecast | summary',
      { prefix: 'fastly-ext' },
    );
  } catch (err) {
    if (err?.name === 'NodeExitError') throw err; // MANDATORY re-throw
    cli.die(err.message, { prefix: 'fastly-ext' });
  }
}

await main();

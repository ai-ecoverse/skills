// aws-ext.jsh — SLICC-only extensions to the `aws` skill.
//
// The real AWS CLI has no cost-ANALYSIS command: `aws ce get-cost-and-usage`
// hands you a JSON blob and leaves interpretation to you. Interpretation is
// where the mistakes happen, and every command here exists because a real
// analysis got it wrong first:
//
//   cost discounts  An account showed $236,827 of gross usage but a $145,380
//                   net bill: an Enterprise Discount Program discount of
//                   -$82,949 (35%) plus a -$8,496 Private Rate Card discount.
//                   Gross and net differ by more than a third, so a comparison
//                   that does not say which one it quotes is meaningless.
//   cost breaks     An account ramped $10,275 → $15,365/mo through Jan 2026,
//                   then HALVED to $6-9k from Feb after an optimisation.
//                   Full-history growth said -9%/yr, the last 6 months said
//                   +53%/yr. Both numbers are true and both are misleading:
//                   the series has a regime break and needs per-regime means.
//   cost detail     S3 turned out to be REQUEST-driven, not storage-driven:
//                   142 billion Tier-2 requests ($35,373) against ~$147/mo of
//                   stored bytes. "Delete old objects" would have saved nothing.
//   cost accounts   The first credential we tried saw only a $400/mo "delivery
//                   tier" — it was a standalone account, and the real spend
//                   lived in a different account entirely.
//
// All HTTP goes through the sibling `aws ce get-cost-and-usage --json` command
// so that credential resolution, SigV4 signing, pagination and the 14-month
// clamp live in exactly one place — the same split the fastly skill uses for
// `fastly-ext billing` and gcloud for `gcloud-ext billing cost`.

const cli = require('sliccy:cli');
const exec = require('sliccy:exec');
const c = require('sliccy:color');
// Literal requires: this runtime resolves a VFS module only when its path
// appears as a literal string in the calling source.
const sigv4 = require('./lib/sigv4.js');
const vectors = require('./lib/sigv4-vectors.js');

// Record types that ADD to the bill vs. record types that SUBTRACT from it.
// Cost Explorer returns discounts as negative UnblendedCost rows under
// RECORD_TYPE, so a naive "share of total" over mixed signs yields nonsense
// (we measured a 162.6% share exactly this way).
const CREDIT_RECORD_TYPES = [
  'Credit',
  'Refund',
  'Enterprise Discount Program Discount',
  'Private Rate Card Discount',
  'Bundled Discount',
  'Solution Provider Program Discount',
  'SavingsPlanNegation',
  'EDP Discount',
];

// ANSI SGR matcher built from a char code so the source carries no literal
// control character (Biome's noControlCharactersInRegex).
const ANSI = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, 'g');

const HELP = `aws-ext — cost analysis the upstream AWS CLI does not have

Usage: aws-ext <group> <command> [flags]

  aws-ext cost summary [--months N] [--group-by SERVICE|USAGE_TYPE|REGION|RECORD_TYPE|LINKED_ACCOUNT] [--json]
      Monthly net totals plus the top contributors. Marks the current partial
      month [Estimated] and lists negative (discount/credit) rows separately so
      shares stay meaningful.

  aws-ext cost discounts [--months N] [--json]
      Gross vs net, with every discount broken out by RECORD_TYPE. Run this
      BEFORE quoting an AWS number anywhere: EDP and Private Rate Card discounts
      routinely move the figure by 30-40%.

  aws-ext cost breaks [--months N] [--group-by DIM] [--json]
      Detects a regime break (step change) in the monthly series and reports
      per-regime means instead of one misleading growth rate.

  aws-ext cost detail --service <name> [--usage-type] [--months N] [--json]
      Drill into one service with UsageQuantity, so you can see whether the
      driver is requests, storage or transfer.

  aws-ext cost accounts [--months N] [--json]
      Group by LINKED_ACCOUNT: is this credential a payer with children, or a
      standalone account whose spend is not the spend you are looking for?

  aws-ext sigv4 verify [--json]
      Offline self-test: signs the bundled official AWS SigV4 test vectors and
      compares canonical request, string-to-sign and Authorization byte-for-byte.
      Needs no credentials and no network. Run it first if signing ever fails.

Flags: --months N (default 12, counted back from the current month),
--start/--end YYYY-MM-DD (End EXCLUSIVE) override --months, --json for raw data.`;

// ─── Helpers ─────────────────────────────────────────────────────────────────

function str(v) {
  if (Array.isArray(v)) return v.filter((x) => typeof x === 'string').pop();
  return typeof v === 'string' ? v : undefined;
}

function num(v, dflt) {
  const s = str(v);
  if (s === undefined) return dflt;
  const n = Number(s);
  return Number.isFinite(n) ? n : dflt;
}

function monthStart(delta) {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + (delta || 0), 1)).toISOString().slice(0, 10);
}

function fmtUSD(n) {
  const v = Number(n) || 0;
  const s = Math.abs(v).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return `${v < 0 ? '-' : ''}$${s}`;
}

function fmtQty(n) {
  const v = Number(n) || 0;
  if (v >= 1e9) return `${(v / 1e9).toFixed(2)}B`;
  if (v >= 1e6) return `${(v / 1e6).toFixed(2)}M`;
  if (v >= 1e3) return `${(v / 1e3).toFixed(2)}k`;
  return v.toFixed(2);
}

function pct(part, whole) {
  if (!whole) return 'n/a';
  return `${((part / whole) * 100).toFixed(1)}%`;
}

function pad(s, w) {
  const t = String(s);
  return t.length >= w ? t : t + ' '.repeat(w - t.length);
}

function padLeft(s, w) {
  const t = String(s);
  return t.length >= w ? t : ' '.repeat(w - t.length) + t;
}

function monthLabel(iso) {
  return String(iso).slice(0, 7);
}

/** Is this RECORD_TYPE a reduction by name? Note the two traps:
 *  "DiscountedUsage" and "SavingsPlanCoveredUsage" are CHARGES despite reading
 *  like discounts, so they are excluded before any name matching. */
function isCredit(recordType) {
  const t = String(recordType || '').trim();
  if (/^discountedusage$/i.test(t) || /coveredusage/i.test(t)) return false;
  return (
    CREDIT_RECORD_TYPES.some((k) => k.toLowerCase() === t.toLowerCase()) ||
    /\bdiscount\b|\bcredit\b|\brefund\b|negation/i.test(t)
  );
}

/** The window: --start/--end win, otherwise the last N months including the
 *  current partial one. End is EXCLUSIVE, so it is the 1st of next month. */
function windowFlags(flags, defaultMonths) {
  const months = num(flags.months, defaultMonths === undefined ? 12 : defaultMonths);
  const start = str(flags.start) || monthStart(-(months - 1));
  const end = str(flags.end) || monthStart(1);
  return { start, end, months };
}

// ─── Transport: delegate to `aws ce get-cost-and-usage` ──────────────────────

async function ce(args) {
  const argv = ['aws', 'ce', 'get-cost-and-usage', '--json', ...args];
  const { stdout, stderr, exitCode } = await exec.spawn(argv);
  const noise = (stderr || '').replace(ANSI, '').trim();
  if (exitCode !== 0) {
    cli.die(noise || (stdout || '').trim() || `\`${argv.join(' ')}\` failed`, { prefix: 'aws-ext' });
  }
  // The child emits the 14-month clamp warning on stderr; re-emit it rather
  // than swallowing it, so a truncated window is never silently analysed.
  if (noise) process.stderr.write(`${noise}\n`);
  try {
    return JSON.parse(stdout);
  } catch {
    cli.die(`could not parse the Cost Explorer response from \`${argv.join(' ')}\``, { prefix: 'aws-ext' });
  }
}

async function ceMonthly({ start, end, groupBy, metrics, filter }) {
  const args = ['--start', start, '--end', end, '--granularity', 'MONTHLY'];
  if (metrics) args.push('--metrics', metrics);
  if (groupBy) args.push('--group-by', groupBy);
  if (filter) args.push('--filter', JSON.stringify(filter));
  return await ce(args);
}

/** Flatten a GetCostAndUsage response into
 *  [{ month, estimated, total, groups: [{key, amount, quantity}] }]. */
function series(data, metric) {
  const m = metric || 'UnblendedCost';
  return (data.ResultsByTime || []).map((r) => {
    const groups = (r.Groups || []).map((g) => ({
      key: (g.Keys || []).join(' / '),
      amount: Number(g.Metrics?.[m]?.Amount || 0),
      quantity: Number(g.Metrics?.UsageQuantity?.Amount || 0),
      unit: g.Metrics?.UsageQuantity?.Unit || '',
    }));
    const total = groups.length
      ? groups.reduce((s, x) => s + x.amount, 0)
      : Number(r.Total?.[m]?.Amount || 0);
    return {
      month: monthLabel(r.TimePeriod.Start),
      start: r.TimePeriod.Start,
      end: r.TimePeriod.End,
      estimated: !!r.Estimated,
      total,
      groups,
    };
  });
}

/** Sum groups across the whole window, keeping positive and negative buckets
 *  apart. Percentages are always taken against `positive` (gross): mixing signs
 *  is how a share of 162.6% happens. */
function aggregate(rows) {
  const byKey = new Map();
  for (const row of rows) {
    for (const g of row.groups) {
      const cur = byKey.get(g.key) || { key: g.key, amount: 0, quantity: 0, unit: g.unit };
      cur.amount += g.amount;
      cur.quantity += g.quantity;
      byKey.set(g.key, cur);
    }
  }
  const all = Array.from(byKey.values()).sort((a, b) => b.amount - a.amount);
  const positive = all.filter((x) => x.amount > 0).reduce((s, x) => s + x.amount, 0);
  const negative = all.filter((x) => x.amount < 0).reduce((s, x) => s + x.amount, 0);
  return { all, positive, negative, net: positive + negative };
}

function estimatedNote(rows) {
  const est = rows.filter((r) => r.estimated).map((r) => r.month);
  if (!est.length) return '';
  return c.yellow(
    `\nNote: ${est.join(', ')} is marked Estimated by Cost Explorer — it is a PARTIAL month.\n` +
      '  A partial month is not a decline. Exclude it from any trend or run-rate.',
  );
}

// ─── cost summary ────────────────────────────────────────────────────────────

async function cmdSummary(flags) {
  const { start, end } = windowFlags(flags, 12);
  const groupKey = (str(flags['group-by']) || 'SERVICE').toUpperCase();
  const data = await ceMonthly({ start, end, groupBy: groupKey });
  const rows = series(data);
  const agg = aggregate(rows);

  if (flags.json) {
    return cli.out({
      window: { start, end, endExclusive: true },
      groupBy: groupKey,
      months: rows.map((r) => ({ month: r.month, net: r.total, estimated: r.estimated })),
      gross: agg.positive,
      discounts: agg.negative,
      net: agg.net,
      contributors: agg.all,
      clamped: data.Clamped || null,
    });
  }

  const out = [];
  out.push(c.bold(`Monthly net cost ${start} → ${end} (End exclusive), grouped by ${groupKey}`));
  const full = rows.filter((r) => !r.estimated);
  for (const r of rows) {
    const bar = '█'.repeat(Math.max(0, Math.round((r.total / Math.max(1, Math.max(...rows.map((x) => x.total)))) * 24)));
    out.push(
      `  ${pad(r.month, 9)}${padLeft(fmtUSD(r.total), 14)}  ${c.dim(bar)}${r.estimated ? c.yellow(' [Estimated]') : ''}`,
    );
  }
  if (full.length >= 2) {
    const mean = full.reduce((s, x) => s + x.total, 0) / full.length;
    const last = full[full.length - 1];
    out.push(
      c.dim(
        `  mean of ${full.length} complete months ${fmtUSD(mean)} · latest complete ${last.month} ${fmtUSD(last.total)}`,
      ),
    );
  }

  out.push(`\n${c.bold(`Top contributors by ${groupKey}`)} ${c.dim('(share of gross, i.e. positive spend only)')}`);
  const width = Math.min(46, Math.max(12, ...agg.all.slice(0, 12).map((x) => x.key.length)));
  for (const g of agg.all.filter((x) => x.amount > 0).slice(0, 12)) {
    out.push(`  ${pad(g.key.slice(0, width), width)}${padLeft(fmtUSD(g.amount), 14)}  ${padLeft(pct(g.amount, agg.positive), 6)}`);
  }
  const negatives = agg.all.filter((x) => x.amount < 0);
  if (negatives.length) {
    out.push(`\n${c.bold('Negative rows (discounts / credits / refunds)')} ${c.dim('— excluded from the shares above')}`);
    for (const g of negatives) {
      out.push(`  ${pad(g.key.slice(0, width), width)}${c.green(padLeft(fmtUSD(g.amount), 14))}  ${padLeft(pct(-g.amount, agg.positive), 6)} of gross`);
    }
    if (groupKey === 'REGION') {
      out.push(
        c.dim('  Grouped by REGION, discounts land under the key "NoRegion" — they are not a region.'),
      );
    }
  }
  out.push('');
  out.push(`  ${pad('gross (positive rows)', 30)}${padLeft(fmtUSD(agg.positive), 14)}`);
  out.push(`  ${pad('discounts / credits', 30)}${padLeft(fmtUSD(agg.negative), 14)}`);
  out.push(c.bold(`  ${pad('net (what AWS invoices)', 30)}${padLeft(fmtUSD(agg.net), 14)}`));
  if (agg.negative < 0) {
    out.push(c.dim(`  net is ${pct(agg.net, agg.positive)} of gross → see \`aws-ext cost discounts\` for the breakdown`));
  }
  const note = estimatedNote(rows);
  if (note) out.push(note);
  cli.out(out.join('\n'));
}

// ─── cost discounts ──────────────────────────────────────────────────────────

async function cmdDiscounts(flags) {
  const { start, end } = windowFlags(flags, 12);
  const data = await ceMonthly({ start, end, groupBy: 'RECORD_TYPE' });
  const rows = series(data);
  const agg = aggregate(rows);

  const charges = agg.all.filter((x) => x.amount > 0);
  const credits = agg.all.filter((x) => x.amount < 0);
  const usage = charges.find((x) => /^Usage$/i.test(x.key));
  // A reduction-by-name row that nets POSITIVE over the window (a credit
  // reversed inside it, say) would otherwise be summed silently into gross.
  const misSigned = charges.filter((x) => isCredit(x.key));

  if (flags.json) {
    return cli.out({
      window: { start, end, endExclusive: true },
      gross: agg.positive,
      net: agg.net,
      netShareOfGross: agg.positive ? agg.net / agg.positive : null,
      charges,
      positiveReductionRows: misSigned.map((x) => x.key),
      discounts: credits.map((x) => ({ ...x, shareOfGross: agg.positive ? -x.amount / agg.positive : null })),
      byMonth: rows.map((r) => ({
        month: r.month,
        estimated: r.estimated,
        net: r.total,
        gross: r.groups.filter((g) => g.amount > 0).reduce((s, g) => s + g.amount, 0),
        rows: r.groups,
      })),
      clamped: data.Clamped || null,
    });
  }

  const out = [];
  out.push(c.bold(`Gross vs net, ${start} → ${end} (End exclusive), by RECORD_TYPE`));
  out.push('');
  const width = Math.max(28, ...agg.all.map((x) => x.key.length));
  out.push(c.bold('  Charges'));
  for (const x of charges) {
    out.push(`    ${pad(x.key, width)}${padLeft(fmtUSD(x.amount), 15)}`);
  }
  // Colour AFTER padding: pad() counts the ANSI escape bytes as characters, so
  // padding a coloured string silently breaks the column alignment.
  out.push(c.bold(`    ${pad('gross', width)}${padLeft(fmtUSD(agg.positive), 15)}`));
  if (credits.length) {
    out.push('');
    out.push(c.bold('  Discounts, credits and refunds'));
    // Largest reduction first — that is the one that changes a conclusion.
    for (const x of [...credits].sort((a, b) => a.amount - b.amount)) {
      out.push(
        `    ${pad(x.key, width)}${c.green(padLeft(fmtUSD(x.amount), 15))}  ${padLeft(pct(-x.amount, agg.positive), 7)} of gross`,
      );
    }
    out.push(`    ${pad('total reductions', width)}${c.green(padLeft(fmtUSD(agg.negative), 15))}  ${padLeft(pct(-agg.negative, agg.positive), 7)} of gross`);
  } else {
    out.push('');
    out.push(c.dim('  No negative RECORD_TYPE rows in this window: no EDP, PRC, bundled discount, credit or refund.'));
  }
  if (misSigned.length) {
    out.push('');
    out.push(
      c.yellow(
        `    Note: ${misSigned.map((x) => x.key).join(', ')} netted POSITIVE over this window.\n` +
          '    A reduction row that comes back positive is usually a credit reversed inside\n' +
          '    the window — it is counted in gross above, which may not be what you want.',
      ),
    );
  }
  out.push('');
  out.push(c.bold(`    ${pad('NET (what AWS invoices)', width)}${padLeft(fmtUSD(agg.net), 15)}  ${padLeft(pct(agg.net, agg.positive), 7)} of gross`));

  out.push('');
  out.push(c.bold('  Per month'));
  out.push(`    ${pad('month', 9)}${padLeft('gross', 14)}${padLeft('discounts', 14)}${padLeft('net', 14)}`);
  for (const r of rows) {
    const gross = r.groups.filter((g) => g.amount > 0).reduce((s, g) => s + g.amount, 0);
    const disc = r.groups.filter((g) => g.amount < 0).reduce((s, g) => s + g.amount, 0);
    out.push(
      `    ${pad(r.month, 9)}${padLeft(fmtUSD(gross), 14)}${padLeft(fmtUSD(disc), 14)}${padLeft(fmtUSD(r.total), 14)}` +
        (r.estimated ? c.yellow(' [Estimated]') : ''),
    );
  }

  if (credits.length) {
    const biggest = credits.reduce((a, b) => (a.amount < b.amount ? a : b));
    out.push('');
    out.push(
      c.yellow('  Which number should you quote?') +
        `\n    gross ${fmtUSD(agg.positive)} is list price; net ${fmtUSD(agg.net)} is the invoice.` +
        `\n    They differ by ${fmtUSD(-agg.negative)} (${pct(-agg.negative, agg.positive)}), mostly "${biggest.key}".` +
        '\n    Compare like with like: a competitor\'s list price against GROSS, a budget or' +
        '\n    an actual-spend claim against NET. State which one you used — a 35% gap is' +
        '\n    larger than most of the differences people use these figures to argue about.',
    );
    if (usage && /discountedusage/i.test(charges.map((x) => x.key).join(' '))) {
      out.push(
        c.dim(
          '    "DiscountedUsage" is Reserved-Instance/Savings-Plan-covered usage at $0-ish, not a discount row.',
        ),
      );
    }
  }
  const note = estimatedNote(rows);
  if (note) out.push(note);
  cli.out(out.join('\n'));
}

// ─── cost breaks ─────────────────────────────────────────────────────────────

function mean(xs) {
  return xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : 0;
}

function stddev(xs) {
  if (xs.length < 2) return 0;
  const m = mean(xs);
  return Math.sqrt(xs.reduce((s, x) => s + (x - m) ** 2, 0) / (xs.length - 1));
}

/** Annualised growth from first to last value of an evenly spaced monthly
 *  series: (last/first)^(12/(n-1)) - 1. Undefined for a non-positive first
 *  value, and meaningless across a regime break — hence the warnings. */
function annualisedGrowth(values) {
  if (values.length < 2) return null;
  const first = values[0];
  const last = values[values.length - 1];
  if (first <= 0 || last <= 0) return null;
  return (last / first) ** (12 / (values.length - 1)) - 1;
}

/** Single best split point by largest standardised difference of means
 *  (a two-sample t statistic on the split). Requires >= 2 months per side. */
function findBreak(values) {
  if (values.length < 5) return null;
  let best = null;
  for (let i = 2; i <= values.length - 2; i++) {
    const a = values.slice(0, i);
    const b = values.slice(i);
    const ma = mean(a);
    const mb = mean(b);
    const sa = stddev(a);
    const sb = stddev(b);
    const se = Math.sqrt(sa ** 2 / a.length + sb ** 2 / b.length) || 1e-9;
    const t = Math.abs(mb - ma) / se;
    const rel = ma ? (mb - ma) / ma : 0;
    if (!best || t > best.t) best = { index: i, meanBefore: ma, meanAfter: mb, t, rel, sdBefore: sa, sdAfter: sb };
  }
  if (!best) return null;
  // Call it a break only when the step is both large in relative terms and
  // large compared with the within-regime noise. Thresholds are deliberately
  // conservative: a false "break" is worse than a missed one, because it splits
  // a series that should have been read as one trend.
  best.isBreak = Math.abs(best.rel) >= 0.25 && best.t >= 3;
  return best;
}

async function cmdBreaks(flags) {
  const { start, end } = windowFlags(flags, 18);
  const groupKey = str(flags['group-by']);
  const data = await ceMonthly({ start, end, groupBy: groupKey ? groupKey.toUpperCase() : undefined });
  const rows = series(data);
  // The current month is partial (Estimated) and would masquerade as a cliff.
  const full = rows.filter((r) => !r.estimated);
  if (full.length < 4) {
    cli.die(
      `need at least 4 complete months to look for a regime break, got ${full.length}.\n` +
        '  Widen the window: aws-ext cost breaks --months 18',
      { prefix: 'aws-ext' },
    );
  }
  const values = full.map((r) => r.total);
  const brk = findBreak(values);
  const growthAll = annualisedGrowth(values);
  const recent = values.slice(-6);
  const growthRecent = recent.length >= 2 ? annualisedGrowth(recent) : null;

  const regimes = brk
    ? [
        { from: full[0].month, to: full[brk.index - 1].month, months: brk.index, mean: brk.meanBefore, sd: brk.sdBefore },
        {
          from: full[brk.index].month,
          to: full[full.length - 1].month,
          months: full.length - brk.index,
          mean: brk.meanAfter,
          sd: brk.sdAfter,
        },
      ]
    : [];

  if (flags.json) {
    return cli.out({
      window: { start, end, endExclusive: true },
      completeMonths: full.map((r) => ({ month: r.month, net: r.total })),
      excludedEstimated: rows.filter((r) => r.estimated).map((r) => r.month),
      break: brk ? { at: full[brk.index].month, ...brk } : null,
      regimes,
      annualisedGrowthFullHistory: growthAll,
      annualisedGrowthLast6: growthRecent,
      clamped: data.Clamped || null,
    });
  }

  const out = [];
  out.push(c.bold(`Regime analysis of monthly net cost, ${full[0].month} → ${full[full.length - 1].month}`));
  const maxV = Math.max(...values);
  for (let i = 0; i < full.length; i++) {
    const marker = brk?.isBreak && i === brk.index ? c.red(' ← break') : '';
    out.push(
      `  ${pad(full[i].month, 9)}${padLeft(fmtUSD(values[i]), 14)}  ${c.dim('█'.repeat(Math.round((values[i] / maxV) * 24)))}${marker}`,
    );
  }
  out.push('');
  if (brk?.isBreak) {
    out.push(
      c.yellow(`  REGIME BREAK detected at ${full[brk.index].month}`) +
        ` (step ${brk.rel > 0 ? '+' : ''}${(brk.rel * 100).toFixed(0)}%, t=${brk.t.toFixed(1)})`,
    );
    for (const r of regimes) {
      out.push(
        `    ${pad(`${r.from} → ${r.to}`, 20)}${r.months} months, mean ${padLeft(fmtUSD(r.mean), 13)} ± ${fmtUSD(r.sd)}`,
      );
    }
    out.push('');
    out.push(
      `  ${c.bold('Do not quote a single growth rate for this series.')}\n` +
        `    full history:   ${growthAll === null ? 'n/a' : `${(growthAll * 100).toFixed(0)}%/yr`}\n` +
        `    last 6 months:  ${growthRecent === null ? 'n/a' : `${(growthRecent * 100).toFixed(0)}%/yr`}\n` +
        '    Both are artefacts of where the window falls relative to the break.\n' +
        `    Use the per-regime means above, and the current regime's mean ${fmtUSD(regimes[1].mean)} as the run rate.`,
    );
  } else {
    out.push(c.dim('  No regime break found (no step change ≥25% that is also large vs within-regime noise).'));
    out.push(
      `    annualised growth, full history: ${growthAll === null ? 'n/a' : `${(growthAll * 100).toFixed(0)}%/yr`}` +
        `\n    annualised growth, last 6 months: ${growthRecent === null ? 'n/a' : `${(growthRecent * 100).toFixed(0)}%/yr`}` +
        `\n    mean ${fmtUSD(mean(values))} ± ${fmtUSD(stddev(values))} over ${values.length} complete months`,
    );
    if (brk) {
      out.push(
        c.dim(
          `    (closest candidate split was ${full[brk.index].month}: ${(brk.rel * 100).toFixed(0)}%, t=${brk.t.toFixed(1)} — below threshold)`,
        ),
      );
    }
  }
  const note = estimatedNote(rows);
  if (note) out.push(note);
  cli.out(out.join('\n'));
}

// ─── cost detail ─────────────────────────────────────────────────────────────

async function cmdDetail(flags) {
  const service = str(flags.service);
  if (!service) {
    cli.die(
      'usage: aws-ext cost detail --service "<exact service name>"\n' +
        '  Names are Cost Explorer SERVICE values, e.g. "Amazon Simple Storage Service",\n' +
        '  "Amazon Elastic Compute Cloud - Compute", "AmazonCloudFront".\n' +
        '  List what your account actually has: aws ce get-dimension-values --dimension SERVICE',
      { prefix: 'aws-ext' },
    );
  }
  const { start, end } = windowFlags(flags, 6);
  // USAGE_TYPE is the point of this command (it is what carries UsageQuantity),
  // so it is the default; --usage-type is an explicit alias for it, and
  // --group-by lets you pivot to OPERATION, REGION or USAGE_TYPE_GROUP instead.
  const dim = flags['usage-type'] ? 'USAGE_TYPE' : String(str(flags['group-by']) || 'USAGE_TYPE').toUpperCase();
  const data = await ceMonthly({
    start,
    end,
    groupBy: dim,
    metrics: 'UnblendedCost,UsageQuantity',
    filter: { Dimensions: { Key: 'SERVICE', Values: [service] } },
  });
  const rows = series(data);
  const agg = aggregate(rows);
  if (!agg.all.length) {
    cli.die(
      `no cost rows for SERVICE "${service}" between ${start} and ${end}.\n` +
        '  The name must match exactly. List the real values with:\n' +
        '    aws ce get-dimension-values --dimension SERVICE',
      { prefix: 'aws-ext' },
    );
  }
  // The monthly mean must come from COMPLETE months only. Dividing a window
  // total that includes the current partial month by the number of complete
  // months inflates the per-month figure; dividing by all months deflates it.
  const completeRows = rows.filter((r) => !r.estimated);
  const basis = completeRows.length ? completeRows : rows;
  const aggComplete = aggregate(basis);
  const months = Math.max(1, basis.length);
  const perMonth = (key) => {
    const hit = aggComplete.all.find((x) => x.key === key);
    return (hit ? hit.amount : 0) / months;
  };

  if (flags.json) {
    return cli.out({
      service,
      window: { start, end, endExclusive: true },
      groupBy: dim,
      gross: agg.positive,
      net: agg.net,
      usageTypes: agg.all.map((x) => ({
        usageType: x.key,
        cost: x.amount,
        quantity: x.quantity,
        unit: x.unit,
        unitCost: x.quantity ? x.amount / x.quantity : null,
        monthlyMeanCompleteMonths: perMonth(x.key),
      })),
      completeMonths: months,
      byMonth: rows.map((r) => ({ month: r.month, estimated: r.estimated, net: r.total })),
      clamped: data.Clamped || null,
    });
  }

  const out = [];
  out.push(c.bold(`${service} — ${start} → ${end} (End exclusive), by ${dim}`));
  out.push('');
  out.push(`  ${pad('usage type', 40)}${padLeft('cost', 14)}${padLeft('/mo', 12)}${padLeft('quantity', 12)}  unit`);
  out.push(c.dim(`  ${pad('', 40)}${padLeft('window', 14)}${padLeft(`${months} full mo`, 12)}${padLeft('window', 12)}`));
  for (const x of agg.all.slice(0, 20)) {
    if (x.amount === 0 && !x.quantity) continue;
    out.push(
      `  ${pad(x.key.slice(0, 40), 40)}${padLeft(fmtUSD(x.amount), 14)}${padLeft(fmtUSD(perMonth(x.key)), 12)}` +
        `${padLeft(fmtQty(x.quantity), 12)}  ${c.dim(x.unit)}`,
    );
  }
  out.push('');
  out.push(`  ${pad('total (net)', 40)}${padLeft(fmtUSD(agg.net), 14)}${padLeft(fmtUSD(aggComplete.net / months), 12)}`);

  // The point of --usage-type: name the actual driver. "Requests" and "Storage"
  // demand completely different optimisations, and the cost table alone hides
  // which one you have.
  const reqs = agg.all.filter((x) => /request|Requests-Tier/i.test(x.key));
  const stor = agg.all.filter((x) => /storage|TimedStorage|ByteHrs/i.test(x.key));
  const xfer = agg.all.filter((x) => /bytes|DataTransfer|Out-Bytes/i.test(x.key));
  const sum = (xs) => xs.reduce((s, x) => s + x.amount, 0);
  if (reqs.length || stor.length || xfer.length) {
    out.push('');
    out.push(c.bold('  What actually drives this bill'));
    const parts = [
      ['requests', sum(reqs), reqs.reduce((s, x) => s + x.quantity, 0)],
      ['storage', sum(stor), stor.reduce((s, x) => s + x.quantity, 0)],
      ['data transfer', sum(xfer), xfer.reduce((s, x) => s + x.quantity, 0)],
    ].filter(([, v]) => v !== 0);
    for (const [label, v, q] of parts) {
      out.push(`    ${pad(label, 16)}${padLeft(fmtUSD(v), 14)}  ${padLeft(pct(v, agg.positive), 7)} of gross  ${c.dim(`${fmtQty(q)} units`)}`);
    }
    const top = parts.sort((a, b) => b[1] - a[1])[0];
    if (top && top[0] === 'requests') {
      out.push(
        c.yellow(
          '    This service is REQUEST-driven, not storage-driven: the lever is request count\n' +
            '    (batching, caching, prefix layout, fewer HEAD/LIST calls), not deleting objects.',
        ),
      );
    } else if (top && top[0] === 'storage') {
      out.push(c.dim('    Storage-driven: lifecycle rules, tiering and deletion are the levers.'));
    }
  }
  const note = estimatedNote(rows);
  if (note) out.push(note);
  cli.out(out.join('\n'));
}

// ─── cost accounts ───────────────────────────────────────────────────────────

async function cmdAccounts(flags) {
  const { start, end } = windowFlags(flags, 6);
  const data = await ceMonthly({ start, end, groupBy: 'LINKED_ACCOUNT' });
  const rows = series(data);
  const agg = aggregate(rows);

  // Cost Explorer labels linked accounts by id; the attribute list carries the
  // human-readable name when the caller is the payer.
  const names = new Map();
  for (const a of data.DimensionValueAttributes || []) {
    if (a.Value && a.Attributes?.description) names.set(a.Value, a.Attributes.description);
  }

  let identity = null;
  try {
    const { stdout, exitCode } = await exec.spawn(['aws', 'sts', 'get-caller-identity', '--json']);
    if (exitCode === 0) identity = JSON.parse(stdout);
  } catch {
    identity = null;
  }

  const accounts = agg.all.map((x) => ({
    account: x.key,
    name: names.get(x.key) || null,
    cost: x.amount,
    isCallerAccount: identity ? x.key === identity.Account : null,
  }));
  const standalone = accounts.length <= 1;

  if (flags.json) {
    return cli.out({
      window: { start, end, endExclusive: true },
      callerAccount: identity ? identity.Account : null,
      standalone,
      accounts,
      gross: agg.positive,
      net: agg.net,
      clamped: data.Clamped || null,
    });
  }

  const out = [];
  out.push(c.bold(`Cost by LINKED_ACCOUNT, ${start} → ${end} (End exclusive)`));
  out.push('');
  const labelOf = (a) => (a.name ? `${a.account}  ${a.name}` : a.account);
  const width = Math.max(14, ...accounts.map((a) => labelOf(a).length));
  for (const a of accounts) {
    const label = labelOf(a);
    out.push(
      `  ${pad(label.slice(0, width), width)}${padLeft(fmtUSD(a.cost), 15)}  ${padLeft(pct(a.cost, agg.positive), 7)}` +
        (a.isCallerAccount ? c.dim('  ← this credential') : ''),
    );
  }
  out.push('');
  out.push(`  ${pad('net total', width)}${padLeft(fmtUSD(agg.net), 15)}`);
  out.push('');
  if (standalone) {
    out.push(
      c.yellow('  This looks like a STANDALONE account, not a payer.') +
        '\n    Only one LINKED_ACCOUNT appears, so this credential sees its own spend and' +
        '\n    nothing else. If the number looks too small to be the whole picture, it' +
        '\n    probably is: the spend you are looking for may live in a different account,' +
        '\n    and Cost Explorer in a member account cannot see its siblings.' +
        `${identity ? `\n    Caller account: ${identity.Account}` : '\n    Run `aws sts get-caller-identity` to confirm which account this is.'}`,
    );
  } else {
    out.push(
      c.dim(
        `  ${accounts.length} linked accounts visible → this credential is (or can read) the PAYER account,\n` +
          '  so these figures are consolidated across the organisation.',
      ),
    );
  }
  const note = estimatedNote(rows);
  if (note) out.push(note);
  cli.out(out.join('\n'));
}

// ─── sigv4 verify ────────────────────────────────────────────────────────────

/** Parse a test-suite .req file: request line, headers (RFC-822 continuation
 *  lines folded into the previous value), blank line, body. */
function parseReq(raw) {
  const lines = raw.split('\n');
  const m = /^(\S+)\s+(.*?)\s+HTTP\/1\.1$/.exec(lines[0]);
  if (!m) throw new Error(`bad request line: ${lines[0]}`);
  const headers = [];
  let i = 1;
  for (; i < lines.length; i++) {
    if (lines[i] === '') {
      i++;
      break;
    }
    if (/^[ \t]/.test(lines[i]) && headers.length) {
      headers[headers.length - 1][1] += ` ${lines[i].trim()}`;
      continue;
    }
    const cix = lines[i].indexOf(':');
    if (cix === -1) break;
    headers.push([lines[i].slice(0, cix), lines[i].slice(cix + 1)]);
  }
  const target = m[2];
  const q = target.indexOf('?');
  return {
    method: m[1],
    path: q === -1 ? target : target.slice(0, q),
    query: q === -1 ? '' : target.slice(q + 1),
    headers,
    body: lines.slice(i).join('\n'),
  };
}

async function cmdSigv4Verify(flags) {
  const results = [];
  for (const v of vectors.VECTORS) {
    const req = parseReq(v.req);
    const host = (req.headers.find(([k]) => k.toLowerCase() === 'host') || [null, ''])[1].trim();
    const amzdate = (req.headers.find(([k]) => k.toLowerCase() === 'x-amz-date') || [null, ''])[1].trim();
    let signed;
    let error;
    try {
      signed = await sigv4.sign({
        method: req.method,
        host,
        path: req.path,
        query: req.query,
        headers: req.headers.filter(([k]) => k.toLowerCase() !== 'host'),
        body: req.body,
        service: vectors.SERVICE,
        region: vectors.REGION,
        amzdate,
        credentials: {
          accessKeyId: vectors.ACCESS_KEY_ID,
          secretAccessKey: vectors.SECRET_ACCESS_KEY,
        },
      });
    } catch (err) {
      error = err.message;
    }
    const checks = {
      canonicalRequest: !!signed && signed.canonicalRequest === v.creq,
      stringToSign: !!signed && signed.stringToSign === v.sts,
      authorization: !!signed && signed.authorization === v.authz,
    };
    results.push({
      name: v.name,
      pass: !error && Object.values(checks).every(Boolean),
      checks,
      error,
      got: signed ? { canonicalRequest: signed.canonicalRequest, stringToSign: signed.stringToSign, authorization: signed.authorization } : null,
      want: { canonicalRequest: v.creq, stringToSign: v.sts, authorization: v.authz },
    });
  }

  // Two extra invariants that no request-level vector covers on its own.
  const hmac = sigv4.hex(await sigv4.hmacSha256(sigv4.utf8('key'), 'The quick brown fox jumps over the lazy dog'));
  const hmacOk = hmac === 'f7bc83f430538424b13298e6aa6fb143ef4d59a14946175997479dbc2d1a3cd8';
  const keyHex = sigv4.hex(await sigv4.deriveSigningKey(vectors.SECRET_ACCESS_KEY, '20150830', 'us-east-1', 'iam'));
  const keyOk = keyHex === 'c4afb1cc5771d871763a393e44b703571b55cc28424d1a5e86da6ed3c154a4b9';
  const sessionVector = vectors.VECTORS.find((v) => /sts-header-before/.test(v.name));

  const passed = results.filter((r) => r.pass).length;
  if (flags.json) {
    return cli.out({
      vectors: results.map(({ name, pass, checks, error }) => ({ name, pass, checks, error })),
      hmacPrimitive: { value: hmac, pass: hmacOk },
      signingKeyDerivation: { value: keyHex, pass: keyOk },
      passed,
      total: results.length,
      allPass: passed === results.length && hmacOk && keyOk,
    });
  }

  const out = [];
  out.push(c.bold('SigV4 self-test against the official AWS aws-sig-v4-test-suite'));
  out.push(c.dim('  offline: no credentials, no network. Fixed key AKIDEXAMPLE, 20150830T123600Z, region us-east-1, service "service".'));
  out.push('');
  for (const r of results) {
    out.push(`  ${r.pass ? c.green('PASS') : c.red('FAIL')}  ${r.name}`);
    if (!r.pass) {
      if (r.error) out.push(c.red(`        threw: ${r.error}`));
      for (const [k, ok] of Object.entries(r.checks)) {
        if (ok) continue;
        out.push(c.red(`        ${k} mismatch`));
        out.push(c.dim(`          got  ${JSON.stringify(r.got ? r.got[k] : null)}`));
        out.push(c.dim(`          want ${JSON.stringify(r.want[k])}`));
      }
    }
  }
  out.push('');
  out.push(`  ${hmacOk ? c.green('PASS') : c.red('FAIL')}  HMAC-SHA256 primitive via WebCrypto subtle (crypto.createHmac does not exist here)`);
  out.push(`  ${keyOk ? c.green('PASS') : c.red('FAIL')}  signing-key derivation AWS4→date→region→service→aws4_request`);
  if (sessionVector) out.push(c.dim('  (post-sts-header-before covers a signed x-amz-security-token, i.e. STS session credentials)'));
  out.push('');
  const allPass = passed === results.length && hmacOk && keyOk;
  out.push(
    allPass
      ? c.green(`  ${passed}/${results.length} vectors match byte-for-byte on canonical request, string-to-sign and Authorization.`)
      : c.red(`  ${passed}/${results.length} vectors pass — the signer is BROKEN, do not trust any cost figure from it.`),
  );
  cli.out(out.join('\n'));
  if (!allPass) process.exit(1);
}

// ─── Router ──────────────────────────────────────────────────────────────────

const { positional, flags } = process.argv.parseFlags();
const group = (positional[0] || '').toLowerCase();
const command = (positional[1] || '').toLowerCase();

try {
  if (flags.help || flags.h || !group || group === 'help') cli.help(HELP);

  if (group === 'cost') {
    if (command === 'summary' || !command) await cmdSummary(flags);
    else if (command === 'discounts' || command === 'discount') await cmdDiscounts(flags);
    else if (command === 'breaks' || command === 'break') await cmdBreaks(flags);
    else if (command === 'detail') await cmdDetail(flags);
    else if (command === 'accounts' || command === 'account') await cmdAccounts(flags);
    else
      cli.die(
        `unknown cost command: ${command}\n` +
          '  aws-ext cost summary | discounts | breaks | detail --service <name> | accounts',
        { prefix: 'aws-ext' },
      );
  } else if (group === 'sigv4') {
    if (command === 'verify' || command === 'selftest' || !command) await cmdSigv4Verify(flags);
    else cli.die(`unknown sigv4 command: ${command}\n  aws-ext sigv4 verify`, { prefix: 'aws-ext' });
  } else {
    cli.die(
      `unknown group: ${group}\n  aws-ext cost … | aws-ext sigv4 verify\n` +
        '  Plain API calls live in the sibling binary: aws sts | aws ce | aws configure',
      { prefix: 'aws-ext' },
    );
  }
} catch (err) {
  if (err?.name === 'NodeExitError') throw err; // MANDATORY re-throw
  cli.die(err.message, { prefix: 'aws-ext' });
}

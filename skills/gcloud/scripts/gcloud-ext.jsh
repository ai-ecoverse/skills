#!/usr/bin/env jsh
// gcloud-ext: what the real gcloud CLI cannot do. `billing cost` reports per-service
// or per-SKU cost and usage by replaying the Cloud Console's private billing-report
// API from a logged-in console.cloud.google.com tab (SAPISIDHASH-signed). It needs
// only project-level billing.resourceCosts.get. The API is undocumented: if it breaks,
// re-capture the BillingData request from Billing → Reports and update the constants.

const cli     = require('sliccy:cli');
const exec    = require('sliccy:exec');
const c       = require('sliccy:color');
const browser = require('sliccy:browser');

// ─── Reverse-engineered Console billing-report API (may rotate) ───────────────
const GQL_URL =
  'https://cloudconsole-pa.clients6.google.com/v3/entityServices/' +
  'BillingReportsEntityService/schemas/BILLING_REPORTS_GRAPHQL:batchGraphql' +
  '?key=AIzaSyCI-zsRP85UVOi0DjtiCwWBwQ1djDy741g&prettyPrint=false';
const GQL_SIGNATURE = '2/P3x4vaA9WY+xnwes1nLVFEjcmjlRDAC3DdoMSRWBi4w=';
const GQL_OPERATION = 'BillingData';
const COST_VIEW     = 'cloud_billing_data.public.costs.v2';

function str(v) { return typeof v === 'string' ? v : undefined; }

async function defaultProject() {
  const { stdout, exitCode } = await exec.spawn(['gcloud', 'config', 'get-value', 'project']);
  const p = exitCode === 0 ? stdout.trim() : '';
  return p && p !== '(unset)' ? p : undefined;
}

// YYYY-MM-DD helpers (UTC, no Date-math surprises).
function ymd(d) { return d.toISOString().slice(0, 10); }
function addDays(iso, n) {
  const d = new Date(iso + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return ymd(d);
}
function firstOfMonth(iso) { return iso.slice(0, 8) + '01'; }

/** Resolve the project's billing account via the public API (works with
 *  project-level access) through the real gcloud CLI. */
async function resolveBillingAccount(project) {
  const { stdout, exitCode } = await exec.spawn([
    'gcloud', 'billing', 'projects', 'describe', project, '--format=json',
  ]);
  if (exitCode !== 0) return undefined;
  try {
    const j = JSON.parse(stdout);
    return j.billingAccountName || undefined; // "billingAccounts/XXXX-…"
  } catch { return undefined; }
}

async function findConsoleTab() {
  const tab = await browser.findTab({ urlMatch: /console\.cloud\.google\.com/ });
  if (!tab) {
    cli.die(
      'No logged-in GCP console tab found.\n' +
      'Open https://console.cloud.google.com (signed in) and retry.',
      { prefix: 'gcloud-ext' },
    );
  }
  return tab;
}

// Column sets per grouping dimension.
function columnsFor(groupBy) {
  if (groupBy === 'sku') {
    return {
      dimension: 'SKU',
      columns:
        'sku_id AS skuId, sku_display_name AS name, service_display_name AS serviceName, ' +
        'usage_cost AS usageCostMicros, subtotal AS subtotalMicros, ' +
        'usage AS usageAmount, usage_with_unit AS usageWithUnit, price_unit AS priceUnit',
      hasUsage: true,
    };
  }
  return {
    dimension: 'SERVICE',
    columns:
      'service_id AS serviceId, service_display_name AS name, ' +
      'usage_cost AS usageCostMicros, subtotal AS subtotalMicros',
    hasUsage: false,
  };
}

async function cmdBillingCost(flags) {
  const project = str(flags.project) || (await defaultProject());
  if (!project) {
    cli.die('No project set. Pass --project <id> or run: gcloud config set project <id>',
      { prefix: 'gcloud-ext' });
  }

  const groupBy = (str(flags['group-by']) || 'service').toLowerCase();
  if (groupBy !== 'service' && groupBy !== 'sku') {
    cli.die('--group-by must be "service" or "sku".', { prefix: 'gcloud-ext' });
  }

  // Date range: default = start of current month → today.
  const today = ymd(new Date());
  const to    = str(flags.to)   || today;
  const from  = str(flags.from) || firstOfMonth(to);
  if (from > to) cli.die('--from must not be after --to.', { prefix: 'gcloud-ext' });
  // Previous comparison window of equal length, immediately preceding `from`.
  const spanDays = Math.round((new Date(to + 'T00:00:00Z') - new Date(from + 'T00:00:00Z')) / 86400000);
  const prevEnd   = addDays(from, -1);
  const prevStart = addDays(prevEnd, -spanDays);

  let billingAccount = str(flags['billing-account']);
  if (billingAccount && !billingAccount.startsWith('billingAccounts/')) {
    billingAccount = 'billingAccounts/' + billingAccount;
  }
  if (!billingAccount) {
    billingAccount = await resolveBillingAccount(project);
    if (!billingAccount) {
      cli.die(
        `Could not resolve the billing account for ${project}.\n` +
        'Pass it explicitly with --billing-account <ID>.',
        { prefix: 'gcloud-ext' },
      );
    }
  }

  const col = columnsFor(groupBy);
  const variables = {
    request: {
      view: COST_VIEW,
      clientQueryId: 'gcloud_ext_billing_cost',
      parents: [{ billingAccount, resource: `projects/${project}` }],
      columns: col.columns,
      groupBy: 'all',
      filter: '(usage_cost != 0 OR subtotal != 0)',
      substitutions: [
        { target: 'FILTERING_TIME_COLUMN', stringId: 'usage_date' },
        { target: 'GROUPING_TIME_COLUMN', stringId: 'usage_date' },
      ],
      parameters: [
        { name: 'CURRENT_START', stringValue: from },
        { name: 'CURRENT_END', stringValue: to },
        { name: 'DIMENSIONS', stringArrayValue: { stringElements: [col.dimension] } },
        { name: 'PREVIOUS_START', stringValue: prevStart },
        { name: 'PREVIOUS_END', stringValue: prevEnd },
        { name: 'PROJECT_NUMBERS_OR_IDS', stringArrayValue: { stringElements: [project] } },
        { name: 'COST_TYPES', stringArrayValue: { stringElements: ['USAGE'] } },
        { name: 'LIMIT_TO_TOP', int64Value: '0' },
        { name: 'CREDIT_TYPES', stringArrayValue: { stringElements: [] } },
        { name: 'EXCLUDE_NEGOTIATED_SAVINGS', boolValue: false },
      ],
      pageSize: 5000,
      skip: 0,
      orderBy: 'usageCostMicros DESC',
    },
  };
  const gqlBody = JSON.stringify({
    requestContext: { platformMetadata: { platformType: 'RIF' } },
    querySignature: GQL_SIGNATURE,
    operationName: GQL_OPERATION,
    variables,
  });

  const tab = await findConsoleTab();

  // Build the in-page function source with data injected (evalAsync runs it in
  // the console origin, so document.cookie has SAPISID and the request is
  // same-session; SAPISIDHASH is computed here, exactly as the console does).
  const evalSrc = `
    (async () => {
      const sapisid = (document.cookie.match(/SAPISID=([^;]+)/) || [])[1];
      if (!sapisid) return { error: 'No SAPISID cookie — is this tab logged into console.cloud.google.com?' };
      const au = (location.search.match(/authuser=(\\d+)/) || [])[1] || '0';
      const ts = Math.floor(Date.now() / 1000);
      const digest = await crypto.subtle.digest('SHA-1', new TextEncoder().encode(ts + ' ' + sapisid + ' https://console.cloud.google.com'));
      const hash = ts + '_' + Array.from(new Uint8Array(digest)).map(x => x.toString(16).padStart(2, '0')).join('');
      const res = await fetch(${JSON.stringify(GQL_URL)}, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json', 'Authorization': 'SAPISIDHASH ' + hash, 'X-Goog-AuthUser': au },
        body: ${JSON.stringify(gqlBody)},
      });
      const text = await res.text();
      return { status: res.status, text };
    })()
  `;

  let out;
  try {
    out = await browser.evalAsync(tab, evalSrc);
  } catch (e) {
    cli.die(`In-page billing request failed: ${e.message}`, { prefix: 'gcloud-ext' });
  }
  if (out && out.error) cli.die(out.error, { prefix: 'gcloud-ext' });
  if (!out || out.status !== 200) {
    cli.die(`Console billing API returned ${out ? out.status : 'no response'}.`, { prefix: 'gcloud-ext' });
  }

  let parsed;
  try { parsed = typeof out.text === 'string' ? JSON.parse(out.text) : out.text; }
  catch { cli.die('Could not parse billing API response.', { prefix: 'gcloud-ext' }); }

  const result = parsed?.[0]?.results?.[0];
  if (result?.errors?.length) {
    cli.die(`Billing API error: ${result.errors[0].message}`, { prefix: 'gcloud-ext' });
  }
  const bd = result?.data?.billingDataQuery?.queryBillingData?.billingData;
  if (!bd) cli.die('No billing data returned (check the date range and project).', { prefix: 'gcloud-ext' });

  const cols = (bd.columnInfo || []).map(x => x.column);
  const firstVal = v => { for (const k in v) if (v[k] !== null) return v[k]; return null; };
  const rows = (bd.rows || []).map(r => {
    const o = {};
    r.values.forEach((v, i) => { o[cols[i]] = firstVal(v); });
    return o;
  });

  const usd = micros => Number(micros || 0) / 1e6;

  if (flags.json) {
    cli.out({
      project, billingAccount, groupBy, from, to,
      rows: rows.map(r => ({
        name: r.name,
        serviceName: r.serviceName,
        skuId: r.skuId,
        serviceId: r.serviceId,
        usageCostUSD: usd(r.usageCostMicros),
        subtotalUSD: usd(r.subtotalMicros),
        usageAmount: r.usageAmount,
        usageWithUnit: r.usageWithUnit,
        priceUnit: r.priceUnit,
      })),
    });
    return;
  }

  console.log('');
  console.log(`  ${c.dim(project)}  ${c.dim(from + ' → ' + to)}  ${c.dim('grouped by ' + groupBy)}`);
  console.log('');
  let totalGross = 0, totalNet = 0;
  for (const r of rows) {
    totalGross += usd(r.usageCostMicros);
    totalNet   += usd(r.subtotalMicros);
    const gross = '$' + usd(r.usageCostMicros).toFixed(2);
    const net   = '$' + usd(r.subtotalMicros).toFixed(2);
    const svc   = col.hasUsage && r.serviceName ? c.dim(' [' + r.serviceName + ']') : '';
    const usage = col.hasUsage && (r.usageWithUnit || r.usageAmount)
      ? '  ' + c.cyan(r.usageWithUnit || String(r.usageAmount))
      : '';
    console.log(`  ${c.bold((r.name || '(unknown)').padEnd(42))} ${gross.padStart(12)} ${c.dim('net ' + net)}${svc}${usage}`);
  }
  console.log('');
  console.log(`  ${c.bold('TOTAL'.padEnd(42))} ${('$' + totalGross.toFixed(2)).padStart(12)} ${c.dim('net $' + totalNet.toFixed(2))}`);
}

// ─── args + main ─────────────────────────────────────────────────────────────

const HELP = `
gcloud-ext: what the real gcloud CLI cannot do.

USAGE
  gcloud-ext billing cost [--project P] [--group-by service|sku]
                          [--from YYYY-MM-DD] [--to YYYY-MM-DD]
                          [--billing-account ID] [--json]

  Per-service or per-SKU cost AND usage for a project over a date range,
  including usage counts (e.g. DNS query volume) when --group-by sku.

  Requires an open, logged-in console.cloud.google.com browser tab. It replays
  the Cloud Console's private billing-report API from that session (project-level
  billing.resourceCosts.get is enough — no billing-account IAM). Defaults to the
  current month if no dates are given, and to gcloud's configured project.

EXAMPLES
  gcloud-ext billing cost --project helix-225321
  gcloud-ext billing cost --project helix-225321 --group-by sku
  gcloud-ext billing cost --project helix-225321 --group-by sku --from 2026-07-01 --to 2026-07-26 --json
`.trim();

const parsed     = process.argv.parseFlags();
const subcommand = parsed.subcommand || '';
const positional = parsed.positional.slice(1);
const flags      = parsed.flags;

async function main() {
  if (flags.help || flags.h || !subcommand || subcommand === 'help') cli.help(HELP);
  try {
    if (subcommand === 'billing' && positional[0] === 'cost') return await cmdBillingCost(flags);
    cli.die(`unknown command: ${subcommand} ${positional[0] || ''}\nRun 'gcloud-ext --help' for usage.`,
      { prefix: 'gcloud-ext' });
  } catch (err) {
    if (err?.name === 'NodeExitError') throw err; // MANDATORY re-throw
    cli.die(err.message, { prefix: 'gcloud-ext' });
  }
}

await main();

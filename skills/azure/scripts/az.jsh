// az.jsh — an Azure-CLI-compatible subset of Azure Resource Manager (ARM),
// authenticated by piggybacking on an open, logged-in `portal.azure.com` tab.
//
// There is no `az` binary in SLICC and no service principal to log in with, so
// this skill borrows the credential the portal already holds: the Azure portal
// SPA is an MSAL client and keeps its access tokens in **sessionStorage**, one
// entry per audience. We read the entry whose `target` names the ARM audience
// (`management.core.windows.net`), then call `https://management.azure.com`
// directly with `Authorization: Bearer <secret>`. ARM accepts that
// cross-origin, so only the *harvest* needs the browser — every subsequent
// request is a plain realm `fetch`.
//
// Command names and flags deliberately mirror the real Azure CLI
// (`az account list`, `az account show`, `az rest --method --url`) so copied
// docs and muscle memory transfer. Anything the real CLI does NOT have —
// notably the Cost Management analysis — lives in the sibling binary `az-ext`,
// exactly as the fastly skill splits billing into `fastly-ext` and the gcloud
// skill splits cost reports into `gcloud-ext`.
//
// SECURITY: the harvested token is a bearer credential for the whole
// subscription set. It is stored in the skill config (mode 0600 where the VFS
// supports it) and is NEVER printed, logged, echoed by --json, or passed on a
// command line. Only its expiry, tenant and length are ever surfaced.

const cli = require('sliccy:cli');
const skill = require('sliccy:skill');
const browser = require('sliccy:browser');
const c = require('sliccy:color');

// ─── ARM constants ───────────────────────────────────────────────────────────

const ARM_BASE = 'https://management.azure.com';
// The portal holds several MSAL access tokens at once (Microsoft Graph, and
// opaque first-party resource ids like c44b4083-… / 7000789f-…). Selecting on
// this substring of `target` is what separates the ARM token from the rest;
// picking any other one yields a 401 from ARM.
const ARM_AUDIENCE_MATCH = 'management.core.windows.net';
const PORTAL_URL = 'https://portal.azure.com';
const PORTAL_URL_MATCH = /portal\.azure\.com/;
const SUBSCRIPTIONS_API_VERSION = '2022-12-01';
// Treat a token as unusable this many seconds before its stated expiry, so a
// long-running command cannot expire mid-flight.
const EXPIRY_SKEW_SECONDS = 120;

const NO_TAB_HELP =
  'No logged-in portal.azure.com tab found.\n' +
  '  1. Open ' +
  PORTAL_URL +
  ' and sign in (SSO/MFA as usual).\n' +
  '  2. Leave the tab open.\n' +
  '  3. Re-run: az login --from-tab\n' +
  'The tab is only needed to harvest the token; later calls go straight to ARM.';

const NO_TOKEN_HELP =
  'Not logged in to Azure (no ARM token stored).\n' +
  'Run: az login --from-tab   (needs an open, signed-in portal.azure.com tab)';

// ─── small helpers ───────────────────────────────────────────────────────────

function str(v) {
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}

function nowSeconds() {
  return Math.floor(Date.now() / 1000);
}

/** Human-readable "in 42m" / "expired 3m ago" for an epoch-seconds instant. */
function relativeExpiry(expiresOn) {
  if (!Number.isFinite(expiresOn)) return 'unknown';
  const delta = expiresOn - nowSeconds();
  const mins = Math.round(Math.abs(delta) / 60);
  const label = mins >= 60 ? `${Math.floor(mins / 60)}h${String(mins % 60).padStart(2, '0')}m` : `${mins}m`;
  return delta >= 0 ? `in ${label}` : `expired ${label} ago`;
}

// A real ARM access token is a fat JWT (measured: ~1.2–2.5 kB). Anything much
// shorter that still parses is almost certainly a truncated transfer, not a
// token — CDP eval results are size-capped, and a token cut in transit would
// otherwise surface as a baffling 401 several commands later.
const MIN_ARM_TOKEN_CHARS = 400;

/** Structural JWT predicate: three non-empty base64url segments. */
function looksLikeJwt(token) {
  if (typeof token !== 'string') return false;
  const parts = token.split('.');
  return parts.length === 3 && parts.every((p) => p.length > 0 && /^[A-Za-z0-9_-]+$/.test(p));
}

/** Decode a JWT payload without verifying it — we only want `exp`, `tid`, `aud`
 *  for reporting. Never throws; returns null on anything unexpected. */
function decodeJwtPayload(token) {
  try {
    const b64 = token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
    const pad = b64 + '='.repeat((4 - (b64.length % 4)) % 4);
    return JSON.parse(Buffer.from(pad, 'base64').toString('utf8'));
  } catch {
    return null;
  }
}

/**
 * Validate a freshly harvested token WITHOUT sending it anywhere. A structural
 * JWT check alone is not enough — truncation removes the tail, which leaves
 * three plausible-looking segments — so this also requires the payload to
 * decode as JSON, to carry an `aud`, and the whole token to be plausibly long.
 * Returns `{ ok, reason?, claims? }`.
 */
function inspectHarvestedToken(token) {
  if (typeof token !== 'string' || token.length === 0) {
    return { ok: false, reason: 'no token string was returned by the page' };
  }
  const parts = token.split('.');
  if (parts.length !== 3) {
    return { ok: false, reason: `expected 3 JWT segments, got ${parts.length}` };
  }
  if (!looksLikeJwt(token)) {
    return { ok: false, reason: 'segments are not all non-empty base64url' };
  }
  const claims = decodeJwtPayload(token);
  if (!claims) {
    return { ok: false, reason: 'the payload segment does not decode as JSON — cut mid-payload' };
  }
  if (!claims.aud) {
    return { ok: false, reason: 'the payload carries no "aud" claim' };
  }
  if (token.length < MIN_ARM_TOKEN_CHARS) {
    return {
      ok: false,
      reason: `only ${token.length} chars — a real ARM token is well over ${MIN_ARM_TOKEN_CHARS}`,
    };
  }
  return { ok: true, claims: claims };
}

// ─── config (token at rest) ──────────────────────────────────────────────────

async function loadConfig() {
  return (await skill.config()) || {};
}

/**
 * The stored ARM token, or null when absent or (nearly) expired.
 * Deliberately returns null rather than an expired token so callers uniformly
 * fall through to a re-harvest instead of burning a request on a certain 401.
 */
async function storedToken(cfg) {
  const conf = cfg || (await loadConfig());
  const token = str(conf.armToken);
  if (!token) return null;
  const expiresOn = Number(conf.armTokenExpiresOn);
  if (Number.isFinite(expiresOn) && expiresOn - EXPIRY_SKEW_SECONDS <= nowSeconds()) return null;
  return token;
}

// ─── token harvest from the portal tab ───────────────────────────────────────

// Runs inside the portal origin. Walks sessionStorage for the MSAL AccessToken
// entry whose audience is ARM. Keys look like
// `msal.3|<clientId>.<tenantId>|login.windows.net|…` but the key shape is not
// load-bearing — only the parsed value's fields are.
const HARVEST_SOURCE = `
  (async () => {
    try {
      const candidates = [];
      for (let i = 0; i < sessionStorage.length; i++) {
        const key = sessionStorage.key(i);
        const raw = sessionStorage.getItem(key) || '';
        if (!raw.startsWith('{')) continue;
        let o;
        try { o = JSON.parse(raw); } catch (e) { continue; }
        if (!o || o.credentialType !== 'AccessToken' || !o.secret) continue;
        candidates.push({
          secret: o.secret,
          target: o.target || '',
          realm: o.realm || '',
          clientId: o.clientId || '',
          expiresOn: Number(o.expiresOn) || 0,
        });
      }
      const arm = candidates.filter((x) => x.target.indexOf(${JSON.stringify(ARM_AUDIENCE_MATCH)}) !== -1);
      // Prefer the longest-lived ARM token when the SPA holds more than one.
      arm.sort((a, b) => b.expiresOn - a.expiresOn);
      const pick = arm[0] || null;
      return {
        found: !!pick,
        pageNow: Math.floor(Date.now() / 1000),
        armTokenCount: arm.length,
        accessTokenCount: candidates.length,
        audiences: candidates.map((x) => x.target.slice(0, 60)),
        token: pick ? pick.secret : null,
        tokenLength: pick ? pick.secret.length : 0,
        tenantId: pick ? pick.realm : null,
        clientId: pick ? pick.clientId : null,
        expiresOn: pick ? pick.expiresOn : 0,
      };
    } catch (e) {
      return { error: String((e && e.message) || e) };
    }
  })()
`;

async function findPortalTab(tabOverride) {
  if (tabOverride) return tabOverride;
  const tab = await browser.findTab({ urlMatch: PORTAL_URL_MATCH });
  if (!tab) cli.die(NO_TAB_HELP, { prefix: 'az' });
  return tab;
}

/** One harvest attempt. Returns `{ ok: true, ... }` or `{ ok: false, fatal, message }`
 *  so the polling wrapper can distinguish "retry might help" from "give up". */
async function tryHarvest(tab) {
  let res;
  try {
    res = await browser.evalAsync(tab, HARVEST_SOURCE);
  } catch (err) {
    return {
      ok: false,
      fatal: true,
      message:
        `Could not read sessionStorage from the portal tab: ${err.message}\n` +
        `The tab may have been closed or navigated. Reopen ${PORTAL_URL} and retry.`,
    };
  }
  if (res && res.error) return { ok: false, fatal: true, message: `Portal tab error: ${res.error}` };
  if (!res || !res.found) {
    const seen = res && Number(res.accessTokenCount) ? Number(res.accessTokenCount) : 0;
    return {
      ok: false,
      fatal: false,
      message:
        `The portal tab holds ${seen} MSAL access token(s) but none for ARM ` +
        `(no 'target' containing ${ARM_AUDIENCE_MATCH}).\n` +
        'Open a resource blade in the portal (Subscriptions, or Cost Management → Cost\n' +
        'analysis) so the SPA requests an ARM token, then re-run: az login --from-tab',
    };
  }
  const inspection = inspectHarvestedToken(res.token);
  if (!inspection.ok) {
    return {
      ok: false,
      fatal: false,
      message:
        `The harvested ARM token failed local validation: ${inspection.reason}.\n` +
        `(Reported length: ${res.tokenLength} chars.)\n` +
        'CDP eval results are size-capped, so this usually means the token was truncated\n' +
        'in transit rather than that the portal is broken. It was NOT stored.',
    };
  }

  const claims = inspection.claims || {};
  const expiresOn = Number(res.expiresOn) || Number(claims.exp) || 0;
  // MEASURED: a portal tab that has been idle can hold an ALREADY-EXPIRED ARM
  // token — MSAL refreshes lazily, on demand, not on a timer. Storing it would
  // guarantee a 401 later and report the useless "nothing was stored" instead of
  // the real cause, so reject it here with the actual remedy.
  const remaining = expiresOn - nowSeconds();
  if (expiresOn > 0 && remaining < 60) {
    return {
      ok: false,
      fatal: false,
      expired: true,
      message:
        `The portal tab's ARM token ${relativeExpiry(expiresOn)} (${Math.abs(remaining)}s), so it was\n` +
        'not stored. MSAL refreshes tokens lazily — an idle portal tab keeps a stale one.\n' +
        'Interact with the tab (click Subscriptions, or Cost Management → Cost analysis, or\n' +
        'just reload it) so a fresh ARM token is minted, then re-run:\n' +
        '  az login --from-tab            # or: az login --from-tab --wait 60',
    };
  }
  return { ok: true, res: res, claims: claims, expiresOn: expiresOn };
}

/**
 * Harvest, sanity-check and store the ARM token. Returns a summary that is safe
 * to print: it contains no secret material.
 *
 * `waitSeconds > 0` polls the tab, which covers the two transient cases: the
 * portal is still completing sign-in, and MSAL is about to refresh an expired
 * token. Each poll is a SEPARATE evalAsync — never a retry loop inside one
 * in-page script, which would hit the ~30 s CDP evaluate timeout.
 */
async function harvestArmToken(tabOverride, waitSeconds) {
  const tab = await findPortalTab(tabOverride);
  const budget = Math.max(0, Number(waitSeconds) || 0);
  const deadline = nowSeconds() + budget;
  let attempt = 0;
  let last = null;

  for (;;) {
    attempt++;
    last = await tryHarvest(tab);
    if (last.ok) break;
    if (last.fatal || nowSeconds() >= deadline) {
      cli.die(last.message, { prefix: 'az' });
    }
    if (attempt === 1) {
      cli.warn(
        `no usable ARM token yet — polling the portal tab for up to ${budget}s. ` +
          'Clicking around the portal speeds this up.',
        { prefix: 'az' }
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 3000));
  }

  const res = last.res;
  const claims = last.claims;
  const expiresOn = last.expiresOn;
  await skill.config({
    armToken: res.token,
    armTokenExpiresOn: expiresOn,
    armTenantId: res.tenantId || claims.tid || null,
    armTokenAudience: str(claims.aud) || ARM_AUDIENCE_MATCH,
    armTokenHarvestedAt: nowSeconds(),
  });

  return {
    tenantId: res.tenantId || claims.tid || null,
    audience: str(claims.aud) || null,
    upn: str(claims.upn) || str(claims.preferred_username) || str(claims.unique_name) || null,
    expiresOn,
    expiresIn: relativeExpiry(expiresOn),
    tokenLength: res.tokenLength,
    otherAudiencesInTab: Math.max(0, (res.accessTokenCount || 1) - 1),
  };
}

// ─── ARM transport ───────────────────────────────────────────────────────────

/**
 * One authenticated ARM request. Returns `{ status, headers, body }` — it never
 * throws on an HTTP error status, so callers decide what a 4xx means (az-ext,
 * for example, must distinguish a 429 from a 400).
 *
 * On 401 it re-harvests the token from the portal tab exactly once, because the
 * portal's ARM tokens are short-lived and a stale one is the single most likely
 * cause of a 401 here.
 */
async function armRequest(method, pathOrUrl, body, opts) {
  const options = opts || {};
  let token = await storedToken();
  if (!token) {
    if (options.noHarvest) cli.die(NO_TOKEN_HELP, { prefix: 'az' });
    await harvestArmToken(options.tab, options.waitSeconds);
    token = await storedToken();
    if (!token) {
      cli.die(
        'A token was harvested but is already inside the ' +
          EXPIRY_SKEW_SECONDS +
          's expiry guard, so it was not used.\n' +
          'Interact with or reload the portal tab so MSAL mints a fresh ARM token, then:\n' +
          '  az login --from-tab --wait 60',
        { prefix: 'az' }
      );
    }
  }

  const url = /^https?:\/\//.test(pathOrUrl) ? pathOrUrl : ARM_BASE + pathOrUrl;
  let attempted401Refresh = false;

  for (;;) {
    const init = {
      method: method,
      headers: {
        Authorization: 'Bearer ' + token,
        Accept: 'application/json',
      },
    };
    if (body !== undefined && body !== null) {
      init.headers['Content-Type'] = 'application/json';
      init.body = typeof body === 'string' ? body : JSON.stringify(body);
    }

    let resp;
    try {
      resp = await fetch(url, init);
    } catch (err) {
      cli.die(`ARM request failed: ${err.message}`, { prefix: 'az' });
    }

    const text = await resp.text();
    let parsed = null;
    if (text) {
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = { raw: text.slice(0, 2000) };
      }
    }

    if (resp.status === 401 && !attempted401Refresh && !options.noHarvest) {
      attempted401Refresh = true;
      await harvestArmToken(options.tab);
      const fresh = await storedToken();
      if (fresh) {
        token = fresh;
        continue;
      }
    }

    const headers = {};
    if (resp.headers && typeof resp.headers.forEach === 'function') {
      resp.headers.forEach((v, k) => {
        headers[String(k).toLowerCase()] = v;
      });
    }
    return { status: resp.status, ok: resp.ok, headers: headers, body: parsed };
  }
}

/** Extract ARM's `{ error: { code, message } }` into one printable line. */
function armErrorMessage(res) {
  const e = res && res.body && res.body.error;
  if (e && (e.message || e.code)) return `${e.code || res.status}: ${e.message || ''}`.trim();
  if (res && res.body && res.body.raw) return String(res.body.raw).slice(0, 400);
  return `HTTP ${res ? res.status : '?'}`;
}

// ─── subscriptions ───────────────────────────────────────────────────────────

async function fetchSubscriptions(opts) {
  const res = await armRequest('GET', `/subscriptions?api-version=${SUBSCRIPTIONS_API_VERSION}`, null, opts);
  if (!res.ok) {
    cli.die(`Could not list subscriptions — ${armErrorMessage(res)}`, { prefix: 'az' });
  }
  const value = (res.body && res.body.value) || [];
  return value.map((s) => ({
    id: s.subscriptionId,
    name: s.displayName,
    state: s.state,
    tenantId: s.tenantId,
    authorizationSource: s.authorizationSource,
  }));
}

/** Cache the subscription list in config: `az-ext` resolves names against it,
 *  and /subscriptions is not part of the throttled Cost Management surface but
 *  is still a round trip we do not need to repeat. */
async function refreshSubscriptionCache(opts) {
  const subs = await fetchSubscriptions(opts);
  await skill.config({ subscriptions: subs, subscriptionsCachedAt: nowSeconds() });
  return subs;
}

/** Resolve `<id|name>` (case-insensitive name, exact or unique prefix of a
 *  GUID) to a subscription record. */
function resolveSubscription(subs, wanted) {
  const needle = String(wanted).trim();
  const lower = needle.toLowerCase();
  const byId = subs.find((s) => String(s.id).toLowerCase() === lower);
  if (byId) return byId;
  const byName = subs.filter((s) => String(s.name).toLowerCase() === lower);
  if (byName.length === 1) return byName[0];
  if (byName.length > 1) return null;
  const partial = subs.filter(
    (s) => String(s.name).toLowerCase().includes(lower) || String(s.id).toLowerCase().startsWith(lower)
  );
  return partial.length === 1 ? partial[0] : null;
}

// ─── commands ────────────────────────────────────────────────────────────────

async function cmdLogin(flags) {
  if (flags['service-principal'] || flags.username || flags.password) {
    cli.die(
      'Service-principal login is not supported — this skill has no client secret.\n' +
        'It borrows the ARM token from a signed-in portal.azure.com tab instead:\n' +
        '  az login --from-tab',
      { prefix: 'az' }
    );
  }

  const summary = await harvestArmToken(str(flags.tab), Number(flags.wait) || 0);
  const subs = await refreshSubscriptionCache({ noHarvest: true });

  if (flags.json) {
    cli.out({ ...summary, subscriptions: subs });
    return;
  }

  console.log('');
  console.log(`  ${c.green('✓')} ARM token harvested from the portal tab (never printed).`);
  if (summary.upn) console.log(`  ${c.dim('account  ')} ${summary.upn}`);
  console.log(`  ${c.dim('tenant   ')} ${summary.tenantId || '(unknown)'}`);
  console.log(`  ${c.dim('audience ')} ${summary.audience || ARM_AUDIENCE_MATCH}`);
  console.log(`  ${c.dim('expires  ')} ${summary.expiresIn} ${c.dim(`(${summary.tokenLength} chars)`)}`);
  if (summary.otherAudiencesInTab > 0) {
    console.log(
      `  ${c.dim('ignored  ')} ${summary.otherAudiencesInTab} non-ARM token(s) in the same tab ` +
        c.dim('(Graph et al.)')
    );
  }
  console.log('');
  console.log(`  ${c.bold(String(subs.length))} subscription(s) visible. Next: ${c.cyan('az account list')}`);
  console.log(
    `  ${c.dim('Portal tokens are short-lived; re-run `az login --from-tab` when a call 401s.')}`
  );
  console.log('');
}

async function cmdAccountList(flags) {
  const cfg = await loadConfig();
  const subs = flags['no-refresh'] && Array.isArray(cfg.subscriptions)
    ? cfg.subscriptions
    : await refreshSubscriptionCache({});
  const current = str(cfg.subscription);

  if (flags.json) {
    cli.out(subs.map((s) => ({ ...s, isDefault: s.id === current })));
    return;
  }
  if (subs.length === 0) {
    console.log('No subscriptions visible to this session.');
    return;
  }
  console.log('');
  for (const s of subs) {
    const mark = s.id === current ? c.green(' *') : '  ';
    const state = s.state === 'Enabled' ? c.green(s.state) : c.yellow(s.state);
    console.log(`${mark} ${c.bold(String(s.name).padEnd(34))} ${c.dim(s.id)}  ${state}`);
  }
  console.log('');
  console.log(`  ${c.dim('* = default (az account set --subscription <id|name>)')}`);
  console.log('');
}

async function cmdAccountShow(flags) {
  const cfg = await loadConfig();
  const wanted = str(flags.subscription) || str(cfg.subscription);
  const subs = Array.isArray(cfg.subscriptions) && cfg.subscriptions.length
    ? cfg.subscriptions
    : await refreshSubscriptionCache({});

  let sub = null;
  if (wanted) sub = resolveSubscription(subs, wanted);
  else if (subs.length === 1) sub = subs[0];

  if (!sub) {
    cli.die(
      wanted
        ? `No unique subscription matches "${wanted}". Run: az account list`
        : 'No default subscription set. Run: az account set --subscription <id|name>',
      { prefix: 'az' }
    );
  }

  const token = await storedToken(cfg);
  const out = {
    id: sub.id,
    name: sub.name,
    state: sub.state,
    tenantId: sub.tenantId || cfg.armTenantId || null,
    isDefault: sub.id === str(cfg.subscription),
    tokenExpiresOn: Number(cfg.armTokenExpiresOn) || null,
    tokenValid: Boolean(token),
  };
  if (flags.json) {
    cli.out(out);
    return;
  }
  console.log('');
  console.log(`  ${c.bold(out.name)}`);
  console.log(`  ${c.dim('id      ')} ${out.id}`);
  console.log(`  ${c.dim('state   ')} ${out.state}`);
  console.log(`  ${c.dim('tenant  ')} ${out.tenantId || '(unknown)'}`);
  console.log(
    `  ${c.dim('token   ')} ${out.tokenValid ? c.green('valid') : c.red('expired/absent')} ` +
      c.dim(`(${relativeExpiry(Number(cfg.armTokenExpiresOn))})`)
  );
  console.log('');
}

async function cmdAccountSet(flags) {
  const wanted = str(flags.subscription);
  if (!wanted) cli.die('--subscription <id|name> is required.', { prefix: 'az' });
  const cfg = await loadConfig();
  const subs = Array.isArray(cfg.subscriptions) && cfg.subscriptions.length
    ? cfg.subscriptions
    : await refreshSubscriptionCache({});
  const sub = resolveSubscription(subs, wanted);
  if (!sub) {
    cli.die(
      `No unique subscription matches "${wanted}".\nKnown: ` +
        (subs.map((s) => s.name).join(', ') || '(none — run az login --from-tab)'),
      { prefix: 'az' }
    );
  }
  await skill.config({ subscription: sub.id, subscriptionName: sub.name });
  console.log(`${c.green('✓')} default subscription: ${c.bold(sub.name)} ${c.dim(sub.id)}`);
}

async function cmdLogout() {
  await skill.config({
    armToken: null,
    armTokenExpiresOn: null,
    armTenantId: null,
    armTokenAudience: null,
    armTokenHarvestedAt: null,
  });
  console.log(
    `${c.green('✓')} local ARM token cleared. ` +
      c.dim('The portal tab still holds its own session — sign out there to revoke it.')
  );
}

async function cmdRest(flags) {
  const target = str(flags.url) || str(flags.uri);
  if (!target) cli.die('--url <path|full-url> is required (alias: --uri).', { prefix: 'az' });
  const method = (str(flags.method) || 'GET').toUpperCase();

  let path = target;
  const apiVersion = str(flags['api-version']);
  if (apiVersion && !/[?&]api-version=/.test(path)) {
    path += (path.includes('?') ? '&' : '?') + 'api-version=' + encodeURIComponent(apiVersion);
  }

  let body;
  const bodyFlag = str(flags.body);
  if (bodyFlag) {
    if (bodyFlag.startsWith('@')) {
      const fs = require('fs');
      body = await fs.readFile(bodyFlag.slice(1), 'utf8');
    } else {
      body = bodyFlag;
    }
  }

  const res = await armRequest(method, path, body, {});
  // Always print the payload: an ARM error body is the most useful thing we
  // have, and callers (including humans debugging a 429) need to see it.
  cli.out(res.body === null ? { status: res.status } : res.body);
  if (!res.ok) {
    cli.warn(`ARM returned HTTP ${res.status} — ${armErrorMessage(res)}`, { prefix: 'az' });
    process.exit(1);
  }
}

async function cmdVersion() {
  const cfg = await loadConfig();
  const token = await storedToken(cfg);
  console.log(`az (SLICC azure skill)  ARM ${ARM_BASE}`);
  console.log(`  subscriptions api-version ${SUBSCRIPTIONS_API_VERSION}`);
  console.log(`  auth: portal-tab MSAL harvest — token ${token ? 'valid' : 'absent/expired'}`);
  console.log('  cost analysis lives in the sibling binary: az-ext cost --help');
}

// ─── help + routing ──────────────────────────────────────────────────────────

const HELP = `
az — Azure Resource Manager from the CLI, authenticated by a logged-in
     portal.azure.com tab. Cost analysis lives in \`az-ext cost\`.

USAGE
  az login --from-tab [--wait S] [--tab <targetId>] [--json]
      Harvest the ARM access token from an open, signed-in portal.azure.com tab
      (MSAL sessionStorage, audience management.core.windows.net), validate it
      against /subscriptions, and store it. The token is never printed.
      An idle portal tab can hold an ALREADY-EXPIRED token (MSAL refreshes
      lazily) — --wait S polls the tab for up to S seconds while you click around
      it, instead of failing immediately.

  az account list [--json] [--no-refresh]
      Subscriptions visible to the session. '*' marks the default.

  az account show [--subscription <id|name>] [--json]
      Current (or named) subscription, tenant, and token validity.

  az account set --subscription <id|name>
      Set the default subscription used by \`az\` and \`az-ext\`.

  az logout
      Forget the local token. Does not sign the portal tab out.

  az rest --method GET|POST|PUT|PATCH|DELETE --url <path|full-url>
          [--api-version V] [--body '<json>'|@file]
      Authenticated raw ARM call — the escape hatch. A leading '/' is resolved
      against ${ARM_BASE}.

  az version

EXAMPLES
  az login --from-tab
  az login --from-tab --wait 60      # poll while the portal refreshes its token
  az account list
  az account set --subscription "DMa/Helix PRD"
  az rest --url /subscriptions --api-version 2022-12-01
  az rest --method POST --api-version 2023-11-01 \\
          --url /subscriptions/<subId>/providers/Microsoft.CostManagement/query \\
          --body '{"type":"ActualCost","timeframe":"MonthToDate",
                   "dataset":{"granularity":"None",
                   "aggregation":{"totalCost":{"name":"Cost","function":"Sum"}}}}'

NOTES
  Cost Management is aggressively throttled (roughly one historical query per
  five minutes, HTTP 429, no Retry-After header). Prefer \`az-ext cost\`, which
  caches to disk and backs off, over hand-rolled \`az rest\` cost queries.

  Use long flags with values (--subscription X): this runtime hands single-dash
  flags over as booleans, so short aliases are not offered.
`.trim();

const parsed = process.argv.parseFlags();
const positional = parsed.positional;
const flags = parsed.flags;

async function route() {
  const [group, sub] = positional;

  if (group === 'login') return await cmdLogin(flags);
  if (group === 'logout') return await cmdLogout();
  if (group === 'version') return await cmdVersion();
  if (group === 'rest') return await cmdRest(flags);
  if (group === 'account') {
    if (!sub || sub === 'list') return await cmdAccountList(flags);
    if (sub === 'show') return await cmdAccountShow(flags);
    if (sub === 'set') return await cmdAccountSet(flags);
    cli.die(`unknown account subcommand: ${sub}\nTry: list | show | set`, { prefix: 'az' });
  }
  if (group === 'cost' || group === 'costmanagement') {
    cli.die(
      'Cost analysis lives in the sibling binary (the real Azure CLI has no such\n' +
        'command group, so `az` stays command-compatible). Try:\n' +
        '  az-ext cost summary --subscription <id|name>\n' +
        '  az-ext cost marketplace --subscription <id|name>\n' +
        '  az-ext cost --help',
      { prefix: 'az' }
    );
  }
  cli.die(`unknown command: ${positional.join(' ')}\nRun 'az --help' for usage.`, { prefix: 'az' });
}

async function main() {
  if (flags.help || flags.h || positional.length === 0 || positional[0] === 'help') cli.help(HELP);
  try {
    return await route();
  } catch (err) {
    if (err && err.name === 'NodeExitError') throw err; // MANDATORY re-throw
    cli.die(err && err.message ? err.message : String(err), { prefix: 'az' });
  }
}

// Test seam: the unit tests evaluate this file to exercise the pure helpers
// (resolveSubscription, looksLikeJwt, decodeJwtPayload, armErrorMessage)
// without dispatching a command. Normal runs never set AZ_NO_MAIN.
module.exports = {
  looksLikeJwt,
  inspectHarvestedToken,
  MIN_ARM_TOKEN_CHARS,
  decodeJwtPayload,
  relativeExpiry,
  resolveSubscription,
  armErrorMessage,
  ARM_BASE,
  ARM_AUDIENCE_MATCH,
  HARVEST_SOURCE,
};

if (process.env.AZ_NO_MAIN !== '1') {
  // MUST be awaited: the runtime exits before an un-awaited promise settles,
  // which silently yields rc=0 and no output.
  await main();
}

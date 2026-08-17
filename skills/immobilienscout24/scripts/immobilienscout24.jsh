// immobilienscout24.jsh — ImmoScout24 browser-session client
//
// AUTH: cookie session in an open immobilienscout24.de tab via sliccy:browser.
// Multi-subdomain APIs (sso., api.header., my-property., www.) go through
// browser.fetch so first-party cookies travel automatically. No token is
// stored or printed.
//
// CSRF / GAC (verified live 2026-08-09 against HAR rec-1786282613280-yexubu):
//  • ScoutManager POSTs need header `x-xsrf-token` = cookie `XSRF-TOKEN`
//    (path-scoped to /scoutmanager/).
//  • Nachrichten-Manager POSTs need `x-xsrf-communication-mgr-token` and
//    `x-xsrf-contact-prospects-token` — these are returned as **response
//    headers** on GETs like /nachrichten-manager/api/feature-switches and
//    /contact-prospects/api/shared/feature-switches (not readable cookies).
//  • Geoautocomplete needs static header `X-IS24-GAC`.
//  • Search: POST /Suche/controller/oneStepSearch (form) → redirectUrl; the
//    result-list XHR is WAF-gated from headless fetch, so we surface the
//    redirect and a shortlist from the HTML page when possible.
//
// Endpoints reverse-engineered from /recordings/rec-1786282613280-yexubu/.

const browser = require('sliccy:browser');
const cli = require('sliccy:cli');
const color = require('sliccy:color');
const fmt = require('sliccy:fmt');

const WWW = 'https://www.immobilienscout24.de';
const SSO = 'https://sso.immobilienscout24.de';
const HEADER_API = 'https://api.header.immobilienscout24.de';
const MY_PROPERTY = 'https://my-property.immobilienscout24.de';
// Rent-profile / Bewerbermappe preview (cross-subdomain; credentialed XHR).
const RENT_PROFILE_API = 'https://api.rentprofile.immobilienscout24.de/meinkonto/dokumente/api';

// Public geo client key observed on every geoautocomplete call in the HAR
// (constant across the session; not a user secret).
const IS24_GAC = '49f5bf376feed3a0f0a52abb46c0dc90';

const HELP = `
immobilienscout24 — ImmoScout24 client (browser session)

USAGE
  immobilienscout24 me
  immobilienscout24 dashboard
  immobilienscout24 listings [--limit N] [--q TEXT] [--archived]
  immobilienscout24 exposes [--limit N]
  immobilienscout24 conversations <listingId> [--limit N] [--tag inbox]
  immobilienscout24 messages <listingId> <conversationId>
  immobilienscout24 applicant <ssoId|base64>   Bewerbermappe / rent-profile preview
  immobilienscout24 send <listingId> <conversationId> "text" --confirm
  immobilienscout24 send <listingId> <conversationId> --file <path> --confirm
  immobilienscout24 search <location> [flags]
  immobilienscout24 geo <query>

SEARCH FLAGS
  --type rent|buy|house-rent|house-buy|short-term   (default: rent)
  --page N            page number (default 1)
  --pagesize N        results per page (default 20, max 50)
  --price-max N       max price
  --rooms-min N       minimum rooms
  --area-min N        minimum living space (m²)

FLAGS
  --json              raw JSON
  --limit N           page size for list commands
  --q TEXT            ScoutManager free-text filter
  --archived          archived listings only
  --tag TAG           conversation tag (default inbox)

SEND FLAGS (write path — guarded)
  --confirm           REQUIRED to actually POST the message. Without it,
                      send prints the exact request and exits without
                      touching the network.
  --file <path>       read the message body from a file (use this for
                      multi-line German text; stdin is not readable here)
  --tags a,b          tags array to send with the message (default: none)

REQUIRES
  immobilienscout24.de open and logged in in your browser
`.trim();

const SEARCH_TYPES = {
  rent: 'apartmentrent',
  apartmentrent: 'apartmentrent',
  buy: 'apartmentbuy',
  apartmentbuy: 'apartmentbuy',
  'house-rent': 'houserent',
  houserent: 'houserent',
  'house-buy': 'housebuy',
  housebuy: 'housebuy',
  'short-term': 'shorttermaccommodationrent',
  shortterm: 'shorttermaccommodationrent',
  shorttermaccommodationrent: 'shorttermaccommodationrent',
};

const parsed = process.argv.parseFlags();
const subcommand = parsed.subcommand || parsed.positional[0] || '';
const positional = parsed.subcommand
  ? parsed.positional.slice(1)
  : parsed.positional.slice(1);
const flags = parsed.flags;

// ── session ────────────────────────────────────────────────────────────────

let _tab = null;
// Response-header CSRF tokens (nachrichten / contact-prospects).
const _hdrTokens = {
  communicationMgr: null,
  contactProspects: null,
};
let _scoutXsrf = null;
let _bootstrapped = { nachrichten: false, scout: false };

async function getTab() {
  if (_tab) return _tab;
  _tab = await browser.findTab({ urlMatch: /immobilienscout24\.de/i });
  if (!_tab) {
    cli.die(
      'open https://www.immobilienscout24.de in your browser and log in first',
      { prefix: 'immobilienscout24' },
    );
  }
  return _tab;
}

async function getScoutTab() {
  return (await browser.findTab({ urlMatch: /immobilienscout24\.de\/scoutmanager/i })) || null;
}

async function getNachrichtenTab() {
  return (
    (await browser.findTab({
      urlMatch: /immobilienscout24\.de\/(nachrichten-manager|meinkonto)/i,
    })) || null
  );
}

function isHtmlBody(body) {
  if (typeof body !== 'string') return false;
  const s = body.slice(0, 200).trim().toLowerCase();
  return s.startsWith('<!doctype') || s.startsWith('<html') || s.includes('<html');
}

function lookLikeLogin(res) {
  // 403 on missing CSRF is NOT a login wall — those bodies say "Forbidden".
  if (res.status === 401) return true;
  const url = String(res.url || '');
  if (/\/sso\/login|\/meinkonto\/login|\/login/i.test(url)) return true;
  if (
    typeof res.body === 'string' &&
    /anmelden|log\s*in|login-form/i.test(res.body.slice(0, 2000)) &&
    isHtmlBody(res.body)
  ) {
    return true;
  }
  return false;
}

function headerGet(headers, name) {
  if (!headers) return null;
  const want = name.toLowerCase();
  if (typeof headers.get === 'function') return headers.get(name) || headers.get(want);
  if (Array.isArray(headers)) {
    const h = headers.find((x) => String(x.name || '').toLowerCase() === want);
    return h ? h.value : null;
  }
  if (typeof headers === 'object') {
    for (const [k, v] of Object.entries(headers)) {
      if (k.toLowerCase() === want) return v;
    }
  }
  return null;
}

function harvestTokens(res) {
  const comm = headerGet(res.headers, 'x-xsrf-communication-mgr-token');
  const contact = headerGet(res.headers, 'x-xsrf-contact-prospects-token');
  if (comm) _hdrTokens.communicationMgr = comm;
  if (contact) _hdrTokens.contactProspects = contact;
}

async function readDocumentCookie(tab, name) {
  // Non-HttpOnly cookies only. ScoutManager XSRF-TOKEN is path=/scoutmanager/ and
  // is visible from scoutmanager pages via document.cookie.
  try {
    const expr = `(function(){var m=document.cookie.match(/(?:^|; )${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}=([^;]*)/);return m?decodeURIComponent(m[1]):null;})()`;
    const v = await browser.eval(tab, expr);
    return v || null;
  } catch {
    return null;
  }
}

async function ensureScoutXsrf(tab) {
  if (_scoutXsrf) return _scoutXsrf;
  const scoutTab = (await getScoutTab()) || tab;
  let token = await readDocumentCookie(scoutTab, 'XSRF-TOKEN');
  if (!token) {
    try {
      const all = await browser.eval(scoutTab, 'document.cookie');
      const m = String(all || '').match(/(?:^|; )XSRF-TOKEN=([^;]*)/);
      if (m) token = decodeURIComponent(m[1]);
    } catch {
      /* ignore */
    }
  }
  if (!token) {
    cli.die(
      'missing ScoutManager XSRF-TOKEN — open https://www.immobilienscout24.de/scoutmanager/angebotsliste/app/overview.html once, then retry',
      { prefix: 'immobilienscout24' },
    );
  }
  _scoutXsrf = token;
  return token;
}

async function ensureNachrichtenTokens(tab) {
  if (_bootstrapped.nachrichten && _hdrTokens.communicationMgr) return;
  const nTab = (await getNachrichtenTab()) || tab;
  // Feature-switch GETs mint the CSRF headers used by subsequent POSTs.
  try {
    const r1 = await browser.fetch(nTab, `${WWW}/nachrichten-manager/api/feature-switches`, {
      headers: { Accept: 'application/json' },
    });
    harvestTokens(r1);
  } catch {
    /* ignore */
  }
  try {
    const r2 = await browser.fetch(nTab, `${WWW}/contact-prospects/api/shared/feature-switches`, {
      headers: { Accept: 'application/json' },
    });
    harvestTokens(r2);
  } catch {
    /* ignore */
  }
  _bootstrapped.nachrichten = true;
  if (!_hdrTokens.communicationMgr) {
    cli.die(
      'could not mint Nachrichten CSRF tokens — open the Nachrichten-Manager once while logged in, then retry',
      { prefix: 'immobilienscout24' },
    );
  }
}

function classifyUrl(url) {
  const u = String(url);
  if (/\/scoutmanager\//i.test(u)) return 'scout';
  if (/\/nachrichten-manager\//i.test(u) || /\/contact-prospects\//i.test(u)) return 'nachrichten';
  if (/\/geoautocomplete\//i.test(u)) return 'geo';
  return 'other';
}

async function pickTab(tab, kind) {
  // Prefer a tab whose document origin/path matches the API surface so
  // path-scoped cookies and page CSRF state line up with the SPA.
  if (kind === 'scout') return (await getScoutTab()) || tab;
  if (kind === 'nachrichten') return (await getNachrichtenTab()) || tab;
  // Cross-subdomain identity calls are flaky from the nachrichten SPA bundle;
  // prefer scoutmanager or a plain www tab when available.
  if (kind === 'other') {
    return (
      (await browser.findTab({ urlMatch: /immobilienscout24\.de\/scoutmanager/i })) ||
      (await browser.findTab({ urlMatch: /immobilienscout24\.de\/(?!nachrichten-manager)/i })) ||
      tab
    );
  }
  return tab;
}

async function apiFetch(tab, url, opts = {}) {
  const kind = classifyUrl(url);
  const useTab = await pickTab(tab, kind);
  if (kind === 'scout') await ensureScoutXsrf(useTab);
  if (kind === 'nachrichten') await ensureNachrichtenTokens(useTab);

  const headers = {
    Accept: 'application/json, text/plain, */*',
    'X-Requested-With': 'XMLHttpRequest',
    ...(opts.headers || {}),
  };

  if (kind === 'scout' && _scoutXsrf && !headers['x-xsrf-token'] && !headers['X-XSRF-TOKEN']) {
    headers['x-xsrf-token'] = _scoutXsrf;
  }
  if (kind === 'nachrichten') {
    if (_hdrTokens.communicationMgr && !headers['x-xsrf-communication-mgr-token']) {
      headers['x-xsrf-communication-mgr-token'] = _hdrTokens.communicationMgr;
    }
    if (_hdrTokens.contactProspects && !headers['x-xsrf-contact-prospects-token']) {
      headers['x-xsrf-contact-prospects-token'] = _hdrTokens.contactProspects;
    }
  }
  if (kind === 'geo' && !headers['X-IS24-GAC'] && !headers['x-is24-gac']) {
    headers['X-IS24-GAC'] = IS24_GAC;
    if (!headers['Content-Type'] && !headers['content-type']) {
      headers['Content-Type'] = 'application/json';
    }
  }

  let bodyStr = null;
  if (opts.body != null) {
    if (typeof opts.body === 'string') {
      bodyStr = opts.body;
    } else {
      bodyStr = JSON.stringify(opts.body);
      if (!headers['Content-Type'] && !headers['content-type']) {
        headers['Content-Type'] = 'application/json';
      }
    }
  }

  const method = String(opts.method || 'GET').toUpperCase();

  // browser.fetch hangs on POST in this runtime (verified 2026-08-09). GETs are
  // fine via browser.fetch; non-GET goes through in-page eval fetch instead.
  async function doFetch(targetTab) {
    if (method === 'GET' || method === 'HEAD') {
      return browser.fetch(targetTab, url, { method, headers });
    }
    // evalAsync unwraps an async IIFE; bare `await` / `return` are illegal here.
    const expr = `(async () => {
      const r = await fetch(${JSON.stringify(url)}, {
        method: ${JSON.stringify(method)},
        credentials: 'include',
        headers: ${JSON.stringify(headers)},
        body: ${bodyStr == null ? 'undefined' : JSON.stringify(bodyStr)},
      });
      const text = await r.text();
      const hdrs = {};
      r.headers.forEach((v, k) => { hdrs[k] = v; });
      let body = text;
      const ct = (hdrs['content-type'] || '').toLowerCase();
      if (ct.includes('json') || (text && (text[0] === '{' || text[0] === '['))) {
        try { body = JSON.parse(text); } catch { /* keep text */ }
      }
      return { ok: r.ok, status: r.status, url: r.url, headers: hdrs, body };
    })()`;
    if (typeof browser.evalAsync !== 'function') {
      throw new Error('browser.evalAsync is required for non-GET ImmoScout calls');
    }
    const out = await browser.evalAsync(targetTab, expr);
    if (!out || typeof out !== 'object') {
      throw new Error('in-page fetch returned no result');
    }
    return out;
  }

  let res;
  try {
    res = await doFetch(useTab);
  } catch (err) {
    if (useTab !== tab) {
      try {
        res = await doFetch(tab);
      } catch (err2) {
        cli.die(
          `fetch failed for ${url.replace(/^https?:\/\/[^/]+/, '')}: ${err2.message || err2}`,
          { prefix: 'immobilienscout24' },
        );
      }
    } else {
      cli.die(
        `fetch failed for ${url.replace(/^https?:\/\/[^/]+/, '')}: ${err.message || err}`,
        { prefix: 'immobilienscout24' },
      );
    }
  }

  harvestTokens(res);

  // Retry once on scout 403 with fresh XSRF (cookie may have rotated).
  if (res.status === 403 && kind === 'scout') {
    _scoutXsrf = null;
    await ensureScoutXsrf(useTab);
    if (_scoutXsrf) {
      headers['x-xsrf-token'] = _scoutXsrf;
      try {
        res = await doFetch(useTab);
        harvestTokens(res);
      } catch {
        /* keep original */
      }
    }
  }

  // Retry once on nachrichten 403 after re-bootstrap.
  if (res.status === 403 && kind === 'nachrichten') {
    _bootstrapped.nachrichten = false;
    _hdrTokens.communicationMgr = null;
    _hdrTokens.contactProspects = null;
    await ensureNachrichtenTokens(useTab);
    if (_hdrTokens.communicationMgr) {
      headers['x-xsrf-communication-mgr-token'] = _hdrTokens.communicationMgr;
      if (_hdrTokens.contactProspects) {
        headers['x-xsrf-contact-prospects-token'] = _hdrTokens.contactProspects;
      }
      try {
        res = await doFetch(useTab);
        harvestTokens(res);
      } catch {
        /* keep original */
      }
    }
  }

  if (lookLikeLogin(res)) {
    cli.die(
      'session expired — log in to immobilienscout24.de in your browser, then retry',
      { prefix: 'immobilienscout24' },
    );
  }
  if (!res.ok) {
    const path = url.replace(/^https?:\/\/[^/]+/, '');
    let detail = '';
    if (typeof res.body === 'string' && res.body && !isHtmlBody(res.body)) {
      detail = `: ${fmt.trunc(res.body.replace(/\s+/g, ' '), 160)}`;
    } else if (res.body && typeof res.body === 'object') {
      try {
        detail = `: ${fmt.trunc(JSON.stringify(res.body), 160)}`;
      } catch {
        /* ignore */
      }
    } else if (isHtmlBody(res.body) && /roboter|captcha|waf/i.test(String(res.body).slice(0, 500))) {
      detail = ': blocked by bot check (open the page in the browser tab and retry)';
    }
    cli.die(`immobilienscout24 returned ${res.status} for ${path}${detail}`, {
      prefix: 'immobilienscout24',
    });
  }

  if (isHtmlBody(res.body)) {
    cli.die(
      'got HTML instead of JSON — session may have expired or hit a bot check; log in on immobilienscout24.de and retry',
      { prefix: 'immobilienscout24' },
    );
  }

  return res.body;
}

function clampInt(value, { min = 1, max = 50, fallback }) {
  const n = parseInt(value, 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(Math.max(n, min), max);
}

function money(n) {
  if (n == null || n === '') return null;
  const num = Number(n);
  if (!Number.isFinite(num)) return String(n);
  return num.toLocaleString('de-DE', {
    style: 'currency',
    currency: 'EUR',
    maximumFractionDigits: 0,
  });
}

function shortDate(v) {
  if (!v) return '';
  try {
    return fmt.date(v, 'short');
  } catch {
    return String(v).slice(0, 10);
  }
}

function preview(text, n = 90) {
  if (text == null) return '';
  return fmt.trunc(String(text).replace(/\s+/g, ' ').trim(), n);
}

// ── commands ───────────────────────────────────────────────────────────────

async function cmdMe(tab, flags) {
  // Soft identity fan-out. Do NOT route through apiFetch/cli.die — sso.* can
  // throw "Failed to fetch" from the nachrichten SPA bundle while sibling
  // endpoints on www still work. Prefer a scoutmanager tab when present.
  const idTab =
    (await getScoutTab()) ||
    (await browser.findTab({ urlMatch: /immobilienscout24\.de\/(?!nachrichten-manager)/i })) ||
    tab;

  async function softGet(url) {
    try {
      const res = await browser.fetch(idTab, url, {
        headers: { Accept: 'application/json' },
      });
      if (!res || !res.ok) {
        return { __error: `HTTP ${res && res.status}` };
      }
      return res.body;
    } catch (err) {
      return { __error: err.message || String(err) };
    }
  }

  const sso = await softGet(`${SSO}/sso/me`);
  const header = await softGet(`${HEADER_API}/api/v1/getByCookie`);
  const profile = await softGet(`${WWW}/meinkonto/endpoint/fullprofile/v2`);

  if (header?.__error && profile?.__error && sso?.__error) {
    cli.die(`could not load profile (${header.__error})`, {
      prefix: 'immobilienscout24',
    });
  }

  const out = { sso, header, profile };
  if (flags.json) {
    cli.out(out);
    return;
  }

  const first = header?.firstname || profile?.firstName || '';
  const last = header?.surname || profile?.lastName || '';
  const email = header?.email || sso?.email || profile?.email || '';
  const ssoId = sso?.ssoId ?? profile?.ssoId;
  const customer = header?.customerNumber || profile?.customerNumber;

  console.log('');
  console.log(color.bold(color.cyan(`  ${[first, last].filter(Boolean).join(' ') || sso?.username || 'Account'}`)));
  console.log(color.dim('  ' + '─'.repeat(52)));
  if (email) console.log(`  ${color.dim('Email:')}       ${email}`);
  if (ssoId != null) console.log(`  ${color.dim('SSO id:')}      ${ssoId}`);
  if (customer) console.log(`  ${color.dim('Customer #:')}  ${customer}`);
  if (header && header.isProfessional != null) {
    console.log(`  ${color.dim('Professional:')} ${header.isProfessional ? 'yes' : 'no'}`);
  }
  if (header?.membershipEdition) {
    console.log(`  ${color.dim('Membership:')}  ${header.membershipEdition}`);
  }
  if (profile?.realEstateSegment) {
    console.log(`  ${color.dim('Segment:')}     ${profile.realEstateSegment}`);
  }
  if (profile?.city || profile?.postcode) {
    const addr = [profile.street, profile.houseNumber].filter(Boolean).join(' ');
    const city = [profile.postcode, profile.city].filter(Boolean).join(' ');
    console.log(`  ${color.dim('Address:')}     ${[addr, city].filter(Boolean).join(', ')}`);
  }
  console.log('');
}

async function cmdDashboard(tab, flags) {
  const soft = async (url) => {
    try {
      return await apiFetch(tab, url);
    } catch (err) {
      if (err?.name === 'NodeExitError') throw err;
      return null;
    }
  };

  const unread = await apiFetch(tab, `${WWW}/meinkonto/dashboard-backend/unread-messages`);
  const pubs = await soft(`${WWW}/meinkonto/dashboard-backend/publication-statistics`);
  const contracts = await soft(`${WWW}/meinkonto/dashboard-backend/active-contract/count`);
  const propertyCount = await soft(`${MY_PROPERTY}/real-estate-objects/count`);
  const saved = await soft(`${WWW}/savedsearch/overviewwidget/recent/2`);
  const appPkg = await soft(`${WWW}/meinkonto/endpoint/appPackageStatus`);

  const out = {
    unread,
    publicationStatistics: pubs,
    activeContracts: contracts,
    propertyCount,
    savedSearches: saved,
    appPackageStatus: appPkg,
  };
  if (flags.json) {
    cli.out(out);
    return;
  }

  console.log('');
  console.log(color.bold('  Mein Konto dashboard'));
  console.log(color.dim('  ' + '─'.repeat(52)));

  const total = unread?.totalUnreadMessageCount ?? 0;
  const seeker = unread?.seekerUnreadMessageCount ?? 0;
  const owner = unread?.homeOwnerUnreadMessageCount ?? 0;
  const unreadLabel = total > 0 ? color.bold(color.green(String(total))) : color.gray('0');
  console.log(
    `  ${color.dim('Unread messages:')}  ${unreadLabel}  ${color.dim(`(seeker ${seeker} · landlord ${owner})`)}`,
  );

  if (pubs) {
    console.log(
      `  ${color.dim('Listings:')}          ${pubs.numberOfActiveListings ?? 0} active` +
        color.dim(` / ${pubs.numberOfListings ?? 0} total`) +
        color.dim(
          ` · ${pubs.numberOfDeactivatedListings ?? 0} off · ${pubs.numberOfArchivedListings ?? 0} archived`,
        ),
    );
  }
  if (contracts) {
    console.log(`  ${color.dim('Active contracts:')}  ${contracts.activeContractCount ?? 0}`);
  }
  if (propertyCount) {
    console.log(
      `  ${color.dim('My property:')}       ${propertyCount.standaloneUnits ?? 0} units` +
        color.dim(` · ${propertyCount.buildingCount ?? 0} buildings`),
    );
  }
  if (saved) {
    console.log(`  ${color.dim('Saved searches:')}    ${saved.totalSavedSearchCount ?? 0}`);
  }
  if (appPkg) {
    console.log(
      `  ${color.dim('App package:')}       ${
        appPkg.packageComplete ? color.green('complete') : color.gray('incomplete')
      }`,
    );
  }
  console.log('');
}

async function cmdListings(tab, flags) {
  const limit = clampInt(flags.limit ?? flags.l ?? flags.pagesize, {
    min: 1,
    max: 100,
    fallback: 20,
  });
  const archived = Boolean(flags.archived);
  const freeText =
    flags.q != null ? String(flags.q) : flags.query != null ? String(flags.query) : '';

  const body = {
    freeTextSearch: freeText,
    pageRequest: { from: 0, size: limit },
    orderBy: 'ALTERATION_DATE',
    publishedOnIS24: true,
    publishedOnHomepage: true,
    publishedOnMarkets: [],
    published: !archived,
    deactivated: !archived,
    archived,
  };

  const data = await apiFetch(tab, `${WWW}/scoutmanager/angebotsliste/api/query`, {
    method: 'POST',
    body,
  });

  const hits = Array.isArray(data?.searchHits) ? data.searchHits : [];
  const ids = hits.map((h) => h.id).filter((id) => id != null);

  let clickStats = [];
  let msgStats = [];
  if (ids.length) {
    const softPost = async (path, b) => {
      try {
        return await apiFetch(tab, path, { method: 'POST', body: b });
      } catch (err) {
        if (err?.name === 'NodeExitError') throw err;
        return [];
      }
    };
    clickStats = await softPost(`${WWW}/scoutmanager/angebotsliste/api/realestate-stats`, ids);
    msgStats = await softPost(`${WWW}/scoutmanager/angebotsliste/api/communication-stats`, ids);
  }

  const clickById = new Map(
    (Array.isArray(clickStats) ? clickStats : []).map((s) => [s.realEstateId, s]),
  );
  const msgById = new Map(
    (Array.isArray(msgStats) ? msgStats : []).map((s) => [s.realEstateId, s]),
  );

  const enriched = hits.map((h) => ({
    ...h,
    clickCount: clickById.get(h.id)?.clickCount,
    newMessages: msgById.get(h.id)?.newMessages,
  }));

  if (flags.json) {
    cli.out({
      totalHits: data?.totalHits ?? enriched.length,
      facetResults: data?.facetResults,
      searchHits: enriched,
    });
    return;
  }

  console.log('');
  console.log(
    color.bold('  ScoutManager listings') +
      color.dim(`  (${data?.totalHits ?? enriched.length} total, showing ${enriched.length})`),
  );
  console.log(color.dim('  ' + '─'.repeat(52)));

  if (!enriched.length) {
    console.log(color.dim('  No listings found.'));
    console.log('');
    return;
  }

  for (const h of enriched) {
    const title = color.cyan(color.bold(h.title || h.typeName || 'Listing'));
    const id = color.dim(`id:${h.id}`);
    const price = h.price != null ? color.green(money(h.price) || String(h.price)) : '';
    const meta = [
      h.typeName || h.type,
      h.rooms != null ? `${h.rooms} Zi` : null,
      h.area != null ? `${h.area} m²` : null,
      price,
    ].filter(Boolean);
    const addr =
      h.completeAddress ||
      [h.street, h.houseNumber, h.postalCode, h.city].filter(Boolean).join(' ');
    const status = h.archived
      ? color.gray('archived')
      : h.publishedOnIs24
        ? color.green('published')
        : color.yellow('off-market');
    const stats = [
      h.clickCount != null ? `${h.clickCount} clicks` : null,
      h.newMessages != null ? `${h.newMessages} new msgs` : null,
    ].filter(Boolean);

    console.log(`  ${title}  ${id}`);
    console.log(`     ${status}  ·  ${meta.join('  ·  ')}`);
    if (addr) console.log(`     ${color.dim(addr)}`);
    if (stats.length) console.log(`     ${color.dim(stats.join('  ·  '))}`);
    if (h.alterationDate) console.log(`     ${color.dim('updated ' + shortDate(h.alterationDate))}`);
    console.log('');
  }
}

async function cmdExposes(tab, flags) {
  const limit = clampInt(flags.limit ?? flags.l ?? flags.pagesize, {
    min: 1,
    max: 50,
    fallback: 12,
  });
  const data = await apiFetch(
    tab,
    `${WWW}/nachrichten-manager/api/expose?page=0&size=${limit}&sort=desc`,
  );

  if (flags.json) {
    cli.out(data);
    return;
  }

  const exposes = Array.isArray(data?.exposes)
    ? data.exposes
    : Array.isArray(data)
      ? data
      : [];
  console.log('');
  console.log(color.bold('  Nachrichten-Manager exposes') + color.dim(`  (${exposes.length})`));
  console.log(color.dim('  ' + '─'.repeat(52)));

  if (!exposes.length) {
    console.log(color.dim('  No exposes found.'));
    console.log('');
    return;
  }

  for (const ex of exposes) {
    const title = color.cyan(color.bold(ex.title || 'Expose'));
    const id = color.dim(`id:${ex.referenceId}`);
    const d = ex.details || {};
    const st = ex.statistics || {};
    const addr = ex.address
      ? [
          ex.address.street,
          ex.address.streetNumber || ex.address.houseNumber,
          ex.address.postcode,
          ex.address.city,
        ]
          .filter(Boolean)
          .join(' ')
      : '';
    const meta = [
      ex.status,
      ex.type,
      d.numberOfRooms != null ? `${d.numberOfRooms} Zi` : null,
      d.livingSpace != null ? `${d.livingSpace} m²` : null,
      d.price != null ? money(d.price) : null,
    ].filter(Boolean);
    const msg = [
      st.unreadCount != null ? `${st.unreadCount} unread` : null,
      st.totalCount != null ? `${st.totalCount} total` : null,
      st.contactProspectsCount != null ? `${st.contactProspectsCount} prospects` : null,
    ].filter(Boolean);

    console.log(`  ${title}  ${id}`);
    console.log(`     ${meta.join('  ·  ')}`);
    if (addr) console.log(`     ${color.dim(addr)}`);
    if (msg.length) console.log(`     ${color.dim(msg.join('  ·  '))}`);
    console.log('');
  }
}

async function cmdConversations(tab, listingId, flags) {
  if (!listingId) {
    cli.die('usage: immobilienscout24 conversations <listingId>', {
      prefix: 'immobilienscout24',
    });
  }
  if (!/^\d+$/.test(String(listingId))) {
    cli.die(`invalid listing id "${listingId}" — expected digits (from listings / exposes)`, {
      prefix: 'immobilienscout24',
    });
  }

  const limit = clampInt(flags.limit ?? flags.l ?? flags.size, {
    min: 1,
    max: 50,
    fallback: 10,
  });
  const tag = flags.tag ? String(flags.tag) : 'inbox';

  const url =
    `${WWW}/nachrichten-manager/api/references/${encodeURIComponent(listingId)}` +
    `/conversations?tags=${encodeURIComponent(tag)}&size=${limit}&plusUserPriority=true`;

  const data = await apiFetch(tab, url, {
    method: 'POST',
    body: { copilotConversations: [] },
  });

  if (flags.json) {
    cli.out(data);
    return;
  }

  const convos = Array.isArray(data?.conversations)
    ? data.conversations
    : Array.isArray(data)
      ? data
      : [];
  console.log('');
  console.log(
    color.bold(`  Conversations for listing ${listingId}`) +
      color.dim(`  tag=${tag} · ${convos.length} shown`),
  );
  console.log(color.dim('  ' + '─'.repeat(52)));

  if (!convos.length) {
    console.log(color.dim('  No conversations in this folder.'));
    console.log('');
    return;
  }

  for (const c of convos) {
    const name = color.cyan(color.bold(c.participantName || 'Participant'));
    const id = color.dim(`id:${c.conversationId}`);
    const read = c.read ? color.gray('read') : color.green('unread');
    const plus = c.participantPlus ? color.yellow('PLUS') : '';
    const when = c.lastUpdateDateTime ? color.dim(shortDate(c.lastUpdateDateTime)) : '';
    const tags = Array.isArray(c.tags) && c.tags.length ? color.dim(c.tags.join(',')) : '';
    const details = c.shortDetails?.details
      ? Object.entries(c.shortDetails.details)
          .map(([k, v]) => `${k}: ${v}`)
          .join(' · ')
      : '';

    console.log(`  ${name}  ${id}  ${read}${plus ? '  ' + plus : ''}`);
    const meta = [when, tags, c.conversationStage].filter(Boolean);
    if (meta.length) console.log(`     ${meta.join('  ·  ')}`);
    if (details) console.log(`     ${color.dim(details)}`);
    if (c.previewMessage) console.log(`     ${preview(c.previewMessage, 120)}`);
    console.log('');
  }
}

/** Decode numeric SSO id from digits or base64 (URL path uses base64 of ssoId). */
function resolveSsoId(raw) {
  const s = String(raw || '').trim();
  if (!s) return null;
  if (/^\d{5,12}$/.test(s)) return s;
  // base64 of digits, e.g. MTI2Mzk2NDYz → 126396463
  try {
    const decoded = Buffer.from(s, 'base64').toString('utf8');
    if (/^\d{5,12}$/.test(decoded)) return decoded;
  } catch {
    /* ignore */
  }
  return null;
}

/**
 * Cross-origin rent-profile GETs: page `fetch` is CORS-blocked; credentialed XHR works
 * from an IS24 tab (verified 2026-08-09). browser.fetch is same-tab proxy — also OK on
 * some runtimes, but XHR matches the SPA and is reliable here.
 */
async function xhrGetJson(tab, url) {
  if (typeof browser.evalAsync !== 'function') {
    throw new Error('browser.evalAsync is required for rent-profile XHR');
  }
  const expr = `(async () => {
    return await new Promise((resolve) => {
      const x = new XMLHttpRequest();
      x.open('GET', ${JSON.stringify(url)}, true);
      x.withCredentials = true;
      x.setRequestHeader('Accept', 'application/json, text/plain, */*');
      x.onload = () => {
        let body = x.responseText;
        const ct = (x.getResponseHeader('content-type') || '').toLowerCase();
        if (ct.includes('json') || (body && (body[0] === '{' || body[0] === '['))) {
          try { body = JSON.parse(x.responseText); } catch { /* keep text */ }
        }
        resolve({ ok: x.status >= 200 && x.status < 300, status: x.status, body });
      };
      x.onerror = () => resolve({ ok: false, status: 0, body: null, error: 'xhr network error' });
      x.send();
    });
  })()`;
  const out = await browser.evalAsync(tab, expr);
  if (!out || typeof out !== 'object') {
    throw new Error('rent-profile XHR returned no result');
  }
  return out;
}

/** Landlord view of a seeker's shared rent profile / Bewerbermappe metadata. */
async function fetchApplicantPreview(tab, ssoId) {
  const url = `${RENT_PROFILE_API}/profile-preview?ownerSsoId=${encodeURIComponent(ssoId)}`;
  const res = await xhrGetJson(tab, url);
  if (!res.ok) {
    const err = new Error(`rent-profile ${res.status || 'error'}`);
    err.status = res.status;
    err.body = res.body;
    throw err;
  }
  return res.body;
}

function formatApplicantHuman(preview, ssoId) {
  const name = [preview.firstName, preview.lastName].filter(Boolean).join(' ') || 'Applicant';
  console.log('');
  console.log(color.bold(`  Applicant ${name}`) + color.dim(`  sso:${ssoId}`));
  console.log(color.dim('  ' + '─'.repeat(52)));
  if (preview.plusBadge) console.log(`  ${color.yellow('IS24 Plus')}`);
  if (preview.birthdate) console.log(`  ${color.dim('DOB:')}        ${preview.birthdate}`);
  const addr = preview.address || {};
  const line = [addr.street, addr.houseNumber].filter(Boolean).join(' ');
  const city = [addr.postcode, addr.city].filter(Boolean).join(' ');
  if (line || city) console.log(`  ${color.dim('Address:')}    ${[line, city].filter(Boolean).join(', ')}`);
  if (preview.profession) console.log(`  ${color.dim('Profession:')} ${preview.profession}`);
  if (preview.levelOfEmployment) {
    console.log(`  ${color.dim('Employment:')} ${preview.levelOfEmployment}`);
  }
  if (preview.income != null) {
    console.log(`  ${color.dim('Net income:')} ${color.green(money(preview.income) + ' / mo')}`);
  }
  const move =
    preview.moveIn?.moveInDataType ||
    preview.moveIn?.moveInDate ||
    preview.moveInDate ||
    null;
  if (move) console.log(`  ${color.dim('Move-in:')}    ${move}`);
  const pets = preview.pets?.hasPets === false ? 'no' : preview.pets?.hasPets ? 'yes' : null;
  if (pets) console.log(`  ${color.dim('Pets:')}       ${pets}`);
  if (preview.smoker === false) console.log(`  ${color.dim('Smoker:')}     no`);
  if (preview.smoker === true) console.log(`  ${color.dim('Smoker:')}     yes`);
  if (preview.rentArrears === false) console.log(`  ${color.dim('Rent arrears flag:')} ${color.green('false')}`);
  if (preview.rentArrears === true) console.log(`  ${color.dim('Rent arrears flag:')} ${color.red('true')}`);
  if (preview.suretyShip != null) console.log(`  ${color.dim('Guarantor:')}  ${preview.suretyShip ? 'yes' : 'no'}`);
  if (preview.sharedApartment != null) {
    console.log(`  ${color.dim('WG:')}         ${preview.sharedApartment ? 'yes' : 'no'}`);
  }

  const docs = Array.isArray(preview.documents) ? preview.documents : [];
  console.log('');
  console.log(color.bold('  Bewerbermappe') + color.dim('  (metadata only — PDF blobs not exposed to landlord API)'));
  if (!docs.length) {
    console.log(color.dim('  No documents listed on shared profile.'));
  } else {
    for (const d of docs) {
      const when = d.creationDate || d.createdAt || '';
      console.log(`  ${color.green('✓')} ${d.type || '?'}${when ? color.dim('  ·  ' + when) : ''}`);
    }
  }
  const b64 = Buffer.from(String(ssoId), 'utf8').toString('base64');
  console.log('');
  console.log(
    color.dim(`  UI: ${WWW}/meinkonto/dokumente/ansicht/${b64}`),
  );
  console.log(
    color.dim(
      '  Note: messages.participantData.applicationDocuments.schufaProvided is often stale/false even when SCHUFA is hinterlegt — trust this preview.',
    ),
  );
  console.log('');
}

async function cmdApplicant(tab, rawId, flags) {
  const ssoId = resolveSsoId(rawId);
  if (!ssoId) {
    cli.die('usage: immobilienscout24 applicant <ssoId|base64SsoId>', {
      prefix: 'immobilienscout24',
    });
  }
  let preview;
  try {
    preview = await fetchApplicantPreview(tab, ssoId);
  } catch (err) {
    cli.die(
      `could not load applicant profile for sso ${ssoId}: ${err.message || err}` +
        (err.status ? ` (HTTP ${err.status})` : ''),
      { prefix: 'immobilienscout24' },
    );
  }
  if (flags.json) {
    cli.out({ ssoId, preview });
    return;
  }
  formatApplicantHuman(preview, ssoId);
}

async function cmdMessages(tab, listingId, conversationId, flags) {
  if (!listingId || !conversationId) {
    cli.die('usage: immobilienscout24 messages <listingId> <conversationId>', {
      prefix: 'immobilienscout24',
    });
  }
  if (!/^\d+$/.test(String(listingId))) {
    cli.die(`invalid listing id "${listingId}"`, { prefix: 'immobilienscout24' });
  }
  if (!/^[0-9a-f-]{16,80}$/i.test(String(conversationId))) {
    cli.die(`invalid conversation id "${conversationId}"`, { prefix: 'immobilienscout24' });
  }

  // Live 2026-08-09: GET conversation detail returns { messages: [...] }.
  // POST …/messages is the send-message endpoint (SendMessageRequest) — not a list.
  const base =
    `${WWW}/nachrichten-manager/api/references/${encodeURIComponent(listingId)}` +
    `/conversations/${encodeURIComponent(conversationId)}`;

  const detail = await apiFetch(tab, base);
  const list = Array.isArray(detail?.messages)
    ? detail.messages
    : Array.isArray(detail)
      ? detail
      : [];

  // Enrich with rent-profile Bewerbermappe when we have a seeker SSO id.
  // participantData.applicationDocuments.schufaProvided is unreliable (often false
  // while the mappe is complete) — prefer profile-preview document list.
  const ssoId =
    detail?.conversation?.participantSsoId ||
    detail?.participantSsoId ||
    detail?.participant?.ssoId ||
    null;
  let applicant = null;
  let applicantError = null;
  if (ssoId && /^\d{5,12}$/.test(String(ssoId))) {
    try {
      applicant = await fetchApplicantPreview(tab, String(ssoId));
    } catch (err) {
      applicantError = err.message || String(err);
    }
  }

  if (flags.json) {
    cli.out({
      ...((detail && typeof detail === 'object' && !Array.isArray(detail)) ? detail : { messages: detail }),
      applicant,
      applicantError,
      _notes: {
        schufaProvidedUnreliable:
          'participantData.applicationDocuments.schufaProvided is often false even when SCHUFA_SOLVENCY is on the shared mappe — use applicant.documents',
      },
    });
    return;
  }

  console.log('');
  console.log(color.bold(`  Thread ${conversationId}`));
  console.log(color.dim(`  listing ${listingId}`));
  console.log(color.dim('  ' + '─'.repeat(52)));

  const conv = detail?.conversation || detail;
  if (conv && typeof conv === 'object') {
    const who = conv.participantName || detail.participantName || detail.participant?.name;
    if (who) {
      const plus = conv.participantPlus || detail.participantPlus ? color.yellow(' PLUS') : '';
      console.log(`  ${color.dim('With:')}     ${color.cyan(who)}${plus}`);
    }
    if (ssoId) console.log(`  ${color.dim('SSO:')}      ${ssoId}`);
    if (conv.status || detail.status) console.log(`  ${color.dim('Status:')}   ${conv.status || detail.status}`);
    if (conv.conversationStage || detail.conversationStage) {
      console.log(`  ${color.dim('Stage:')}    ${conv.conversationStage || detail.conversationStage}`);
    }
  }

  // Compact participant strip from Nachrichten payload
  const pd = detail?.participantData;
  if (pd && typeof pd === 'object') {
    const addr = pd.address || pd.personalDetails?.personalInformation?.address;
    if (addr) {
      const line = [addr.street, addr.houseNumber].filter(Boolean).join(' ');
      const city = [addr.postcode, addr.city].filter(Boolean).join(' ');
      if (line || city) console.log(`  ${color.dim('Address:')}  ${[line, city].filter(Boolean).join(', ')}`);
    }
    const phones = Array.isArray(pd.phoneNumbers) ? pd.phoneNumbers : [];
    if (phones.length) {
      console.log(
        `  ${color.dim('Phone:')}    ${phones.map((p) => p.number || p).filter(Boolean).join(', ')}`,
      );
    }
    const emp = pd.personalDetails?.personalInformation?.employment?.type;
    const income = pd.personalDetails?.householdIncome?.netIncomeRange;
    const usage = pd.personalDetails?.propertyUsage;
    const bits = [
      emp,
      income,
      usage?.numberOfResidents || usage?.numberOfPersons,
      usage?.petsInHousehold != null ? `pets:${usage.petsInHousehold}` : null,
    ].filter(Boolean);
    if (bits.length) console.log(`  ${color.dim('Profile:')}  ${bits.join(' · ')}`);
    const docs = pd.personalDetails?.applicationDocuments;
    if (docs) {
      const schufaFlag = docs.schufaProvided;
      console.log(
        `  ${color.dim('Msgs flag:')} schufaProvided=${schufaFlag}` +
          color.dim(schufaFlag ? '' : ' (unreliable — see Bewerbermappe below)'),
      );
    }
    if (pd.url) console.log(`  ${color.dim('Mappe UI:')} ${pd.url}`);
  }

  if (applicant) {
    const docs = Array.isArray(applicant.documents) ? applicant.documents : [];
    const inc =
      applicant.income != null ? money(applicant.income) + '/mo' : null;
    const head = [
      applicant.profession,
      applicant.levelOfEmployment,
      inc,
      applicant.birthdate,
    ].filter(Boolean);
    console.log(
      `  ${color.dim('Mappe:')}    ${color.green(docs.length ? docs.map((d) => d.type).join(', ') : 'no docs')}` +
        (head.length ? color.dim('  ·  ' + head.join(' · ')) : ''),
    );
    if (applicant.rentArrears === false) {
      console.log(`  ${color.dim('Arrears:')}  ${color.green('flag false')}`);
    }
  } else if (applicantError) {
    console.log(color.dim(`  Mappe:    (preview failed: ${applicantError})`));
  }

  if (!list.length) {
    console.log(color.dim('  No messages returned. Use --json to inspect the raw payload.'));
    console.log('');
    return;
  }

  console.log('');
  for (const m of list) {
    const when =
      m.creationDateTime || m.createdDateTime || m.creationDate || m.timestamp || m.date || '';
    let from =
      m.senderName ||
      m.authorName ||
      m.sender?.name ||
      null;
    if (!from) {
      if (m.userType === 'REALTOR' || m.outgoing || m.sentByMe || m.direction === 'OUT') {
        from = 'you';
      } else if (m.userType === 'SEEKER') {
        from = 'them';
      } else {
        from = m.senderType || 'them';
      }
    }
    const text = m.message || m.text || m.body || m.content || m.previewMessage || '';
    console.log(`  ${color.bold(String(from))}  ${color.dim(shortDate(when) || '')}`);
    if (text) console.log(`     ${String(text).replace(/\r\n/g, '\n').split('\n').join('\n     ')}`);
    console.log('');
  }
}

// ── send (write path) ──────────────────────────────────────────────────────
//
// POST /nachrichten-manager/api/references/:reference/conversations/:conversationId/messages
//
// Endpoint + payload shape read out of the Nachrichten-Manager SPA bundle
// (static/js/main.6423fc7b.js): api map entry `messageSend` and the
// `sendMessage` hook that builds
//   { message, conversationId, tags, recommendedActionName, [uploadIds], [appointment] }
// and POSTs it. CSRF is the same x-xsrf-communication-mgr-token flow the read
// paths already use, so apiFetch handles it.
//
// SAFETY: real prospects are on the other end. Without --confirm this prints the
// request and returns without any network call.

const MAX_MESSAGE_CHARS = 100000; // UI reply textarea maxLength (observed in DOM)
const SEND_ALIASES = new Set(['send', 'reply', 'antworten']);

function sendUrl(listingId, conversationId) {
  return (
    `${WWW}/nachrichten-manager/api/references/${encodeURIComponent(listingId)}` +
    `/conversations/${encodeURIComponent(conversationId)}/messages`
  );
}

function readMessageBody(positionalText, flags) {
  const filePath = typeof flags.file === 'string' ? flags.file : null;
  if (filePath) {
    if (positionalText) {
      cli.die('pass the message either inline or via --file, not both', {
        prefix: 'immobilienscout24',
      });
    }
    const fs = require('node:fs');
    let raw;
    try {
      raw = fs.readFileSync(filePath, 'utf8');
    } catch (err) {
      cli.die(`cannot read --file ${filePath}: ${err.message || err}`, {
        prefix: 'immobilienscout24',
      });
    }
    return raw.replace(/\r\n/g, '\n').replace(/\s+$/, '');
  }
  return positionalText == null ? '' : String(positionalText).replace(/\r\n/g, '\n');
}

function parseTags(flags) {
  const raw = flags.tags;
  if (raw == null || raw === true || raw === '') return [];
  return String(raw)
    .split(',')
    .map((t) => t.trim())
    .filter(Boolean);
}

async function cmdSend(tab, listingId, conversationId, textArg, flags) {
  if (!listingId || !conversationId) {
    cli.die(
      'usage: immobilienscout24 send <listingId> <conversationId> "text" [--confirm]\n' +
        '       immobilienscout24 send <listingId> <conversationId> --file <path> [--confirm]',
      { prefix: 'immobilienscout24' },
    );
  }
  if (!/^\d+$/.test(String(listingId))) {
    cli.die(`invalid listing id "${listingId}"`, { prefix: 'immobilienscout24' });
  }
  if (!/^[0-9a-f-]{16,80}$/i.test(String(conversationId))) {
    cli.die(`invalid conversation id "${conversationId}"`, { prefix: 'immobilienscout24' });
  }

  const message = readMessageBody(textArg, flags);
  if (!message.trim()) {
    cli.die(
      'empty message body — pass text as the third argument or use --file <path>',
      { prefix: 'immobilienscout24' },
    );
  }
  if (message.length > MAX_MESSAGE_CHARS) {
    cli.die(
      `message is ${message.length} characters; the Nachrichten-Manager reply box caps at ${MAX_MESSAGE_CHARS}`,
      { prefix: 'immobilienscout24' },
    );
  }

  const url = sendUrl(listingId, conversationId);
  const payload = {
    message,
    conversationId: String(conversationId),
    tags: parseTags(flags),
    recommendedActionName: null,
  };

  // ── dry run: no tab, no request, exit 0 ─────────────────────────────────
  if (!flags.confirm) {
    if (flags.json) {
      cli.out({
        dryRun: true,
        confirmed: false,
        method: 'POST',
        url,
        listingId: String(listingId),
        conversationId: String(conversationId),
        payload,
        messageChars: message.length,
        note: 'nothing was sent — re-run with --confirm to POST this exact request',
      });
      return;
    }
    console.log('');
    console.log(color.bold('  DRY RUN') + color.dim('  — nothing sent, no network call made'));
    console.log(color.dim('  ────────────────────────────────────────────────────'));
    console.log(`  ${color.dim('Method:')}   POST`);
    console.log(`  ${color.dim('URL:')}      ${url}`);
    console.log(`  ${color.dim('Listing:')}  ${listingId}`);
    console.log(`  ${color.dim('Conv:')}     ${conversationId}`);
    console.log(`  ${color.dim('Chars:')}    ${message.length}`);
    console.log('');
    console.log(color.bold('  Payload'));
    console.log(
      JSON.stringify(payload, null, 2)
        .split('\n')
        .map((l) => '  ' + l)
        .join('\n'),
    );
    console.log('');
    console.log(color.bold('  Message body'));
    console.log(message.split('\n').map((l) => '  │ ' + l).join('\n'));
    console.log('');
    if (!payload.tags.length) {
      console.log(
        color.dim(
          "  tags is empty — the web UI copies the conversation's current tags here;\n" +
            "  pass --tags a,b (the tags column in the conversations command) to mirror it.",
        ),
      );
      console.log('');
    }
    console.log(
      `  ${color.yellow('Not sent.')} ` +
        color.dim('Re-run the same command with --confirm to deliver it.'),
    );
    console.log('');
    return;
  }

  // ── confirmed: verify the conversation, then POST ───────────────────────
  let detail = null;
  try {
    detail = await apiFetch(
      tab,
      `${WWW}/nachrichten-manager/api/references/${encodeURIComponent(listingId)}` +
        `/conversations/${encodeURIComponent(conversationId)}`,
    );
  } catch (err) {
    if (err?.name === 'NodeExitError') throw err;
    cli.die(
      `could not load conversation ${conversationId} on listing ${listingId}: ${err.message || err}`,
      { prefix: 'immobilienscout24' },
    );
  }
  const participant =
    detail?.participantData?.name ||
    detail?.conversation?.participantName ||
    detail?.participantName ||
    null;

  const sent = await apiFetch(tab, url, { method: 'POST', body: payload });

  if (flags.json) {
    cli.out({ dryRun: false, confirmed: true, url, payload, response: sent });
    return;
  }
  console.log('');
  console.log(`  ${color.green('✓')} Message sent`);
  console.log(`  ${color.dim('Conv:')}     ${conversationId}`);
  if (participant) console.log(`  ${color.dim('To:')}       ${participant}`);
  const messageId = sent?.messageId || sent?.id || sent?.message?.messageId || null;
  if (messageId) console.log(`  ${color.dim('Message:')}  ${messageId}`);
  console.log(`  ${color.dim('Chars:')}    ${message.length}`);
  console.log('');
}

async function cmdGeo(tab, query, flags) {
  if (!query) {
    cli.die('usage: immobilienscout24 geo <query>', { prefix: 'immobilienscout24' });
  }

  const params = new URLSearchParams({
    i: query,
    lpt: '5',
    t: 'country,region,city,quarterOrTown,quarter,district,postcode,trainStation,street,address,poi,customArea',
    f: 'shapeAvailable',
    dataset: 'nextgen',
  });
  const data = await apiFetch(tab, `${WWW}/geoautocomplete/v4.0/DEU?${params.toString()}`);

  if (flags.json) {
    cli.out(data);
    return;
  }

  const items = Array.isArray(data) ? data : [];
  console.log('');
  console.log(color.bold(`  Geoautocomplete`) + color.dim(`  “${query}” · ${items.length} hits`));
  console.log(color.dim('  ' + '─'.repeat(52)));

  if (!items.length) {
    console.log(color.dim('  No matches.'));
    console.log('');
    return;
  }

  for (const item of items) {
    const e = item.entity || item;
    const label = color.cyan(color.bold(e.label || e.id || '?'));
    const type = color.gray(e.type || '');
    const id = color.dim(`geo:${e.id || e.geoId || e.shapeId || ''}`);
    const path = e.geopath?.uri ? color.dim(e.geopath.uri) : '';
    console.log(`  ${label}  ${type}  ${id}`);
    if (path) console.log(`     ${path}`);
  }
  console.log('');
}

async function resolveGeo(tab, location) {
  const raw = String(location).trim();
  if (/^\d{6,}$/.test(raw)) {
    return { id: raw, label: raw, geopath: null, type: 'id' };
  }

  const params = new URLSearchParams({
    i: raw,
    lpt: '5',
    t: 'country,region,city,quarterOrTown,quarter,district,postcode,trainStation,street,address,poi,customArea',
    f: 'shapeAvailable',
    dataset: 'nextgen',
  });
  const suggestions = await apiFetch(tab, `${WWW}/geoautocomplete/v4.0/DEU?${params.toString()}`);
  const first =
    Array.isArray(suggestions) && suggestions[0]
      ? suggestions[0].entity || suggestions[0]
      : null;
  if (!first?.id) {
    cli.die(`no geo match for "${raw}" — try a city name like Berlin or a postcode`, {
      prefix: 'immobilienscout24',
    });
  }
  return first;
}

async function cmdSearch(tab, location, flags) {
  if (!location) {
    cli.die('usage: immobilienscout24 search <location> [--type rent|buy|…]', {
      prefix: 'immobilienscout24',
    });
  }

  const typeKey = String(flags.type || 'rent').toLowerCase();
  const realEstateType = SEARCH_TYPES[typeKey];
  if (!realEstateType) {
    cli.die(`unknown --type ${typeKey} (use rent|buy|house-rent|house-buy|short-term)`, {
      prefix: 'immobilienscout24',
    });
  }

  const page = clampInt(flags.page ?? flags.pagenumber, { min: 1, max: 100, fallback: 1 });
  const pagesize = clampInt(flags.pagesize ?? flags.limit ?? flags.l, {
    min: 1,
    max: 50,
    fallback: 20,
  });

  const geo = await resolveGeo(tab, location);

  // Build the classic /region?… search URL the SPA feeds into oneStepSearch.
  const regionQs = new URLSearchParams({
    realestatetype: realEstateType,
    exclusioncriteria: 'swapflat',
    geocodes: String(geo.id),
  });
  if (flags['price-max'] != null || flags.priceMax != null || flags.pricemax != null) {
    regionQs.set('price', `-/${flags['price-max'] ?? flags.priceMax ?? flags.pricemax}`);
  }
  if (flags['rooms-min'] != null || flags.roomsMin != null || flags.roomsmin != null) {
    regionQs.set('numberofrooms', `${flags['rooms-min'] ?? flags.roomsMin ?? flags.roomsmin}-`);
  }
  if (flags['area-min'] != null || flags.areaMin != null || flags.areamin != null) {
    regionQs.set('livingspace', `${flags['area-min'] ?? flags.areaMin ?? flags.areamin}-`);
  }

  const locationPath = `/region?${regionQs.toString()}`;
  const form = new URLSearchParams({
    type: 'SEARCH_URL',
    location: locationPath,
  });

  // browser.fetch with form body as string
  const step = await apiFetch(tab, `${WWW}/Suche/controller/oneStepSearch`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept: 'application/json',
    },
    body: form.toString(),
  });

  const redirectUrl = step?.redirectUrl || step?.url || null;
  // Append paging if we got a pretty path back.
  let resultPath = redirectUrl;
  if (resultPath && !/[?&]pagenumber=/.test(resultPath)) {
    const join = resultPath.includes('?') ? '&' : '?';
    resultPath = `${resultPath}${join}pagenumber=${page}&pagesize=${pagesize}`;
  }

  const out = { geo, oneStepSearch: step, resultPath };
  if (flags.json) {
    cli.out(out);
    return;
  }

  const label = geo.label || location;
  console.log('');
  console.log(
    color.bold(`  Search ${label}`) + color.dim(`  ${realEstateType} · page ${page}`),
  );
  console.log(
    color.dim(`  geo:${geo.id}${geo.geopath?.uri ? ' · ' + geo.geopath.uri : ''}`),
  );
  console.log(color.dim('  ' + '─'.repeat(52)));
  if (resultPath) {
    const abs = resultPath.startsWith('http') ? resultPath : `${WWW}${resultPath}`;
    console.log(`  ${color.dim('Result URL:')}  ${color.cyan(abs)}`);
    console.log(
      color.dim(
        '  Note: the result-list JSON endpoint is WAF-gated from automated fetch;',
      ),
    );
    console.log(color.dim('  open the URL in the IS24 tab (or use the browser) to browse hits.'));
  } else {
    console.log(color.dim('  oneStepSearch returned no redirectUrl — use --json.'));
  }
  console.log('');
}

// ── main ───────────────────────────────────────────────────────────────────

async function main() {
  if (flags.help || flags.h || !subcommand || subcommand === 'help') {
    cli.help(HELP);
  }

  // `send` without --confirm is a pure local preview: no tab lookup, no request.
  const isSendPreview = SEND_ALIASES.has(subcommand) && !flags.confirm;
  const tab = isSendPreview ? null : await getTab();

  try {
    if (subcommand === 'me' || subcommand === 'profile' || subcommand === 'whoami') {
      await cmdMe(tab, flags);
    } else if (subcommand === 'dashboard' || subcommand === 'dash' || subcommand === 'home') {
      await cmdDashboard(tab, flags);
    } else if (subcommand === 'listings' || subcommand === 'angebote' || subcommand === 'listing') {
      await cmdListings(tab, flags);
    } else if (subcommand === 'exposes' || subcommand === 'expose') {
      await cmdExposes(tab, flags);
    } else if (
      subcommand === 'conversations' ||
      subcommand === 'inbox' ||
      subcommand === 'nachrichten'
    ) {
      await cmdConversations(tab, positional[0], flags);
    } else if (
      subcommand === 'messages' ||
      subcommand === 'thread' ||
      subcommand === 'conversation'
    ) {
      await cmdMessages(tab, positional[0], positional[1], flags);
    } else if (
      subcommand === 'applicant' ||
      subcommand === 'bewerber' ||
      subcommand === 'mappe' ||
      subcommand === 'rent-profile' ||
      subcommand === 'rentprofile'
    ) {
      await cmdApplicant(tab, positional[0], flags);
    } else if (SEND_ALIASES.has(subcommand)) {
      await cmdSend(tab, positional[0], positional[1], positional[2], flags);
    } else if (subcommand === 'search' || subcommand === 'suche') {
      const loc = positional.length ? positional.join(' ') : '';
      await cmdSearch(tab, loc, flags);
    } else if (subcommand === 'geo' || subcommand === 'geoautocomplete' || subcommand === 'gac') {
      const q = positional.length ? positional.join(' ') : '';
      await cmdGeo(tab, q, flags);
    } else {
      cli.die(
        `unknown command: ${subcommand}\nRun 'immobilienscout24 --help' for usage.`,
        { prefix: 'immobilienscout24' },
      );
    }
  } catch (err) {
    if (err?.name === 'NodeExitError') throw err;
    cli.die(err.message || String(err), { prefix: 'immobilienscout24' });
  }
}

await main();

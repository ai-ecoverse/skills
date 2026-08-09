// immobilienscout24.jsh — ImmoScout24 browser-session client
//
// AUTH: cookie session in an open immobilienscout24.de tab. Multi-subdomain
// APIs (sso., api.header., my-property., www.) are called via browser.fetch so
// first-party cookies travel automatically. No token is stored or printed.
//
// Endpoints reverse-engineered from /recordings/rec-1786282613280-yexubu/
// (2026-08-09). See ../references/endpoints.md.

const browser = require('sliccy:browser');
const cli = require('sliccy:cli');
const color = require('sliccy:color');
const fmt = require('sliccy:fmt');

const WWW = 'https://www.immobilienscout24.de';
const SSO = 'https://sso.immobilienscout24.de';
const HEADER_API = 'https://api.header.immobilienscout24.de';
const MY_PROPERTY = 'https://my-property.immobilienscout24.de';

const HELP = `
immobilienscout24 — ImmoScout24 client (browser session)

USAGE
  immobilienscout24 me
  immobilienscout24 dashboard
  immobilienscout24 listings [--limit N] [--q TEXT] [--archived]
  immobilienscout24 exposes [--limit N]
  immobilienscout24 conversations <listingId> [--limit N] [--tag inbox]
  immobilienscout24 messages <listingId> <conversationId>
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

REQUIRES
  immobilienscout24.de open and logged in in your browser
`.trim();

// ── real-estate type map (search) ──────────────────────────────────────────

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

// ── args ───────────────────────────────────────────────────────────────────

const parsed = process.argv.parseFlags();
const subcommand = parsed.subcommand || parsed.positional[0] || '';
const positional = parsed.subcommand
  ? parsed.positional.slice(1)
  : parsed.positional.slice(1);
const flags = parsed.flags;

// ── session ────────────────────────────────────────────────────────────────

let _tab = null;

async function getTab() {
  if (_tab) return _tab;
  // Prefer www / app pages over pure static CDN tabs.
  _tab = await browser.findTab({ urlMatch: /immobilienscout24\.de/i });
  if (!_tab) {
    cli.die(
      'open https://www.immobilienscout24.de in your browser and log in first',
      { prefix: 'immobilienscout24' },
    );
  }
  return _tab;
}

function isHtmlBody(body) {
  if (typeof body !== 'string') return false;
  const s = body.slice(0, 200).trim().toLowerCase();
  return s.startsWith('<!doctype') || s.startsWith('<html') || s.includes('<html');
}

function lookLikeLogin(res) {
  if (res.status === 401 || res.status === 403) return true;
  const url = String(res.url || '');
  if (/\/sso\/login|\/meinkonto\/login|\/login/i.test(url)) return true;
  if (typeof res.body === 'string' && /anmelden|log\s*in|login-form/i.test(res.body.slice(0, 2000)) && isHtmlBody(res.body)) {
    return true;
  }
  return false;
}

async function apiFetch(tab, url, opts = {}) {
  const headers = {
    Accept: 'application/json, text/plain, */*',
    'X-Requested-With': 'XMLHttpRequest',
    ...(opts.headers || {}),
  };
  const fetchOpts = { ...opts, headers };
  if (fetchOpts.body != null && typeof fetchOpts.body === 'object' && !(typeof fetchOpts.body === 'string')) {
    fetchOpts.body = JSON.stringify(fetchOpts.body);
    if (!headers['Content-Type'] && !headers['content-type']) {
      headers['Content-Type'] = 'application/json';
    }
  }

  const res = await browser.fetch(tab, url, fetchOpts);

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
    }
    cli.die(`immobilienscout24 returned ${res.status} for ${path}${detail}`, {
      prefix: 'immobilienscout24',
    });
  }

  // Login walls sometimes 200 with HTML.
  if (isHtmlBody(res.body)) {
    cli.die(
      'got HTML instead of JSON — session may have expired; log in on immobilienscout24.de and retry',
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
  return num.toLocaleString('de-DE', { style: 'currency', currency: 'EUR', maximumFractionDigits: 0 });
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
  // Fan-out across the three identity endpoints seen on every logged-in page.
  const [sso, header, profile] = await Promise.all([
    apiFetch(tab, `${SSO}/sso/me`),
    apiFetch(tab, `${HEADER_API}/api/v1/getByCookie`),
    apiFetch(tab, `${WWW}/meinkonto/endpoint/fullprofile/v2`),
  ]);

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
  const [
    unread,
    pubs,
    contracts,
    propertyCount,
    saved,
    appPkg,
  ] = await Promise.all([
    apiFetch(tab, `${WWW}/meinkonto/dashboard-backend/unread-messages`),
    apiFetch(tab, `${WWW}/meinkonto/dashboard-backend/publication-statistics`),
    apiFetch(tab, `${WWW}/meinkonto/dashboard-backend/active-contract/count`),
    apiFetch(tab, `${MY_PROPERTY}/real-estate-objects/count`).catch(() => null),
    apiFetch(tab, `${WWW}/savedsearch/overviewwidget/recent/2`).catch(() => null),
    apiFetch(tab, `${WWW}/meinkonto/endpoint/appPackageStatus`).catch(() => null),
  ]);

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
  console.log(`  ${color.dim('Unread messages:')}  ${unreadLabel}  ${color.dim(`(seeker ${seeker} · landlord ${owner})`)}`);

  if (pubs) {
    console.log(
      `  ${color.dim('Listings:')}          ${pubs.numberOfActiveListings ?? 0} active` +
        color.dim(` / ${pubs.numberOfListings ?? 0} total`) +
        color.dim(` · ${pubs.numberOfDeactivatedListings ?? 0} off · ${pubs.numberOfArchivedListings ?? 0} archived`),
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
      `  ${color.dim('App package:')}       ${appPkg.packageComplete ? color.green('complete') : color.gray('incomplete')}`,
    );
  }
  console.log('');
}

async function cmdListings(tab, flags) {
  const limit = clampInt(flags.limit ?? flags.l ?? flags.pagesize, { min: 1, max: 100, fallback: 20 });
  const archived = Boolean(flags.archived);
  const freeText = flags.q != null ? String(flags.q) : (flags.query != null ? String(flags.query) : '');

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
    // Best-effort — stats endpoints accept a batch of listing ids.
    [clickStats, msgStats] = await Promise.all([
      apiFetch(tab, `${WWW}/scoutmanager/angebotsliste/api/realestate-stats`, {
        method: 'POST',
        body: ids,
      }).catch(() => []),
      apiFetch(tab, `${WWW}/scoutmanager/angebotsliste/api/communication-stats`, {
        method: 'POST',
        body: ids,
      }).catch(() => []),
    ]);
  }

  const clickById = new Map((Array.isArray(clickStats) ? clickStats : []).map((s) => [s.realEstateId, s]));
  const msgById = new Map((Array.isArray(msgStats) ? msgStats : []).map((s) => [s.realEstateId, s]));

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
    const addr = h.completeAddress || [h.street, h.houseNumber, h.postalCode, h.city].filter(Boolean).join(' ');
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
  const limit = clampInt(flags.limit ?? flags.l ?? flags.pagesize, { min: 1, max: 50, fallback: 12 });
  const data = await apiFetch(
    tab,
    `${WWW}/nachrichten-manager/api/expose?page=0&size=${limit}&sort=desc`,
  );

  if (flags.json) {
    cli.out(data);
    return;
  }

  const exposes = Array.isArray(data?.exposes) ? data.exposes : Array.isArray(data) ? data : [];
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
      ? [ex.address.street, ex.address.streetNumber || ex.address.houseNumber, ex.address.postcode, ex.address.city]
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
    cli.die('usage: immobilienscout24 conversations <listingId>', { prefix: 'immobilienscout24' });
  }
  if (!/^\d+$/.test(String(listingId))) {
    cli.die(`invalid listing id "${listingId}" — expected digits (from listings / exposes)`, {
      prefix: 'immobilienscout24',
    });
  }

  const limit = clampInt(flags.limit ?? flags.l ?? flags.size, { min: 1, max: 50, fallback: 10 });
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

  const convos = Array.isArray(data?.conversations) ? data.conversations : Array.isArray(data) ? data : [];
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

async function cmdMessages(tab, listingId, conversationId, flags) {
  if (!listingId || !conversationId) {
    cli.die('usage: immobilienscout24 messages <listingId> <conversationId>', {
      prefix: 'immobilienscout24',
    });
  }
  if (!/^\d+$/.test(String(listingId))) {
    cli.die(`invalid listing id "${listingId}"`, { prefix: 'immobilienscout24' });
  }
  // Conversation ids are UUIDs in the captured SPA.
  if (!/^[0-9a-f-]{16,80}$/i.test(String(conversationId))) {
    cli.die(`invalid conversation id "${conversationId}"`, { prefix: 'immobilienscout24' });
  }

  const base =
    `${WWW}/nachrichten-manager/api/references/${encodeURIComponent(listingId)}` +
    `/conversations/${encodeURIComponent(conversationId)}`;

  // Detail + messages — both routes come from the nachrichten-manager SPA
  // bundle (not exercised as separate XHRs in the source HAR). Fall back
  // gracefully if one shape differs.
  let detail = null;
  let messages = null;
  let errors = [];

  try {
    detail = await apiFetch(tab, base);
  } catch (err) {
    if (err?.name === 'NodeExitError') throw err;
    errors.push(`detail: ${err.message}`);
  }

  try {
    messages = await apiFetch(tab, `${base}/messages`);
  } catch (err) {
    if (err?.name === 'NodeExitError') throw err;
    errors.push(`messages: ${err.message}`);
  }

  // Some builds nest messages under the conversation detail.
  if (!messages && detail) {
    messages = detail.messages || detail.communicationMessages || detail;
  }

  const out = { conversation: detail, messages, errors: errors.length ? errors : undefined };
  if (flags.json) {
    cli.out(out);
    return;
  }

  console.log('');
  console.log(color.bold(`  Thread ${conversationId}`));
  console.log(color.dim(`  listing ${listingId}`));
  console.log(color.dim('  ' + '─'.repeat(52)));

  if (detail && typeof detail === 'object') {
    const who = detail.participantName || detail.participant?.name;
    if (who) console.log(`  ${color.dim('With:')}     ${color.cyan(who)}`);
    if (detail.status) console.log(`  ${color.dim('Status:')}   ${detail.status}`);
    if (detail.conversationStage) console.log(`  ${color.dim('Stage:')}    ${detail.conversationStage}`);
  }

  const list = Array.isArray(messages)
    ? messages
    : Array.isArray(messages?.messages)
      ? messages.messages
      : Array.isArray(messages?.content)
        ? messages.content
        : [];

  if (!list.length) {
    if (errors.length) {
      console.log(color.dim(`  Could not load messages (${errors.join('; ')}).`));
      console.log(color.dim('  Try: immobilienscout24 conversations ' + listingId));
    } else {
      console.log(color.dim('  No messages returned. Use --json to inspect the raw payload.'));
    }
    console.log('');
    return;
  }

  console.log('');
  for (const m of list) {
    const when = m.createdDateTime || m.creationDate || m.timestamp || m.date || '';
    const from =
      m.senderName ||
      m.authorName ||
      m.sender?.name ||
      (m.outgoing || m.sentByMe || m.direction === 'OUT' ? 'you' : m.senderType || 'them');
    const text = m.message || m.text || m.body || m.content || m.previewMessage || '';
    console.log(`  ${color.bold(String(from))}  ${color.dim(shortDate(when) || '')}`);
    if (text) console.log(`     ${String(text).replace(/\r\n/g, '\n').split('\n').join('\n     ')}`);
    console.log('');
  }
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
  // Accept a raw geocode id, a geopath uri, or free text.
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
  const first = Array.isArray(suggestions) && suggestions[0] ? suggestions[0].entity || suggestions[0] : null;
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
    cli.die(
      `unknown --type ${typeKey} (use rent|buy|house-rent|house-buy|short-term)`,
      { prefix: 'immobilienscout24' },
    );
  }

  const page = clampInt(flags.page ?? flags.pagenumber, { min: 1, max: 100, fallback: 1 });
  const pagesize = clampInt(flags.pagesize ?? flags.limit ?? flags.l, { min: 1, max: 50, fallback: 20 });

  const geo = await resolveGeo(tab, location);

  const qs = new URLSearchParams({
    realestatetype: realEstateType,
    exclusioncriteria: 'swapflat',
    geocodes: String(geo.id),
    pagesize: String(pagesize),
    pagenumber: String(page),
  });

  if (flags['price-max'] != null || flags.priceMax != null || flags.pricemax != null) {
    qs.set('price', `-/${flags['price-max'] ?? flags.priceMax ?? flags.pricemax}`);
  }
  if (flags['rooms-min'] != null || flags.roomsMin != null || flags.roomsmin != null) {
    qs.set('numberofrooms', `${flags['rooms-min'] ?? flags.roomsMin ?? flags.roomsmin}-`);
  }
  if (flags['area-min'] != null || flags.areaMin != null || flags.areamin != null) {
    qs.set('livingspace', `${flags['area-min'] ?? flags.areaMin ?? flags.areamin}-`);
  }

  // SPA updateResults: GET search URL with Accept application/json
  // (reactApp.js, captured 2026-08-09).
  const url = `${WWW}/Suche/region?${qs.toString()}`;
  const data = await apiFetch(tab, url, {
    headers: { Accept: 'application/json' },
  });

  if (flags.json) {
    cli.out({ geo, query: Object.fromEntries(qs), results: data });
    return;
  }

  // Shape varies: searchResponseModel / resultlist.resultlist / resultList / entries.
  const root = data?.searchResponseModel || data;
  const rl =
    root?.['resultlist.resultlist'] ||
    root?.resultlist ||
    root?.resultList ||
    root?.resultListModel ||
    data?.resultListModel ||
    data;
  const paging = rl?.paging || root?.paging || data?.paging || {};
  const numberOfHits = paging.numberOfHits ?? rl?.numberOfHits ?? root?.numberOfHits ?? data?.numberOfHits;
  const entriesRaw =
    rl?.resultlistEntries ||
    rl?.resultListEntries ||
    rl?.entries ||
    root?.resultlistEntries ||
    data?.resultlistEntries ||
    data?.entries ||
    [];

  // Entries may be [{ resultlistEntry: [...] }] (IS24 legacy envelope).
  let entries = [];
  if (Array.isArray(entriesRaw)) {
    for (const block of entriesRaw) {
      if (Array.isArray(block?.resultlistEntry)) entries.push(...block.resultlistEntry);
      else if (Array.isArray(block?.resultListEntry)) entries.push(...block.resultListEntry);
      else if (block?.['resultlist.realEstate'] || block?.realEstateId || block?.id || block?.['@id']) {
        entries.push(block);
      } else if (Array.isArray(block)) {
        entries.push(...block);
      }
    }
  }

  const label = geo.label || location;
  console.log('');
  console.log(
    color.bold(`  Search ${label}`) +
      color.dim(`  ${realEstateType} · page ${page}`) +
      (numberOfHits != null ? color.dim(` · ${numberOfHits} hits`) : ''),
  );
  console.log(color.dim(`  geo:${geo.id}${geo.geopath?.uri ? ' · ' + geo.geopath.uri : ''}`));
  console.log(color.dim('  ' + '─'.repeat(52)));

  if (!entries.length) {
    // Still useful: print top-level keys so --json isn't the only escape hatch.
    console.log(color.dim('  No listings parsed from response.'));
    console.log(color.dim('  Re-run with --json to inspect the raw payload.'));
    if (data && typeof data === 'object') {
      console.log(color.dim(`  Top-level keys: ${Object.keys(data).slice(0, 12).join(', ')}`));
    }
    console.log('');
    return;
  }

  let shown = 0;
  for (const entry of entries) {
    const re =
      entry?.['resultlist.realEstate'] ||
      entry?.realEstate ||
      entry?.['resultlistEntry'] ||
      entry;
    if (!re || typeof re !== 'object') continue;

    const id =
      re['@id'] ||
      re.realEstateId ||
      re.id ||
      entry.realEstateId ||
      entry['@id'] ||
      entry.id;
    const title = re.title || re.headline || entry.title || 'Listing';
    const addr = re.address || {};
    const addrLine = [addr.quarter, addr.city || addr.region, addr.postcode].filter(Boolean).join(', ') ||
      [addr.street, addr.houseNumber].filter(Boolean).join(' ');
    const priceObj = re.price || re.calculatedPrice || re.coldRent || re.warmRent || {};
    const priceVal = priceObj.value ?? priceObj.amount ?? re.priceValue ?? null;
    const rooms = re.numberOfRooms ?? re.rooms;
    const space = re.livingSpace ?? re.usableFloorSpace ?? re.area;
    const meta = [
      rooms != null ? `${rooms} Zi` : null,
      space != null ? `${space} m²` : null,
      priceVal != null ? money(priceVal) || String(priceVal) : null,
    ].filter(Boolean);

    console.log(`  ${color.cyan(color.bold(preview(title, 70)))}  ${color.dim(id != null ? `id:${id}` : '')}`);
    if (meta.length) console.log(`     ${meta.join('  ·  ')}`);
    if (addrLine) console.log(`     ${color.dim(addrLine)}`);
    shown++;
  }

  if (!shown) {
    console.log(color.dim('  Entries present but not in a recognized shape — use --json.'));
  }
  console.log('');
}

// ── main ───────────────────────────────────────────────────────────────────

async function main() {
  if (flags.help || flags.h || !subcommand || subcommand === 'help') {
    cli.help(HELP);
  }

  const tab = await getTab();

  try {
    if (subcommand === 'me' || subcommand === 'profile' || subcommand === 'whoami') {
      await cmdMe(tab, flags);
    } else if (subcommand === 'dashboard' || subcommand === 'dash' || subcommand === 'home') {
      await cmdDashboard(tab, flags);
    } else if (subcommand === 'listings' || subcommand === 'angebote' || subcommand === 'listing') {
      await cmdListings(tab, flags);
    } else if (subcommand === 'exposes' || subcommand === 'expose') {
      await cmdExposes(tab, flags);
    } else if (subcommand === 'conversations' || subcommand === 'inbox' || subcommand === 'nachrichten') {
      await cmdConversations(tab, positional[0], flags);
    } else if (subcommand === 'messages' || subcommand === 'thread' || subcommand === 'conversation') {
      await cmdMessages(tab, positional[0], positional[1], flags);
    } else if (subcommand === 'search' || subcommand === 'suche') {
      // location may be multiple words: search Berlin Mitte
      const loc = positional.length ? positional.join(' ') : '';
      await cmdSearch(tab, loc, flags);
    } else if (subcommand === 'geo' || subcommand === 'geoautocomplete' || subcommand === 'gac') {
      const q = positional.length ? positional.join(' ') : '';
      await cmdGeo(tab, q, flags);
    } else {
      cli.die(`unknown command: ${subcommand}\nRun 'immobilienscout24 --help' for usage.`, {
        prefix: 'immobilienscout24',
      });
    }
  } catch (err) {
    if (err?.name === 'NodeExitError') throw err;
    cli.die(err.message || String(err), { prefix: 'immobilienscout24' });
  }
}

await main();

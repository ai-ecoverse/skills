// smileys.jsh — Smiley's Pizza shop API (browser session)
//
// AUTH: cookies on shop.smileys.de / mein.smileys.de via sliccy:browser.
// GET via browser.fetch; POST/PUT via in-page eval (browser.fetch hangs on
// POST in this runtime — same as kleinanzeigen / IS24).
// Wire: references/endpoints.md (HAR rec-1790006577637-qkwv8m, 2026-09-21).

const browser = require('sliccy:browser');
const cli = require('sliccy:cli');

const PREFIX = 'smileys';
const API = 'https://shop.smileys.de/api/v1';
const WIDGET = '4.1.0';

const HELP = `
smileys — Smiley's Pizza shop API (browser session)

USAGE
  smileys stores
  smileys autocomplete <query>
  smileys groups <productId>
  smileys add <productId> --size large [--option group:item] [--qty N]
  smileys suggestions
  smileys delivery
  smileys checkout --firstname … --lastname … --email … --phone … --street … --number … --zip … --city …
                   preview only; add --confirm to start checkout and save the customer
  smileys --help

FLAGS
  --json           raw JSON
  --store <slug>   store (default: the /store/<slug> the shop tab is on)
  --size <name>    cart line size (e.g. large)
  --qty N          cart quantity, 1-20 (default 1)
  --option g:i     repeatable topping group:item (cpg_…:sp_…)
  --confirm        required for checkout to write (without it: a preview); put it last
  --resume         checkout: only save the customer (a previous run started checkout)

REQUIRES
  a shop.smileys.de tab open and logged in (log in on mein.smileys.de first)
`.trim();

const parsed = process.argv.parseFlags();
const subcommand = parsed.subcommand || parsed.positional[0] || '';
const positional = parsed.positional.slice(1);
const flags = parsed.flags;

// The store is the user's: --store, else the /store/<slug> the shop tab is on.
// Never a silent default -- a pizza added to the wrong store's cart is a real
// order in the wrong city (CLAUDE.md §7.4).
let _store = null;
async function storeSlug() {
  if (_store) return _store;
  const s = flags.store;
  if (s !== undefined && (typeof s !== 'string' || !/^[a-z0-9-]+$/i.test(s.trim()))) {
    cli.die('--store takes one store slug, e.g. --store potsdam', { prefix: PREFIX });
  }
  if (typeof s === 'string') {
    _store = s.trim();
    return _store;
  }
  const tab = await getTab();
  const m = /\/store\/([a-z0-9-]+)/i.exec(tab.url || '');
  if (!m) {
    cli.die(
      'which store? open a store page in the shop tab (shop.smileys.de/store/<slug>) or pass --store <slug>',
      { prefix: PREFIX }
    );
  }
  _store = m[1];
  return _store;
}

// Every call runs from a SHOP tab: the cart and checkout writes are credentialed
// in-page fetches to shop.smileys.de, and from a mein.smileys.de / www tab they
// would be cross-origin (the captured API is same-origin only).
let _tab = null;
async function getTab() {
  if (_tab) return _tab;
  _tab = await browser.findTab({ urlMatch: /^https:\/\/shop\.smileys\.de\//i });
  if (!_tab) {
    const other = await browser.findTab({ urlMatch: /^https:\/\/([a-z0-9-]+\.)?smileys\.de\//i });
    cli.die(
      other
        ? 'a smileys.de tab is open, but not the shop — open your store on https://shop.smileys.de in it (you stay logged in), then retry'
        : 'open https://shop.smileys.de and log in first',
      { prefix: PREFIX }
    );
  }
  return _tab;
}

function isHtmlBody(body) {
  if (typeof body !== 'string') return false;
  const s = body.slice(0, 200).trim().toLowerCase();
  return s.startsWith('<!doctype') || s.startsWith('<html');
}

function authExpired() {
  cli.die('session expired — log in to shop.smileys.de, then retry', { prefix: PREFIX });
}

function dieHttp(res, url) {
  const path = String(url).replace(/^https?:\/\/[^/]+/, '');
  cli.die(`Smiley's returned ${res.status} for ${path}`, { prefix: PREFIX });
}

function unwrap(body) {
  if (body && typeof body === 'object' && 'data' in body) return body.data;
  return body;
}

async function apiGet(tab, path) {
  const url = path.startsWith('http') ? path : `${API}${path}`;
  let res;
  try {
    res = await browser.fetch(tab, url, {
      headers: {
        Accept: 'application/json',
        'X-Widget-Version': WIDGET,
      },
    });
  } catch (err) {
    cli.die(`fetch failed for ${path}: ${err.message || err}`, { prefix: PREFIX });
  }
  if (res.status === 401 || res.status === 403) authExpired();
  if (!res.ok) dieHttp(res, url);
  if (isHtmlBody(res.body)) authExpired();
  return res.body;
}

async function apiWrite(tab, path, { method, body, contentType }) {
  if (typeof browser.evalAsync !== 'function') {
    throw new Error('browser.evalAsync is required for non-GET Smiley\'s calls');
  }
  const url = path.startsWith('http') ? path : `${API}${path}`;
  const ct = contentType || 'application/json';
  const bodyStr = body == null ? null : typeof body === 'string' ? body : JSON.stringify(body);
  const expr = `(async () => {
    const r = await fetch(${JSON.stringify(url)}, {
      method: ${JSON.stringify(method)},
      credentials: 'include',
      headers: {
        Accept: 'application/json',
        'X-Widget-Version': ${JSON.stringify(WIDGET)},
        ${bodyStr == null ? '' : `'Content-Type': ${JSON.stringify(ct)},`}
      },
      body: ${bodyStr == null ? 'undefined' : JSON.stringify(bodyStr)},
    }).catch((e) => ({ failed: String((e && e.message) || e) }));
    if (r.failed) return { ok: false, status: 0, failed: r.failed };
    const text = await r.text();
    const hdrs = {};
    r.headers.forEach((v, k) => { hdrs[k] = v; });
    let parsed = text;
    const c = (hdrs['content-type'] || '').toLowerCase();
    if (c.includes('json') || (text && (text[0] === '{' || text[0] === '['))) {
      try { parsed = JSON.parse(text); } catch { /* keep */ }
    }
    return { ok: r.ok, status: r.status, url: r.url, headers: hdrs, body: parsed };
  })()`;
  const out = await browser.evalAsync(tab, expr);
  if (!out || typeof out !== 'object') throw new Error('in-page fetch returned no result');
  // A rejected fetch here is almost always a redirect to the mein.smileys.de
  // login, which a credentialed cross-origin request cannot follow.
  if (out.failed) {
    cli.die(`${method} ${path} failed in the page (${out.failed}) — the session may have expired; log in to shop.smileys.de and retry`, { prefix: PREFIX });
  }
  if (out.status === 401 || out.status === 403) authExpired();
  if (!out.ok) dieHttp(out, url);
  if (isHtmlBody(out.body)) authExpired();
  return out.body;
}

function printCart(cart) {
  if (!cart || typeof cart !== 'object') {
    console.log('  (no cart)');
    return;
  }
  const items = Array.isArray(cart.items) ? cart.items : [];
  for (const it of items) {
    console.log(`  ${it.quantity || 1}× ${it.name || it.id}  ${it.total ?? it.price ?? ''}`);
  }
  if (cart.total != null) console.log(`  total ${cart.total}  delivery ${cart.delivery_costs ?? ''}  ${cart.method || ''}`);
}

async function cmdStores(flags) {
  const body = await apiGet(await getTab(), '/stores');
  if (flags.json) { cli.out(body); return; }
  const data = unwrap(body);
  const list = Array.isArray(data) ? data : Array.isArray(data?.stores) ? data.stores : null;
  if (!list) {
    cli.out(body);
    return;
  }
  for (const s of list) {
    const slug = s.slug || s.id || s.idx || '';
    const name = s.name || s.title || slug;
    console.log(`  ${name}  ${slug}`);
  }
}

async function cmdAutocomplete(positional, flags) {
  const q = positional.join(' ').trim();
  if (!q) cli.die('usage: smileys autocomplete <query>', { prefix: PREFIX });
  const body = await apiGet(await getTab(), `/service/autocomplete?query=${encodeURIComponent(q)}`);
  if (flags.json) { cli.out(body); return; }
  const data = unwrap(body);
  const list = Array.isArray(data) ? data : [];
  if (!list.length) { console.log('  (no matches)'); return; }
  for (const row of list) {
    const label = row.label || row.address || row.description || JSON.stringify(row);
    console.log(`  ${label}`);
  }
}

async function cmdGroups(positional, flags) {
  const id = positional[0];
  if (!id) cli.die('usage: smileys groups <productId>', { prefix: PREFIX });
  const store = await storeSlug();
  const body = await apiGet(await getTab(), `/store/${encodeURIComponent(store)}/products/${encodeURIComponent(id)}/groups`);
  if (flags.json) { cli.out(body); return; }
  const data = unwrap(body);
  const groups = Array.isArray(data) ? data : data?.groups || [];
  if (!groups.length) { cli.out(body); return; }
  for (const g of groups) {
    console.log(`  ${g.name || g.id || g.idx}  ${g.id || g.idx || ''}`);
    const opts = g.items || g.options || g.products || [];
    for (const o of opts) {
      console.log(`    ${o.id || o.item || ''}  ${o.name || ''}`);
    }
  }
}

const MAX_QTY = 20;

async function cmdAdd(positional, flags) {
  const id = positional[0];
  if (!id) cli.die('usage: smileys add <productId> --size <size> [--option group:item]', { prefix: PREFIX });
  const size = typeof flags.size === 'string' ? flags.size : '';
  if (!size) cli.die('pass --size (e.g. large)', { prefix: PREFIX });
  // A live cart write: refuse a quantity that is not plainly 1..MAX_QTY rather
  // than guess (parseInt('2x') is 2, a repeated --qty is an array).
  const rawQty = flags.qty ?? flags.quantity ?? '1';
  const qtyText = typeof rawQty === 'string' ? rawQty.trim() : '';
  const quantity = /^\d+$/.test(qtyText) ? Number(qtyText) : Number.NaN;
  if (!(quantity >= 1 && quantity <= MAX_QTY)) {
    cli.die(`--qty must be a whole number from 1 to ${MAX_QTY} (got ${JSON.stringify(rawQty)})`, { prefix: PREFIX });
  }
  const raw = flags.option ?? flags.options;
  const optList = raw == null ? [] : Array.isArray(raw) ? raw : [raw];
  const options = [];
  for (const spec of optList) {
    const s = String(spec);
    const i = s.indexOf(':');
    if (i < 1) cli.die(`--option must be group:item (got ${s})`, { prefix: PREFIX });
    options.push({ group: s.slice(0, i), item: s.slice(i + 1), amount: 1 });
  }
  const store = await storeSlug();
  const body = await apiWrite(await getTab(), `/store/${encodeURIComponent(store)}/cart/items`, {
    method: 'POST',
    body: { item: id, options, quantity, size },
  });
  if (flags.json) { cli.out(body); return; }
  console.log(`  ${body?.message || 'added'}  (store ${store})`);
  printCart(unwrap(body)?.cart);
}

async function cmdSuggestions(flags) {
  const body = await apiGet(await getTab(), '/enterprise/smileys/v1/cart-suggestions');
  if (flags.json) { cli.out(body); return; }
  const data = unwrap(body);
  const ids = Array.isArray(data) ? data : [];
  if (!ids.length) { console.log('  (none)'); return; }
  for (const id of ids) console.log(`  ${id}`);
}

async function cmdDelivery(flags) {
  const store = await storeSlug();
  const body = await apiGet(await getTab(), `/store/${encodeURIComponent(store)}/checkout/deliveryOptions`);
  if (flags.json) { cli.out(body); return; }
  const data = unwrap(body);
  const list = Array.isArray(data) ? data : Array.isArray(data?.options) ? data.options : null;
  if (!list) {
    console.log(`  delivery options for ${store}: ${JSON.stringify(data)}`);
    return;
  }
  if (!list.length) { console.log('  (no delivery options)'); return; }
  for (const o of list) {
    console.log(`  ${o.label || o.name || o.time || o.id || JSON.stringify(o)}`);
  }
}

async function cmdCheckout(flags) {
  const need = ['firstname', 'lastname', 'email', 'phone', 'street', 'number', 'zip', 'city'];
  const missing = need.filter((k) => typeof flags[k] !== 'string' || !flags[k].trim());
  if (missing.length) {
    cli.die(`checkout needs ${missing.map((k) => '--' + k).join(' ')}`, { prefix: PREFIX });
  }
  // Only a bare --confirm writes: --confirm=false / --confirm no are strings,
  // and a string here must never count as consent.
  const confirmed = flags.confirm === true;
  if (flags.confirm !== undefined && !confirmed) {
    cli.die(`--confirm takes no value (got ${JSON.stringify(flags.confirm)}); put it last`, { prefix: PREFIX });
  }
  const customer = {
    type: 'private',
    account_requested: false,
    company: null,
    salutation: null,
    firstname: flags.firstname.trim(),
    lastname: flags.lastname.trim(),
    email: flags.email.trim(),
    telephone_raw: flags.phone.trim(),
    street: flags.street.trim(),
    number: flags.number.trim(),
    zipcode: flags.zip.trim(),
    city: flags.city.trim(),
    extra: null,
  };
  const store = await storeSlug();
  const path = `/store/${encodeURIComponent(store)}/checkout`;
  const resume = flags.resume === true;
  const writes = resume ? [`PUT ${path}`] : [`POST ${path}`, `PUT ${path}`];
  if (!confirmed) {
    // The preview IS the validation step: nothing is sent until --confirm.
    if (flags.json) { cli.out({ preview: { store, customer, writes }, written: false }); return; }
    console.log(`  checkout preview for store ${store} — nothing written`);
    console.log(`  ${customer.firstname} ${customer.lastname} <${customer.email}> ${customer.telephone_raw}`);
    console.log(`  ${customer.street} ${customer.number}, ${customer.zipcode} ${customer.city}`);
    console.log(`  would send: ${writes.join(', ')}`);
    console.log('  re-run with --confirm (last) to write');
    return;
  }
  const tab = await getTab();
  // The captured flow (references/endpoints.md) starts checkout with POST, then
  // saves the customer with PUT; a fresh cart has no checkout to PUT into.
  // --resume skips the POST when a previous run started checkout but its PUT failed.
  if (!resume) {
    await apiWrite(tab, path, {
      method: 'POST',
      body: { customer: {}, shipping_time: null, message: null },
    });
  }
  let body;
  try {
    body = await apiWrite(tab, path, {
      method: 'PUT',
      body: { customer, shipping_time: null, message: null },
    });
  } catch (err) {
    if (err?.name !== 'NodeExitError') throw err;
    console.error(
      'smileys: checkout was started but the customer was not saved. Fix the flags, then re-run with --resume --confirm (PUT only, no second checkout).'
    );
    throw err;
  }
  if (flags.json) { cli.out(body); return; }
  console.log(`  checkout started and customer saved for store ${store} — verify with: smileys delivery`);
}

async function main() {
  if (flags.help || flags.h || !subcommand || subcommand === 'help') cli.help(HELP);
  try {
    // Each command checks its own arguments BEFORE it looks for the shop tab,
    // so a usage error is reported as one, open tab or not.
    if (subcommand === 'stores') await cmdStores(flags);
    else if (subcommand === 'autocomplete') await cmdAutocomplete(positional, flags);
    else if (subcommand === 'groups') await cmdGroups(positional, flags);
    else if (subcommand === 'add') await cmdAdd(positional, flags);
    else if (subcommand === 'suggestions') await cmdSuggestions(flags);
    else if (subcommand === 'delivery') await cmdDelivery(flags);
    else if (subcommand === 'checkout') await cmdCheckout(flags);
    else cli.die(`unknown command: ${subcommand}\nRun 'smileys --help' for usage.`, { prefix: PREFIX });
  } catch (err) {
    if (err?.name === 'NodeExitError') throw err;
    cli.die(err.message, { prefix: PREFIX });
  }
}
await main();

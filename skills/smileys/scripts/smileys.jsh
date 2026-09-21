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
  smileys checkout --confirm --firstname … --lastname … --email … --phone … --street … --number … --zip … --city …
  smileys --help

FLAGS
  --json           raw JSON
  --store <slug>   default potsdam
  --size <name>    cart line size (e.g. large)
  --qty N          cart quantity (default 1)
  --option g:i     repeatable topping group:item (cpg_…:sp_…)
  --confirm        required for checkout (writes the order customer)

REQUIRES
  shop.smileys.de (or mein.smileys.de) open and logged in
`.trim();

const parsed = process.argv.parseFlags();
const subcommand = parsed.subcommand || parsed.positional[0] || '';
const positional = parsed.subcommand
  ? parsed.positional.slice(1)
  : parsed.positional.slice(1);
const flags = parsed.flags;

function storeSlug() {
  const s = flags.store;
  return (typeof s === 'string' && s.trim()) ? s.trim() : 'potsdam';
}

let _tab = null;
async function getTab() {
  if (_tab) return _tab;
  _tab = await browser.findTab({ urlMatch: /smileys\.de/i });
  if (!_tab) {
    cli.die('open https://shop.smileys.de and log in first', { prefix: PREFIX });
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
    });
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
  if (out.status === 401 || out.status === 403) authExpired();
  if (!out.ok) dieHttp(out, url);
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

async function cmdStores(tab, flags) {
  const body = await apiGet(tab, '/stores');
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

async function cmdAutocomplete(tab, positional, flags) {
  const q = positional.join(' ').trim();
  if (!q) cli.die('usage: smileys autocomplete <query>', { prefix: PREFIX });
  const body = await apiGet(tab, `/service/autocomplete?query=${encodeURIComponent(q)}`);
  if (flags.json) { cli.out(body); return; }
  const data = unwrap(body);
  const list = Array.isArray(data) ? data : [];
  if (!list.length) { console.log('  (no matches)'); return; }
  for (const row of list) {
    const label = row.label || row.address || row.description || JSON.stringify(row);
    console.log(`  ${label}`);
  }
}

async function cmdGroups(tab, positional, flags) {
  const id = positional[0];
  if (!id) cli.die('usage: smileys groups <productId>', { prefix: PREFIX });
  const body = await apiGet(tab, `/store/${encodeURIComponent(storeSlug())}/products/${encodeURIComponent(id)}/groups`);
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

async function cmdAdd(tab, positional, flags) {
  const id = positional[0];
  if (!id) cli.die('usage: smileys add <productId> --size <size> [--option group:item]', { prefix: PREFIX });
  const size = typeof flags.size === 'string' ? flags.size : '';
  if (!size) cli.die('pass --size (e.g. large)', { prefix: PREFIX });
  const n = parseInt(flags.qty ?? flags.quantity ?? 1, 10);
  const quantity = Number.isFinite(n) && n > 0 ? n : 1;
  const raw = flags.option ?? flags.options;
  const optList = raw == null ? [] : Array.isArray(raw) ? raw : [raw];
  const options = [];
  for (const spec of optList) {
    const s = String(spec);
    const i = s.indexOf(':');
    if (i < 1) cli.die(`--option must be group:item (got ${s})`, { prefix: PREFIX });
    options.push({ group: s.slice(0, i), item: s.slice(i + 1), amount: 1 });
  }
  const body = await apiWrite(tab, `/store/${encodeURIComponent(storeSlug())}/cart/items`, {
    method: 'POST',
    body: { item: id, options, quantity, size },
  });
  if (flags.json) { cli.out(body); return; }
  console.log(`  ${body?.message || 'added'}`);
  printCart(body?.data?.cart || unwrap(body)?.cart);
}

async function cmdSuggestions(tab, flags) {
  const body = await apiGet(tab, '/enterprise/smileys/v1/cart-suggestions');
  if (flags.json) { cli.out(body); return; }
  const data = unwrap(body);
  const ids = Array.isArray(data) ? data : [];
  if (!ids.length) { console.log('  (none)'); return; }
  for (const id of ids) console.log(`  ${id}`);
}

async function cmdDelivery(tab, flags) {
  const body = await apiGet(tab, `/store/${encodeURIComponent(storeSlug())}/checkout/deliveryOptions`);
  if (flags.json) { cli.out(body); return; }
  cli.out(body);
}

async function cmdCheckout(tab, flags) {
  if (!flags.confirm) {
    cli.die('checkout writes the order — pass --confirm plus address flags', { prefix: PREFIX });
  }
  const need = ['firstname', 'lastname', 'email', 'phone', 'street', 'number', 'zip', 'city'];
  const missing = need.filter((k) => typeof flags[k] !== 'string' || !flags[k].trim());
  if (missing.length) {
    cli.die(`checkout needs ${missing.map((k) => '--' + k).join(' ')}`, { prefix: PREFIX });
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
  const body = await apiWrite(tab, `/store/${encodeURIComponent(storeSlug())}/checkout`, {
    method: 'PUT',
    body: { customer, shipping_time: null, message: null },
  });
  if (flags.json) { cli.out(body); return; }
  console.log('  checkout customer saved');
  cli.out(body);
}

async function main() {
  if (flags.help || flags.h || !subcommand || subcommand === 'help') cli.help(HELP);
  const tab = await getTab();
  try {
    if (subcommand === 'stores') await cmdStores(tab, flags);
    else if (subcommand === 'autocomplete') await cmdAutocomplete(tab, positional, flags);
    else if (subcommand === 'groups') await cmdGroups(tab, positional, flags);
    else if (subcommand === 'add') await cmdAdd(tab, positional, flags);
    else if (subcommand === 'suggestions') await cmdSuggestions(tab, flags);
    else if (subcommand === 'delivery') await cmdDelivery(tab, flags);
    else if (subcommand === 'checkout') await cmdCheckout(tab, flags);
    else cli.die(`unknown command: ${subcommand}\nRun 'smileys --help' for usage.`, { prefix: PREFIX });
  } catch (err) {
    if (err?.name === 'NodeExitError') throw err;
    cli.die(err.message, { prefix: PREFIX });
  }
}
await main();

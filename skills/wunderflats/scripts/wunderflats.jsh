// wunderflats.jsh — landlord dashboard client (browser session)
// Wire surface from /recordings/rec-1786282427974-u69xjx/ + live checks 2026-08-09.
// AUTH: session cookies only via sliccy:browser fetch inside a wunderflats.com tab.

const browser = require('sliccy:browser');
const cli = require('sliccy:cli');
const color = require('sliccy:color');
const fmt = require('sliccy:fmt');

const PREFIX = 'wunderflats';
const ORIGIN = 'https://wunderflats.com';
const OBJECT_ID_RE = /^[a-f0-9]{24}$/i;
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

const HELP = `
wunderflats — landlord dashboard client (uses browser session)

USAGE
  wunderflats me                              Landlord profile + billing summary
  wunderflats listings                        Your listings
  wunderflats listing [id]                    Listing detail
  wunderflats availability [id]               Blocks + bookings calendar summary
  wunderflats blocks [id]                     Manual calendar blocks
  wunderflats blocked-dates [id] [--from --to]
  wunderflats block-create [id] --from D --to D [--confirm]
  wunderflats block-delete <blockId> [--confirm]
  wunderflats bookings [id]                   Bookings for a listing
  wunderflats requests [id]                   Open/active listing requests
  wunderflats banks                           Bank accounts

FLAGS
  --json              Raw JSON output
  --listing <id>      Explicit listing id (overrides positional / tab URL)
  --from YYYY-MM-DD   Range start (blocked-dates, block-create)
  --to YYYY-MM-DD     Range end
  --confirm           Required for block-create / block-delete

REQUIRES
  wunderflats.com open and logged in as a landlord in your browser

NOTES
  Prices are integer cents (170000 → €1,700.00).
  Listing id is optional when the tab URL is /dashboard/l/<id>/...
`.trim();

// ── args ──────────────────────────────────────────────────────────────────
const parsed = process.argv.parseFlags();
const subcommand = parsed.subcommand || parsed.positional[0] || '';
const positional = parsed.subcommand
  ? parsed.positional.slice(1)
  : parsed.positional.slice(1);
const flags = parsed.flags;

// ── session ───────────────────────────────────────────────────────────────
let _tab = null;

async function getTab() {
  if (_tab) return _tab;
  _tab = await browser.findTab({ urlMatch: /wunderflats\.com/i });
  if (!_tab) {
    cli.die('open wunderflats.com (logged in as landlord) in your browser first', { prefix: PREFIX });
  }
  return _tab;
}

function authExpired() {
  cli.die('session expired — log in to wunderflats.com in your browser, then retry', { prefix: PREFIX });
}

async function apiFetch(tab, path, opts = {}) {
  const url = path.startsWith('http') ? path : `${ORIGIN}${path}`;
  const headers = {
    Accept: 'application/json, text/plain, */*',
    ...(opts.body ? { 'Content-Type': 'application/json' } : {}),
    ...(opts.headers || {}),
  };
  const fetchOpts = { method: opts.method || 'GET', headers };
  if (opts.body !== undefined) {
    fetchOpts.body = typeof opts.body === 'string' ? opts.body : JSON.stringify(opts.body);
  }
  const res = await browser.fetch(tab, url, fetchOpts);

  if (res.status === 401 || res.status === 403) authExpired();

  // GraphQL transport can still be HTTP 200 with auth errors in body
  const body = res.body;
  if (body && typeof body === 'object') {
    const errs = collectGraphqlErrors(body);
    if (errs.some((m) => /unauthenticated|not authorized|authenticationrequired/i.test(m))) {
      authExpired();
    }
  }

  if (!res.ok) {
    const detail = typeof body === 'string'
      ? body.slice(0, 200)
      : (body && JSON.stringify(body).slice(0, 200)) || '';
    cli.die(`wunderflats returned ${res.status} for ${path}${detail ? `: ${detail}` : ''}`, { prefix: PREFIX });
  }
  return body;
}

function collectGraphqlErrors(body) {
  const out = [];
  const scan = (node) => {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) {
      for (const n of node) scan(n);
      return;
    }
    if (Array.isArray(node.errors)) {
      for (const e of node.errors) {
        if (e && e.message) out.push(String(e.message));
        if (e && e.extensions && e.extensions.code) out.push(String(e.extensions.code));
      }
    }
  };
  scan(body);
  return out;
}

function unwrapGraphql(body) {
  // Batch array → first element's data; single → data
  if (Array.isArray(body)) {
    const first = body[0];
    if (first && first.errors && first.errors.length) {
      const msg = first.errors.map((e) => e.message).join('; ');
      cli.die(`graphql error: ${msg}`, { prefix: PREFIX });
    }
    return first && first.data;
  }
  if (body && body.errors && body.errors.length) {
    const msg = body.errors.map((e) => e.message).join('; ');
    cli.die(`graphql error: ${msg}`, { prefix: PREFIX });
  }
  return body && body.data;
}

async function gql(tab, query, variables, { batch = true, nexus = false } = {}) {
  const path = nexus ? '/api/nexus' : batch ? '/api/graphql/api/graphql' : '/api/graphql';
  const payload = nexus || !batch
    ? (variables ? { query, variables } : { query })
    : [variables ? { query, variables } : { query }];
  const body = await apiFetch(tab, path, { method: 'POST', body: payload });
  return unwrapGraphql(body);
}

// ── id / date helpers ─────────────────────────────────────────────────────

function requireObjectId(id, what) {
  if (!id || !OBJECT_ID_RE.test(id)) {
    cli.die(`invalid ${what || 'id'}: expected 24-char hex ObjectId`, { prefix: PREFIX });
  }
  return id.toLowerCase();
}

function requireIsoDate(value, flagName) {
  if (!value || !ISO_DATE_RE.test(String(value))) {
    cli.die(`${flagName} must be YYYY-MM-DD`, { prefix: PREFIX });
  }
  return String(value);
}

async function listingIdFromTab(tab) {
  // Prefer live tab URL (may have navigated since findTab)
  let href = '';
  try {
    const got = await browser.eval(tab, () => location.href);
    href = typeof got === 'string' ? got : (tab && tab.url) || '';
  } catch {
    href = (tab && tab.url) || '';
  }
  const m = String(href).match(/\/dashboard\/l\/([a-f0-9]{24})/i);
  return m ? m[1].toLowerCase() : null;
}

async function resolveListingId(tab, positionalId) {
  const fromFlag = flags.listing || flags.l;
  const raw = fromFlag || positionalId || (await listingIdFromTab(tab));
  if (!raw) {
    cli.die('listing id required — pass it, use --listing, or open a listing tab (/dashboard/l/<id>/...)', {
      prefix: PREFIX,
    });
  }
  return requireObjectId(raw, 'listing id');
}

function todayIso() {
  const d = new Date();
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function plusYearsIso(years) {
  const d = new Date();
  d.setUTCFullYear(d.getUTCFullYear() + years);
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function formatMoney(cents, currency = 'EUR') {
  if (cents == null || cents === '') return color.dim('—');
  const n = Number(cents);
  if (!Number.isFinite(n)) return String(cents);
  const major = n / 100;
  try {
    return new Intl.NumberFormat('en-IE', { style: 'currency', currency: currency || 'EUR' }).format(major);
  } catch {
    return `${currency || 'EUR'} ${major.toFixed(2)}`;
  }
}

function formatDay(iso) {
  if (!iso) return color.dim('—');
  // Accept full timestamps; show date part
  const day = String(iso).slice(0, 10);
  return day;
}

function localized(field, lang = 'en') {
  if (field == null) return '';
  if (typeof field === 'string') return field;
  if (typeof field === 'object') {
    return field[lang] || field.en || field.de || Object.values(field).find((v) => v) || '';
  }
  return String(field);
}

function addressLine(addr) {
  if (!addr) return '';
  const street = [addr.street, addr.streetNumber].filter(Boolean).join(' ');
  const city = [addr.zipCode, addr.city].filter(Boolean).join(' ');
  return [street, city, addr.country].filter(Boolean).join(', ');
}

// ── GraphQL documents ─────────────────────────────────────────────────────

const Q_LISTINGS = `
query GetLandlordListings {
  landlordListings {
    nodes {
      __typename
      ... on LandlordListing {
        _id
        apartmentName
        published
        price
        currency
        groupId
        landlord
        title { en de }
        address { street streetNumber zipCode city country }
      }
    }
  }
}`.trim();

const Q_LISTING = `
query GetActiveListing($listingId: ObjectId) {
  activeListing: landlordListingById(_id: $listingId) {
    _id
    apartmentName
    published
    price
    currency
    deposit
    area
    rooms
    beds
    floor
    accommodates
    minBookingDuration
    maxBookingDuration
    availableFrom
    lastPublishedAt
    groupId
    landlord
    homeType
    title { en de }
    descriptionV2 { en de }
    address { street streetNumber zipCode city country }
  }
}`.trim();

const Q_BOOKINGS = `
query GetBookingsByListingId($listingId: ObjectId!) {
  landlordBookingsByListingId(listingId: $listingId) {
    nodes {
      _id
      selectedContract
      canceled
      from
      to
      type
      price
      reasonForStay
      createdAt
      tenantNames
      tenant {
        firstName
        lastName
        companyName
        jobTitle
        email
        phone
      }
      duration { months days }
      cost { totalCost }
      listingRequest {
        id
        userFriendlyId
        landlordStatus
        adults
        children
      }
      listing {
        _id
        apartmentName
        currency
      }
    }
  }
}`.trim();

const Q_REQUESTS = `
query GetListingRequestsForListing($listingId: ObjectId, $groupId: ID) {
  landlordListingRequests(
    listing: $listingId
    group: $groupId
    landlordStatusFilters: [
      OPEN
      OPEN_V3
      TENANT_VERIFICATION
      CONTRACT_CREATED
      CONTRACT_WAITING_FOR_TENANT
      MANUAL_CONTRACT_CREATED
      ACCEPTED
      BLOCKED_BY_CURRENT_TENANT
      BLOCKED_BY_ANOTHER_TENANT
      OPEN_WITH_CONSEQUENCES
      TENANT_STARTED_OTHER_BOOKING_PROCESS
      WAITING_TO_CONFIRM_BOOKING
    ]
  ) {
    nodes {
      id
      userFriendlyId
      from
      to
      landlordStatus
      reasonForStay
      adults
      children
      pets
      viewedByLandlord
      autoDeclineAt
      type
      tenantInformation { firstName lastName }
      work { companyName jobTitle }
      duration { days months }
      tenantPayments { totalRent }
      latestBookingOffer { _id status price }
      listing {
        _id
        apartmentName
        price
        currency
        address { street streetNumber }
      }
      status {
        type
        data { reason subReason }
      }
    }
  }
}`.trim();

const Q_ME = `
query GetUserDetails {
  me {
    generatingRevenueUnderDac7Since
    landlordNumberOfUnpaidInvoices
    billingDetailsListLink {
      id
      productUser
      firstName
      lastName
      isExempt
      isCompliant
      dac7Compliance {
        exemptionStatus
        exemptionDeadline
        exemptionReason
      }
      address {
        addressLine1
        addressLine2
        city
        country
        zipCode
      }
      billingAddress {
        firstName
        lastName
        companyName
        addressLine1
        addressLine2
        city
        country
        zipCode
      }
      commercialFields {
        type
        companyName
        vatID
      }
    }
  }
}`.trim();

// ── commands ──────────────────────────────────────────────────────────────

async function cmdMe(tab, flags) {
  const data = await gql(tab, Q_ME, undefined, { nexus: true });
  const me = data && data.me;
  if (flags.json) { cli.out(me || data); return; }
  if (!me) {
    console.log(color.dim('  No profile data.'));
    return;
  }

  const bill = (me.billingDetailsListLink && me.billingDetailsListLink[0]) || {};
  const name = [bill.firstName, bill.lastName].filter(Boolean).join(' ') || 'Landlord';
  console.log('');
  console.log(`  ${color.cyan(color.bold(name))}`);
  if (bill.productUser) console.log(`  ${color.dim('User id:')}     ${bill.productUser}`);
  if (bill.id) console.log(`  ${color.dim('Billing id:')}  ${bill.id}`);
  if (bill.address) console.log(`  ${color.dim('Address:')}     ${[
    bill.address.addressLine1,
    bill.address.addressLine2,
    [bill.address.zipCode, bill.address.city].filter(Boolean).join(' '),
    bill.address.country,
  ].filter(Boolean).join(', ')}`);
  console.log(`  ${color.dim('Compliant:')}   ${bill.isCompliant ? color.green('yes') : color.yellow('no')}`);
  if (me.landlordNumberOfUnpaidInvoices != null) {
    const n = me.landlordNumberOfUnpaidInvoices;
    console.log(`  ${color.dim('Unpaid inv:')}  ${n === 0 ? color.green('0') : color.yellow(String(n))}`);
  }
  if (me.generatingRevenueUnderDac7Since) {
    console.log(`  ${color.dim('DAC7 since:')}  ${me.generatingRevenueUnderDac7Since}`);
  }
  if (bill.dac7Compliance) {
    console.log(`  ${color.dim('DAC7:')}        ${bill.dac7Compliance.exemptionStatus || '—'}`);
  }
  console.log('');
}

async function cmdListings(tab, flags) {
  const data = await gql(tab, Q_LISTINGS);
  const nodes = (data && data.landlordListings && data.landlordListings.nodes) || [];
  const listings = nodes.filter((n) => n && (n.__typename === 'LandlordListing' || n._id));
  if (flags.json) { cli.out(listings); return; }

  console.log('');
  console.log(color.bold('  Listings') + color.dim(`  (${listings.length})`));
  console.log(color.dim('  ' + '─'.repeat(52)));
  if (!listings.length) {
    console.log(color.dim('  No listings found.'));
    console.log('');
    return;
  }
  for (const L of listings) {
    const title = localized(L.title) || L.apartmentName || 'Listing';
    const pub = L.published ? color.green('published') : color.yellow('unpublished');
    console.log(`  ${color.cyan(color.bold(title))}`);
    console.log(`     ${color.dim('id:')} ${L._id}  ·  ${pub}  ·  ${formatMoney(L.price, L.currency)}`);
    if (L.apartmentName) console.log(`     ${color.dim(L.apartmentName)}`);
    const addr = addressLine(L.address);
    if (addr) console.log(`     ${addr}`);
    console.log('');
  }
}

async function cmdListing(tab, positional, flags) {
  const id = await resolveListingId(tab, positional[0]);
  // Prefer REST full document (richer); fall back to graphql
  let listing;
  try {
    const rest = await apiFetch(tab, `/api/listings/${id}`);
    listing = (rest && rest.listing) || rest;
  } catch (err) {
    if (err?.name === 'NodeExitError') throw err;
    const data = await gql(tab, Q_LISTING, { listingId: id });
    listing = data && data.activeListing;
  }
  if (flags.json) { cli.out(listing); return; }
  if (!listing) {
    console.log(color.dim('  Listing not found.'));
    return;
  }

  const title = localized(listing.title) || listing.apartmentName || 'Listing';
  const cur = listing.currency || 'EUR';
  console.log('');
  console.log(`  ${color.cyan(color.bold(title))}`);
  console.log(color.dim('  ' + '─'.repeat(52)));
  console.log(`  ${color.dim('ID:')}          ${listing._id || id}`);
  if (listing.apartmentName) console.log(`  ${color.dim('Unit:')}        ${listing.apartmentName}`);
  console.log(`  ${color.dim('Status:')}      ${listing.published ? color.green('published') : color.yellow('unpublished')}`);
  console.log(`  ${color.dim('Price:')}       ${formatMoney(listing.price, cur)} / month`);
  if (listing.deposit != null) console.log(`  ${color.dim('Deposit:')}     ${formatMoney(listing.deposit, cur)}`);
  const bits = [];
  if (listing.area != null) bits.push(`${listing.area} m²`);
  if (listing.rooms != null) bits.push(`${listing.rooms} rooms`);
  if (listing.beds != null) bits.push(`${listing.beds} beds`);
  if (listing.floor != null) bits.push(`floor ${listing.floor}`);
  if (listing.accommodates != null) bits.push(`sleeps ${listing.accommodates}`);
  if (bits.length) console.log(`  ${color.dim('Space:')}       ${bits.join(' · ')}`);
  const addr = addressLine(listing.address);
  if (addr) console.log(`  ${color.dim('Address:')}     ${addr}`);
  if (listing.minBookingDuration != null) {
    console.log(`  ${color.dim('Min stay:')}    ${listing.minBookingDuration} month(s)`);
  }
  if (listing.availableFrom) console.log(`  ${color.dim('Available:')}   ${formatDay(listing.availableFrom)}`);
  if (listing.groupId) console.log(`  ${color.dim('Group:')}       ${listing.groupId}`);
  const landlord = typeof listing.landlord === 'object' ? listing.landlord._id : listing.landlord;
  if (landlord) console.log(`  ${color.dim('Landlord:')}    ${landlord}`);
  const desc = localized(listing.descriptionV2);
  if (desc) {
    console.log(`  ${color.dim('About:')}       ${fmt.trunc(desc.replace(/\s+/g, ' '), 160)}`);
  }
  console.log('');
}

async function cmdBlocks(tab, positional, flags) {
  const id = await resolveListingId(tab, positional[0]);
  const data = await apiFetch(tab, `/api/listings/${id}/blocks`);
  const items = (data && data.items) || (Array.isArray(data) ? data : []);
  if (flags.json) { cli.out(items); return; }

  console.log('');
  console.log(color.bold('  Blocks') + color.dim(`  listing ${id}  ·  ${items.length}`));
  console.log(color.dim('  ' + '─'.repeat(52)));
  if (!items.length) {
    console.log(color.dim('  No manual blocks.'));
    console.log('');
    return;
  }
  for (const b of items) {
    console.log(`  ${color.cyan(formatDay(b.from))} → ${color.cyan(formatDay(b.to))}  ${color.dim(`id:${b._id}`)}`);
    const meta = [b.source, b.blocksEntireGroup ? 'entire-group' : null].filter(Boolean).join(' · ');
    if (meta) console.log(`     ${color.dim(meta)}`);
  }
  console.log('');
}

async function cmdBlockedDates(tab, positional, flags) {
  const id = await resolveListingId(tab, positional[0]);
  const from = flags.from ? requireIsoDate(flags.from, '--from') : todayIso();
  const to = flags.to ? requireIsoDate(flags.to, '--to') : plusYearsIso(2);
  const q = `from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`;
  const data = await apiFetch(tab, `/api/listings/${id}/blocked-dates?${q}`);
  const items = (data && data.items) || [];
  if (flags.json) { cli.out({ from, to, items }); return; }

  console.log('');
  console.log(color.bold('  Blocked dates') + color.dim(`  ${from} → ${to}  ·  ${items.length}`));
  console.log(color.dim('  ' + '─'.repeat(52)));
  if (!items.length) {
    console.log(color.dim('  Nothing blocked in range.'));
    console.log('');
    return;
  }
  for (const it of items) {
    const type = it.type || 'Unknown';
    const tag = type === 'Booking' ? color.green(type) : type === 'Block' ? color.yellow(type) : color.gray(type);
    console.log(`  ${tag}  ${color.cyan(formatDay(it.from))} → ${color.cyan(formatDay(it.to))}  ${color.dim(`id:${it._id || '—'}`)}`);
  }
  console.log('');
}

async function cmdAvailability(tab, positional, flags) {
  const id = await resolveListingId(tab, positional[0]);
  const from = flags.from ? requireIsoDate(flags.from, '--from') : todayIso();
  const to = flags.to ? requireIsoDate(flags.to, '--to') : plusYearsIso(2);
  const q = `from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`;

  const [blocksBody, datesBody, bookingsData] = await Promise.all([
    apiFetch(tab, `/api/listings/${id}/blocks`),
    apiFetch(tab, `/api/listings/${id}/blocked-dates?${q}`),
    gql(tab, Q_BOOKINGS, { listingId: id }, { batch: false }),
  ]);

  const blocks = (blocksBody && blocksBody.items) || [];
  const dates = (datesBody && datesBody.items) || [];
  const bookings = (bookingsData && bookingsData.landlordBookingsByListingId && bookingsData.landlordBookingsByListingId.nodes) || [];

  if (flags.json) {
    cli.out({ listingId: id, from, to, blocks, blockedDates: dates, bookings });
    return;
  }

  console.log('');
  console.log(color.bold('  Availability') + color.dim(`  listing ${id}`));
  console.log(color.dim(`  range ${from} → ${to}`));
  console.log(color.dim('  ' + '─'.repeat(52)));

  const activeBookings = bookings.filter((b) => !b.canceled);
  console.log(`  ${color.dim('Bookings:')}  ${color.bold(String(activeBookings.length))} active / ${bookings.length} total`);
  for (const b of activeBookings) {
    const who = (b.tenantNames && b.tenantNames.join(', '))
      || [b.tenant && b.tenant.firstName, b.tenant && b.tenant.lastName].filter(Boolean).join(' ')
      || 'Tenant';
    console.log(`     ${color.green('Booking')}  ${formatDay(b.from)} → ${formatDay(b.to)}  ${color.cyan(who)}  ${color.dim(`id:${b._id}`)}`);
  }

  console.log(`  ${color.dim('Blocks:')}    ${color.bold(String(blocks.length))}`);
  for (const b of blocks) {
    console.log(`     ${color.yellow('Block')}    ${formatDay(b.from)} → ${formatDay(b.to)}  ${color.dim(`id:${b._id}`)}`);
  }

  const other = dates.filter((d) => d.type && d.type !== 'Block' && d.type !== 'Booking');
  if (other.length) {
    console.log(`  ${color.dim('Other:')}     ${other.length}`);
    for (const d of other) {
      console.log(`     ${color.gray(d.type)}  ${formatDay(d.from)} → ${formatDay(d.to)}`);
    }
  }
  console.log('');
}

async function cmdBlockCreate(tab, positional, flags) {
  const id = await resolveListingId(tab, positional[0]);
  const from = requireIsoDate(flags.from, '--from');
  const to = requireIsoDate(flags.to, '--to');
  if (from > to) cli.die('--from must be on or before --to', { prefix: PREFIX });

  if (!flags.confirm) {
    console.log('');
    console.log(color.bold('  Preview block-create') + color.dim('  (pass --confirm to apply)'));
    console.log(color.dim('  ' + '─'.repeat(52)));
    console.log(`  ${color.dim('Listing:')}  ${id}`);
    console.log(`  ${color.dim('From:')}     ${from}`);
    console.log(`  ${color.dim('To:')}       ${to}`);
    console.log('');
    console.log(`  ${color.yellow('Dry run only.')} Re-run with --confirm to create the block:`);
    console.log(color.dim(`  wunderflats block-create ${id} --from ${from} --to ${to} --confirm`));
    console.log('');
    return;
  }

  const data = await apiFetch(tab, `/api/listings/${id}/blocks`, {
    method: 'POST',
    body: { from, to },
  });
  if (flags.json) { cli.out(data); return; }

  const b = (data && data.block) || data;
  console.log('');
  console.log(`  ${color.green('✓')} Block created`);
  console.log(`  ${color.dim('ID:')}     ${b._id || '—'}`);
  console.log(`  ${color.dim('Range:')}  ${formatDay(b.from || from)} → ${formatDay(b.to || to)}`);
  console.log('');
}

async function cmdBlockDelete(tab, positional, flags) {
  const blockId = positional[0];
  if (!blockId) cli.die('usage: wunderflats block-delete <blockId> [--confirm]', { prefix: PREFIX });
  requireObjectId(blockId, 'block id');

  if (!flags.confirm) {
    console.log('');
    console.log(color.bold('  Preview block-delete') + color.dim('  (pass --confirm to apply)'));
    console.log(color.dim('  ' + '─'.repeat(52)));
    console.log(`  ${color.dim('Block:')}  ${blockId}`);
    console.log('');
    console.log(`  ${color.yellow('Dry run only.')} Re-run with --confirm to delete:`);
    console.log(color.dim(`  wunderflats block-delete ${blockId} --confirm`));
    console.log('');
    return;
  }

  const data = await apiFetch(tab, `/api/blocks/${blockId}`, { method: 'DELETE' });
  if (flags.json) { cli.out(data || { ok: true, deleted: blockId }); return; }
  console.log('');
  console.log(`  ${color.green('✓')} Block ${blockId} deleted`);
  console.log('');
}

async function cmdBookings(tab, positional, flags) {
  const id = await resolveListingId(tab, positional[0]);
  const data = await gql(tab, Q_BOOKINGS, { listingId: id }, { batch: false });
  const nodes = (data && data.landlordBookingsByListingId && data.landlordBookingsByListingId.nodes) || [];
  if (flags.json) { cli.out(nodes); return; }

  console.log('');
  console.log(color.bold('  Bookings') + color.dim(`  listing ${id}  ·  ${nodes.length}`));
  console.log(color.dim('  ' + '─'.repeat(52)));
  if (!nodes.length) {
    console.log(color.dim('  No bookings.'));
    console.log('');
    return;
  }
  for (const b of nodes) {
    const who = (b.tenantNames && b.tenantNames.join(', '))
      || [b.tenant && b.tenant.firstName, b.tenant && b.tenant.lastName].filter(Boolean).join(' ')
      || 'Tenant';
    const status = b.canceled ? color.red('canceled') : color.green('active');
    const cur = (b.listing && b.listing.currency) || 'EUR';
    console.log(`  ${color.cyan(color.bold(who))}  ${status}`);
    console.log(`     ${formatDay(b.from)} → ${formatDay(b.to)}  ·  ${formatMoney(b.price, cur)}/mo`);
    if (b.tenant && b.tenant.companyName) console.log(`     ${color.dim(b.tenant.companyName)}${b.tenant.jobTitle ? ' · ' + b.tenant.jobTitle : ''}`);
    if (b.tenant && b.tenant.email) console.log(`     ${color.dim(b.tenant.email)}${b.tenant.phone ? ' · ' + b.tenant.phone : ''}`);
    const req = b.listingRequest && b.listingRequest.userFriendlyId;
    console.log(`     ${color.dim(`id:${b._id}`)}${req ? color.dim(`  ·  req:${req}`) : ''}`);
    console.log('');
  }
}

async function cmdRequests(tab, positional, flags) {
  const id = await resolveListingId(tab, positional[0]);
  const data = await gql(tab, Q_REQUESTS, { listingId: id });
  const nodes = (data && data.landlordListingRequests && data.landlordListingRequests.nodes) || [];
  if (flags.json) { cli.out(nodes); return; }

  console.log('');
  console.log(color.bold('  Requests') + color.dim(`  listing ${id}  ·  ${nodes.length}`));
  console.log(color.dim('  ' + '─'.repeat(52)));
  if (!nodes.length) {
    console.log(color.dim('  No open/active requests.'));
    console.log('');
    return;
  }
  for (const r of nodes) {
    const who = [r.tenantInformation && r.tenantInformation.firstName, r.tenantInformation && r.tenantInformation.lastName]
      .filter(Boolean).join(' ') || 'Tenant';
    const cur = (r.listing && r.listing.currency) || 'EUR';
    console.log(`  ${color.cyan(color.bold(who))}  ${color.dim(r.userFriendlyId || r.id || '')}`);
    console.log(`     ${formatDay(r.from)} → ${formatDay(r.to)}  ·  ${r.landlordStatus || (r.status && r.status.type) || '—'}`);
    if (r.work && r.work.companyName) console.log(`     ${color.dim(r.work.companyName)}${r.work.jobTitle ? ' · ' + r.work.jobTitle : ''}`);
    const rent = r.tenantPayments && r.tenantPayments.totalRent;
    if (rent != null) console.log(`     ${color.dim('rent:')} ${formatMoney(rent, cur)}`);
    console.log(`     ${color.dim(`id:${r.id}`)}`);
    console.log('');
  }
}

async function resolveUserId(tab) {
  const data = await gql(tab, Q_ME, undefined, { nexus: true });
  const me = data && data.me;
  const bill = me && me.billingDetailsListLink && me.billingDetailsListLink[0];
  if (bill && bill.productUser) return bill.productUser;
  // Fallback: first listing's landlord
  const listingsData = await gql(tab, Q_LISTINGS);
  const nodes = (listingsData && listingsData.landlordListings && listingsData.landlordListings.nodes) || [];
  const first = nodes.find((n) => n && n.landlord);
  if (first && first.landlord) {
    return typeof first.landlord === 'object' ? first.landlord._id : first.landlord;
  }
  cli.die('could not determine landlord user id from session', { prefix: PREFIX });
}

async function cmdBanks(tab, flags) {
  const userId = await resolveUserId(tab);
  const data = await apiFetch(tab, `/api/users/${userId}/bank-accounts`);
  const accounts = (data && data.bankAccounts) || [];
  if (flags.json) { cli.out(accounts); return; }

  console.log('');
  console.log(color.bold('  Bank accounts') + color.dim(`  user ${userId}  ·  ${accounts.length}`));
  console.log(color.dim('  ' + '─'.repeat(52)));
  if (!accounts.length) {
    console.log(color.dim('  No bank accounts.'));
    console.log('');
    return;
  }
  for (const a of accounts) {
    const label = a.ownerName || 'Account';
    const def = a.default ? color.green('default') : color.dim('—');
    console.log(`  ${color.cyan(color.bold(label))}  ${def}`);
    if (a.iban) console.log(`     ${color.dim('IBAN:')} ${a.iban}`);
    if (a.bic) console.log(`     ${color.dim('BIC:')}  ${a.bic}`);
    if (a.accountType) console.log(`     ${color.dim('Type:')} ${a.accountType}`);
    const ca = a.connectedAccount;
    if (ca) console.log(`     ${color.dim('Payout:')} ${(ca.provider || '—')}${ca.status ? ' ' + ca.status : ''}`);
    console.log(`     ${color.dim(`id:${a._id}`)}`);
    console.log('');
  }
}

// ── main ──────────────────────────────────────────────────────────────────

async function main() {
  if (flags.help || flags.h || !subcommand || subcommand === 'help') {
    cli.help(HELP);
  }

  const tab = await getTab();
  const cmd = subcommand;

  try {
    if (cmd === 'me' || cmd === 'whoami' || cmd === 'profile') await cmdMe(tab, flags);
    else if (cmd === 'listings' || cmd === 'list') await cmdListings(tab, flags);
    else if (cmd === 'listing' || cmd === 'get' || cmd === 'show') await cmdListing(tab, positional, flags);
    else if (cmd === 'availability' || cmd === 'calendar' || cmd === 'avail') await cmdAvailability(tab, positional, flags);
    else if (cmd === 'blocks') await cmdBlocks(tab, positional, flags);
    else if (cmd === 'blocked-dates' || cmd === 'blocked' || cmd === 'dates') await cmdBlockedDates(tab, positional, flags);
    else if (cmd === 'block-create' || cmd === 'block' || cmd === 'create-block') await cmdBlockCreate(tab, positional, flags);
    else if (cmd === 'block-delete' || cmd === 'unblock' || cmd === 'delete-block') await cmdBlockDelete(tab, positional, flags);
    else if (cmd === 'bookings' || cmd === 'booking') await cmdBookings(tab, positional, flags);
    else if (cmd === 'requests' || cmd === 'request') await cmdRequests(tab, positional, flags);
    else if (cmd === 'banks' || cmd === 'bank' || cmd === 'bank-accounts') await cmdBanks(tab, flags);
    else cli.die(`unknown command: ${cmd}\nRun 'wunderflats --help' for usage.`, { prefix: PREFIX });
  } catch (err) {
    if (err?.name === 'NodeExitError') throw err;
    cli.die(err.message || String(err), { prefix: PREFIX });
  }
}

await main();

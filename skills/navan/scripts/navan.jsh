// navan.jsh — Navan (formerly TripActions) corporate-travel API client
// Generated via the secret-sauce skill from a recorded Berlin->Basel booking.
//
// AUTH: Navan's backend is at https://app.navan.com/api/... Every /api/ request
// needs two headers that SLICC's own fetch() cannot carry:
//   Authorization: TripActions <JWT>      (literal scheme word "TripActions")
//   x-tripactions-locale: en-US
// So ALL calls run INSIDE the logged-in Navan browser tab via the
// `sliccy:browser` bridge's `evalAsync` (the page scripts are async IIFEs
// that `await fetch(...)`, so the synchronous `browser.eval` is not usable
// here — it does not await a returned Promise). The JWT is the Auth0
// access_token stored in the tab's localStorage under a key starting with
// "@@auth0spajs@@". If it is not there we fall back to intercepting the
// Authorization header off the app's own XHR/fetch traffic. On 401/403 we
// tell the user to re-log-in.
//
// BOOKING SAFETY: `navan book` spends real money. Without --confirm it only
// prices the itinerary and prints a gate message; it never books.

const browser = require('sliccy:browser'); // page-context CDP bridge (replaces playwright-cli eval-file)
const fs = require('fs'); // VFS bridge (writeFileBinary for the invoice PDF download)

const APP_HOST  = 'app.navan.com';
const TRIPS_URL = 'https://app.navan.com/app/user2/trips';
const LOCALE    = 'en-US';

// ----------------- tab management -----------------
let _tabId = null;
async function ensureTab() {
  if (_tabId) return _tabId;
  const tab = await browser.findTab({ urlMatch: /navan\.com/i });
  if (!tab) {
    console.error('No Navan tab found. Open ' + TRIPS_URL + ' in the browser and log in, then retry.');
    process.exit(2);
  }
  _tabId = tab;
  return _tabId;
}

// ----------------- page-context API caller -----------------
// Builds a self-contained in-page async script that (1) extracts the JWT,
// (2) runs the fetch with the TripActions Authorization header, (3) returns
// the result directly (NOT JSON.stringify'd — browser.evalAsync serializes
// the returned value on its own, and pre-stringifying here would make the
// Node side have to guess whether it got a string or an already-parsed
// value back; returning the raw object avoids the ambiguity entirely).
function buildScript(method, path, bodyStr) {
  return `
(async () => {
  function findToken() {
    // 1) Auth0 SPA cache in localStorage
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k && k.indexOf('@@auth0spajs@@') === 0) {
        try { const v = JSON.parse(localStorage.getItem(k));
          if (v && v.body && v.body.access_token) return v.body.access_token; } catch (e) {}
      }
    }
    // 2) any localStorage value carrying an access_token
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      try { const v = JSON.parse(localStorage.getItem(k));
        if (v && v.body && v.body.access_token) return v.body.access_token;
        if (v && v.access_token) return v.access_token; } catch (e) {}
    }
    // 3) anything captured off the wire by a prior interceptor
    if (window.__navanAuth) return window.__navanAuth.replace(/^TripActions\\s+/i, '');
    return null;
  }
  const tok = findToken();
  if (!tok) return { __navan: 'notoken' };
  const headers = {
    'Authorization': 'TripActions ' + tok,
    'x-tripactions-locale': ${JSON.stringify(LOCALE)},
    'content-type': 'application/json'
  };
  const opts = { method: ${JSON.stringify(method)}, credentials: 'include', headers };
  ${bodyStr != null ? `opts.body = ${JSON.stringify(bodyStr)};` : ''}
  let r;
  try { r = await fetch(${JSON.stringify(path)}, opts); }
  catch (e) { return { __navan: 'network', message: String(e) }; }
  const text = await r.text();
  return { __navan: 'ok', status: r.status, body: text };
})()
`.trim();
}

// Run an API call from the page. Returns { status, text, json }.
async function api(method, path, body) {
  const tabId = await ensureTab();
  const bodyStr = body == null ? null : (typeof body === 'string' ? body : JSON.stringify(body));
  const script = buildScript(method, path, bodyStr);
  let env;
  try {
    env = await browser.evalAsync(tabId, script);
  } catch (e) {
    console.error('eval failed:', e && e.message ? e.message : String(e));
    process.exit(1);
  }
  if (!env || typeof env !== 'object') {
    console.error('Could not parse eval result:', JSON.stringify(env).slice(0, 600));
    process.exit(1);
  }
  if (env.__navan === 'notoken') {
    console.error('No Navan auth token found in the tab. Make sure you are logged into ' + TRIPS_URL + ' and the tab is open, then retry.');
    process.exit(1);
  }
  if (env.__navan === 'network') { console.error('Network error inside the Navan tab:', env.message); process.exit(1); }
  if (env.status === 401 || env.status === 403) {
    console.error('Navan session expired or unauthorized (HTTP ' + env.status + '). Open ' + TRIPS_URL + ', log in, and retry.');
    process.exit(1);
  }
  let json = null; try { json = JSON.parse(env.body); } catch (e) {}
  return { status: env.status, text: env.body, json };
}

function fail(res, ctx) {
  const msg = res.json && (res.json.message || res.json.error) ? (res.json.error || '') + ' ' + (res.json.message || '') : res.text.slice(0, 300);
  console.error('HTTP ' + res.status + (ctx ? ' (' + ctx + ')' : '') + ': ' + msg.trim());
  process.exit(1);
}

// Download a binary (e.g. PDF invoice) from the page context as base64.
// Returns { status, base64, contentType }.
async function apiDownload(path) {
  const tabId = await ensureTab();
  const script = `
(async () => {
  function findToken() {
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k && k.indexOf('@@auth0spajs@@') === 0) {
        try { const v = JSON.parse(localStorage.getItem(k));
          if (v && v.body && v.body.access_token) return v.body.access_token; } catch (e) {}
      }
    }
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      try { const v = JSON.parse(localStorage.getItem(k));
        if (v && v.body && v.body.access_token) return v.body.access_token;
        if (v && v.access_token) return v.access_token; } catch (e) {}
    }
    if (window.__navanAuth) return window.__navanAuth.replace(/^TripActions\\s+/i, '');
    return null;
  }
  const tok = findToken();
  if (!tok) return { __navan: 'notoken' };
  let r;
  try {
    r = await fetch(${JSON.stringify(path)}, { credentials: 'include',
      headers: { 'Authorization': 'TripActions ' + tok, 'x-tripactions-locale': ${JSON.stringify(LOCALE)} } });
  } catch (e) { return { __navan: 'network', message: String(e) }; }
  if (!r.ok) { const t = await r.text(); return { __navan: 'ok', status: r.status, error: t.slice(0, 600) }; }
  const buf = await r.arrayBuffer();
  let bin = ''; const bytes = new Uint8Array(buf);
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return { __navan: 'ok', status: r.status, contentType: r.headers.get('content-type') || '', base64: btoa(bin) };
})()
`.trim();
  let env;
  try {
    env = await browser.evalAsync(tabId, script);
  } catch (e) {
    console.error('eval failed:', e && e.message ? e.message : String(e));
    process.exit(1);
  }
  if (!env || typeof env !== 'object') {
    console.error('Could not parse download result:', JSON.stringify(env).slice(0, 400));
    process.exit(1);
  }
  if (env.__navan === 'notoken') { console.error('No Navan auth token found. Log into ' + TRIPS_URL + ' and retry.'); process.exit(1); }
  if (env.__navan === 'network') { console.error('Network error inside the Navan tab:', env.message); process.exit(1); }
  if (env.status === 401 || env.status === 403) { console.error('Navan session expired (HTTP ' + env.status + '). Re-login and retry.'); process.exit(1); }
  return { status: env.status, base64: env.base64, contentType: env.contentType, error: env.error };
}

// Write base64 content to a file via the VFS binary bridge.
async function writeBase64(path, b64) {
  await fs.writeFileBinary(path, Buffer.from(b64, 'base64'));
}

// ----------------- small helpers -----------------
function arg(args, name, def) {
  const pfx = '--' + name + '=';
  for (const a of args) if (a.indexOf(pfx) === 0) return a.slice(pfx.length);
  const i = args.indexOf('--' + name);
  if (i >= 0 && args[i + 1] && args[i + 1].indexOf('--') !== 0) return args[i + 1];
  return def;
}
function hasFlag(args, name) { return args.indexOf('--' + name) >= 0; }
function money(m) {
  if (!m) return '—';
  if (typeof m === 'object') return (m.amount != null ? m.amount.toFixed ? m.amount.toFixed(2) : m.amount : '?') + ' ' + (m.currency || '');
  return String(m);
}
function hhmm(s) { return s ? String(s).replace('T', ' ').slice(0, 16) : '—'; }
function segLine(s) {
  return `${s.departureAirportCode}->${s.arrivalAirportCode} ${s.airlineCode}${s.flightNumber}`
    + ` ${hhmm(s.departureDateAndTime)} -> ${hhmm(s.arrivalDateAndTime)}`
    + (s.airlineName ? ` (${s.airlineName})` : '');
}

// ----------------- commands: identity -----------------
async function cmdWhoami(args) {
  const json = hasFlag(args, 'json');
  const r = await api('GET', '/api/uaa/userinfo');
  if (r.status !== 200) fail(r, 'userinfo');
  const u = r.json || {};
  if (json) { console.log(JSON.stringify(u, null, 2)); return; }
  console.log(`Name:    ${u.name || ((u.given_name||'') + ' ' + (u.family_name||''))}`);
  console.log(`Email:   ${u.email || '—'}`);
  console.log(`User ID: ${u.sub || '—'}`);
  console.log(`Region:  ${u.serverRegion || '—'}`);
}

// ----------------- commands: trips -----------------
async function cmdTrips(args) {
  const json = hasFlag(args, 'json');
  const r = await api('GET', '/api/user/trips');
  if (r.status !== 200) fail(r, 'trips');
  const list = Array.isArray(r.json) ? r.json : (r.json && r.json.content) || [];
  const trips = list.map(t => ({
    tripId: t.uuid, name: t.name, start: t.startDate, end: t.endDate,
    flights: t.flightCount, hotels: t.hotelCount, cars: t.carCount, rail: t.railCount,
    personal: t.personal,
  }));
  if (json) { console.log(JSON.stringify(trips, null, 2)); return; }
  if (!trips.length) { console.log('No trips found.'); return; }
  console.log(`Trips (${trips.length}):`);
  for (const t of trips) {
    const dates = (t.start || '') + (t.end ? ' -> ' + t.end : '');
    const items = [t.flights && t.flights + 'F', t.hotels && t.hotels + 'H', t.cars && t.cars + 'C', t.rail && t.rail + 'R'].filter(Boolean).join(' ');
    console.log(`  ${(t.name || '(unnamed)').padEnd(28)} ${dates.padEnd(26)} ${items}`);
    console.log(`    ${t.tripId}`);
  }
}

async function cmdTrip(args) {
  const json = hasFlag(args, 'json');
  const id = args.find(a => a.indexOf('--') !== 0);
  if (!id) { console.error('Usage: navan trip <tripId> [--json]'); process.exit(2); }
  const r = await api('GET', `/api/user/trips/timeline?tripUuid=${encodeURIComponent(id)}&tripItemMapIncluded=true`);
  if (r.status !== 200) fail(r, 'trip detail');
  const t = Array.isArray(r.json) ? r.json[0] : r.json;
  if (!t) { console.log('Trip not found.'); return; }
  const map = t.tripItemsMap || {};
  const flights = [], hotels = [];
  for (const k in map) {
    const it = map[k];
    if (it.departureFlight || it.returnFlight) {
      const f = { bookingId: it.bookingId, bookingUuid: it.bookingUuid, confirmationNumber: it.confirmationNumber, status: it.bookingStatus, price: it.totalPrice, name: it.tripName, legs: [] };
      const dseg = it.departureFlight && it.departureFlight.flight && it.departureFlight.flight.flightSegments || [];
      const rseg = it.returnFlight && it.returnFlight.flight && it.returnFlight.flight.flightSegments || [];
      dseg.forEach(s => { f.legs.push({ dir: 'outbound', ...pickSeg(s) }); });
      rseg.forEach(s => { f.legs.push({ dir: 'return', ...pickSeg(s) }); });
      flights.push(f);
    }
    if (it.hotelRoom || it.hotel) {
      hotels.push({
        bookingId: it.bookingId, bookingUuid: it.bookingUuid, confirmationNumber: it.confirmationNumber, status: it.bookingStatus,
        name: it.hotel && it.hotel.name, checkIn: it.startDate, checkOut: it.endDate, price: it.totalPrice,
        payment: it.hotelPaymentDescription && it.hotelPaymentDescription[0],
      });
    }
  }
  if (json) { console.log(JSON.stringify({ tripId: t.tripUuid, flights, hotels }, null, 2)); return; }
  console.log(`Trip ${t.tripUuid}`);
  for (const f of flights) {
    console.log(`\nFlight  booking ${f.bookingId || '—'}  confirmation ${f.confirmationNumber || '—'}  [${f.status || '—'}]  ${money(f.price)} EUR`);
    if (f.bookingUuid) console.log(`  bookingUuid ${f.bookingUuid}  (use for: navan invoice / navan push-expense)`);
    for (const l of f.legs) console.log(`  ${l.dir.padEnd(8)} ${segLine(l)}`);
  }
  for (const h of hotels) {
    console.log(`\nHotel   booking ${h.bookingId || '—'}  confirmation ${h.confirmationNumber || '—'}  [${h.status || '—'}]  ${money(h.price)} EUR`);
    if (h.bookingUuid) console.log(`  bookingUuid ${h.bookingUuid}  (use for: navan invoice / navan push-expense)`);
    console.log(`  ${h.name || '—'}   ${h.checkIn || '?'} -> ${h.checkOut || '?'}`);
    if (h.payment) console.log(`  ${h.payment}`);
  }
  if (!flights.length && !hotels.length) console.log('  (no flight/hotel items)');
}
function pickSeg(s) {
  return { airlineCode: s.airlineCode, airlineName: s.airlineName, flightNumber: s.flightNumber,
    departureAirportCode: s.departureAirportCode, arrivalAirportCode: s.arrivalAirportCode,
    departureDateAndTime: s.departureDateAndTime, arrivalDateAndTime: s.arrivalDateAndTime };
}

// ----------------- commands: airports -----------------
async function cmdAirports(args) {
  const json = hasFlag(args, 'json');
  const q = args.filter(a => a.indexOf('--') !== 0).join(' ');
  if (!q) { console.error('Usage: navan airports <query>'); process.exit(2); }
  const qs = `input=${encodeURIComponent(q)}&includeClusters=true&flightDirection=&radiusMiles=50&maxLargeAirportPerCity=3&maxCloseAirportPerCity=2&preferDirectAirports=true`;
  const r = await api('GET', `/api/user/autocomplete/cityAirports?${qs}`);
  if (r.status !== 200) fail(r, 'airports');
  const list = (r.json && r.json._embedded && r.json._embedded.cityAirportses) || [];
  const out = [];
  for (const c of list) {
    const a = c.mainAirport || (c.location && { iata: c.location.airportCode, name: c.location.placeName }) || {};
    out.push({ code: a.iata || null, name: a.name || (c.location && c.location.placeName) || null,
      city: (c.location && c.location.address && c.location.address.locality) || (a.address && a.address.locality) || null });
  }
  if (json) { console.log(JSON.stringify(out, null, 2)); return; }
  if (!out.length) { console.log('No matches.'); return; }
  for (const o of out) console.log(`  ${(o.code || '   ').padEnd(5)} ${o.name || ''}${o.city ? '  (' + o.city + ')' : ''}`);
}

// ----------------- commands: flights -----------------
function flightSearchQuery(o) {
  const p = new URLSearchParams();
  p.set('emptyData', 'true'); p.set('loadAmenities', 'false'); p.set('flexibleDepartureTime', 'true');
  p.set('includeTravelfusion', 'true'); p.set('includeExpedia', 'true'); p.set('smartSearch', 'true');
  p.set('disableBlacklistedAirlineFlights', 'true'); p.set('appSupportsFareRefundPolicy', 'false');
  p.set('appSupportsFareExchangePolicy', 'false');
  p.set('originAirportCode', o.from); p.set('includeNearbyOriginAirports', 'false');
  p.set('destinationAirportCode', o.to); p.set('includeNearbyDestinationAirports', 'false');
  p.set('departureDate', o.depart); p.set('departureFromTime', '00:00:00.000');
  p.set('departureToTime', '23:59:00.000'); p.set('departureDaysBounds', 'SAME_DAY');
  p.set('cabinClass', o.cabin || 'ECONOMY'); p.set('adults', String(o.pax || 1));
  p.set('maxStops', '10'); p.set('runWithRecommendedStops', 'false');
  p.set('includeDedupedFares', 'true');
  if (o.ret) {
    p.set('returnDate', o.ret); p.set('returnFromTime', '00:00:00.000');
    p.set('returnToTime', '23:59:00.000'); p.set('returnDaysBounds', 'SAME_DAY');
  }
  return p.toString();
}
function optionRow(o) {
  const segs = (o.flight && o.flight.flightSegments) || [];
  const first = segs[0] || {}, last = segs[segs.length - 1] || {};
  const price = (o.providerStartingPrice && o.providerStartingPrice.total) ||
    (o.startingPrice && { amount: Math.round((o.startingPrice.basePrice || 0) + (o.startingPrice.tax || 0)), currency: o.startingPrice.agencyCurrency }) || null;
  return {
    departureId: o.uuid, fareId: o.selectedFareId || null,
    airline: first.airlineCode, airlineName: first.airlineName,
    flightNo: segs.map(s => s.airlineCode + s.flightNumber).join('/'),
    from: first.departureAirportCode, to: last.arrivalAirportCode,
    depart: first.departureDateAndTime, arrive: last.arrivalDateAndTime,
    stops: Math.max(0, segs.length - 1), durationMin: o.flightDuration || o.flightTotalDuration,
    price: price ? (price.amount + ' ' + (price.currency || '')) : null,
  };
}
async function pollFlightOptions(searchId, kind) {
  // kind: 'departures' (POST searches/{id}) — body {} ; returns 'options'
  let last = null;
  for (let attempt = 0; attempt < 8; attempt++) {
    const r = await api('POST', `/api/v1/trip/flight/searches/${searchId}?offset=0&limit=20&loadAmenities=true&displayOnlyAffiliateFlights=false`, {});
    if (r.status !== 200) fail(r, 'flight poll');
    last = r.json;
    if (last && last.options && last.options.length) return last;
    await new Promise(res => setTimeout(res, 1500));
  }
  return last;
}
async function cmdFlights(args) {
  const sub = args[0];
  const rest = args.slice(1);
  const json = hasFlag(rest, 'json');
  if (sub === 'search') {
    const o = { from: arg(rest, 'from'), to: arg(rest, 'to'), depart: arg(rest, 'depart'),
      ret: arg(rest, 'return'), pax: parseInt(arg(rest, 'pax', '1'), 10), cabin: arg(rest, 'cabin', 'ECONOMY') };
    if (!o.from || !o.to || !o.depart) { console.error('Usage: navan flights search --from=BER --to=BSL --depart=YYYY-MM-DD [--return=YYYY-MM-DD] [--pax=1]'); process.exit(2); }
    const cr = await api('GET', `/api/v1/trip/flight/searches?${flightSearchQuery(o)}`);
    if (cr.status !== 200) fail(cr, 'flight search create');
    const searchId = cr.json && cr.json.searchId;
    if (!searchId) { console.error('No searchId returned.'); process.exit(1); }
    const res = await pollFlightOptions(searchId);
    const options = ((res && res.options) || []).map(optionRow);
    if (json) { console.log(JSON.stringify({ searchId, options }, null, 2)); return; }
    console.log(`searchId: ${searchId}`);
    console.log(`${o.from} -> ${o.to} on ${o.depart}${o.ret ? '  (return ' + o.ret + ')' : ''}  ${options.length} outbound options:`);
    for (const x of options) {
      console.log(`  ${(x.price || '—').padStart(12)}  ${x.flightNo.padEnd(12)} ${hhmm(x.depart)} -> ${hhmm(x.arrive)}  ${x.stops}stop  ${x.airlineName || ''}`);
      console.log(`     departureId ${x.departureId}`);
    }
    console.log('\nNext: navan flights returns --search=' + searchId + ' --departure=<departureId>');
    return;
  }
  if (sub === 'returns') {
    const searchId = arg(rest, 'search'), depId = arg(rest, 'departure');
    if (!searchId || !depId) { console.error('Usage: navan flights returns --search=<id> --departure=<departureId>'); process.exit(2); }
    const r = await api('POST', `/api/v1/trip/flight/searches/${searchId}/departures/${depId}/returns?offset=0&limit=20&loadAmenities=true&displayOnlyAffiliateFlights=false`, {});
    if (r.status !== 200) fail(r, 'returns');
    const options = ((r.json && r.json.options) || []).map(optionRow);
    if (json) { console.log(JSON.stringify({ searchId, departureId: depId, returns: options }, null, 2)); return; }
    console.log(`${options.length} return options:`);
    for (const x of options) {
      console.log(`  ${(x.price || '—').padStart(12)}  ${x.flightNo.padEnd(12)} ${hhmm(x.depart)} -> ${hhmm(x.arrive)}  ${x.airlineName || ''}`);
      console.log(`     returnId ${x.departureId}`);
    }
    console.log('\nNext: navan flights price --search=' + searchId + ' --departure=' + depId + ' --return=<returnId>');
    return;
  }
  if (sub === 'price') {
    const searchId = arg(rest, 'search'), depId = arg(rest, 'departure'), retId = arg(rest, 'return');
    if (!searchId || !depId) { console.error('Usage: navan flights price --search=<id> --departure=<departureId> [--return=<returnId>]'); process.exit(2); }
    // resolve fareIds from the option listings
    let depFare = arg(rest, 'departure-fare'), retFare = arg(rest, 'return-fare');
    if (!depFare) {
      const dl = await pollFlightOptions(searchId);
      const dopt = ((dl && dl.options) || []).find(o => o.uuid === depId);
      depFare = dopt && dopt.selectedFareId;
    }
    if (retId && !retFare) {
      const rl = await api('POST', `/api/v1/trip/flight/searches/${searchId}/departures/${depId}/returns?offset=0&limit=20&loadAmenities=true&displayOnlyAffiliateFlights=false`, {});
      const ropt = ((rl.json && rl.json.options) || []).find(o => o.uuid === retId);
      retFare = ropt && ropt.selectedFareId;
    }
    let path;
    if (retId) {
      const qp = new URLSearchParams(); if (depFare) qp.set('departureFareId', depFare); if (retFare) qp.set('returnFareId', retFare); qp.set('timestamp', String(Date.now()));
      path = `/api/v1/trip/flight/searches/${searchId}/departures/${depId}/returns/${retId}/contractV2?${qp.toString()}`;
    } else {
      const qp = new URLSearchParams(); if (depFare) qp.set('departureFareId', depFare);
      path = `/api/v1/trip/flight/searches/${searchId}/departures/${depId}/contractV2?${qp.toString()}`;
    }
    const r = await api('POST', path, {});
    if (r.status !== 200) fail(r, 'price contract');
    const c = (r.json && r.json.contract) || r.json;
    const out = { contractId: c && c.uuid, total: c && (c.totalPriceWithCCFeeInAgencyCurrency || c.totalPriceAndFee), requiresApproval: c && c.requiresApproval };
    if (json) { console.log(JSON.stringify(out, null, 2)); return; }
    console.log(`contractId: ${out.contractId}`);
    console.log(`total:      ${money(out.total)}`);
    console.log(`approval:   ${out.requiresApproval ? 'required' : 'no'}`);
    console.log('\nNext: navan book flight --search=' + searchId + ' --contract=' + out.contractId + ' --confirm');
    return;
  }
  console.error('Usage: navan flights <search|returns|price> ...');
  process.exit(2);
}

// ----------------- commands: hotels -----------------
async function resolvePlace(city) {
  const r = await api('GET', `/api/user/autocomplete/place?input=${encodeURIComponent(city)}&includeFavoriteHotels=true&addLocation=true`);
  if (r.status !== 200) fail(r, 'place lookup');
  const preds = (r.json && r.json.predictions) || [];
  // prefer a city/locality prediction over a specific premise
  const pick = preds.find(p => p.location && p.location.placeId && !(p.types || []).includes('premise')) || preds[0];
  if (!pick || !pick.location) { console.error('No place found for "' + city + '".'); process.exit(1); }
  const loc = pick.location;
  return { placeId: loc.placeId, description: pick.description, lat: loc.geo && loc.geo.latitude, lon: loc.geo && loc.geo.longitude,
    name: pick.displayName || loc.placeName };
}
function hotelRow(o) {
  return { hotelId: o.uuid || o.hotelId, name: o.name, stars: o.hotelStarsRating,
    total: o.totalPriceAndFee, daily: o.dailyRate, currency: 'EUR' };
}
async function cmdHotels(args) {
  const sub = args[0]; const rest = args.slice(1); const json = hasFlag(rest, 'json');
  if (sub === 'search') {
    const city = arg(rest, 'city'), checkin = arg(rest, 'checkin'), checkout = arg(rest, 'checkout');
    const guests = arg(rest, 'guests', '1'), rooms = arg(rest, 'rooms', '1');
    if (!city || !checkin || !checkout) { console.error('Usage: navan hotels search --city=Basel --checkin=YYYY-MM-DD --checkout=YYYY-MM-DD'); process.exit(2); }
    const place = await resolvePlace(city);
    const p = new URLSearchParams();
    p.set('includeSpecialRates', 'true'); p.set('description', place.description || city);
    p.set('checkInDate', checkin); p.set('checkOutDate', checkout);
    p.set('numberOfRooms', rooms); p.set('numberOfGuests', guests);
    p.set('prefetchRooms', 'true'); p.set('emptyData', 'false'); p.set('placeId', place.placeId);
    if (place.lat != null) p.set('latitude', String(place.lat));
    if (place.lon != null) p.set('longitude', String(place.lon));
    const cr = await api('GET', `/api/v1/trip/hotel/searches?${p.toString()}`);
    if (cr.status !== 200) fail(cr, 'hotel search create');
    const searchId = cr.json && cr.json.searchId;
    let res = cr.json;
    for (let i = 0; i < 8 && (!res || !res.options || !res.options.length); i++) {
      await new Promise(r => setTimeout(r, 1500));
      const pr = await api('GET', `/api/v1/trip/hotel/searches/${searchId}`);
      if (pr.status === 200) res = pr.json;
    }
    const hotels = ((res && res.options) || []).map(hotelRow);
    if (json) { console.log(JSON.stringify({ searchId, place: place.name, hotels }, null, 2)); return; }
    console.log(`searchId: ${searchId}`);
    console.log(`${place.name || city}  ${checkin} -> ${checkout}  ${hotels.length} hotels:`);
    for (const h of hotels) {
      console.log(`  ${String(h.total != null ? h.total.toFixed(0) + ' EUR' : '—').padStart(10)}  ${'*'.repeat(Math.round(h.stars || 0)).padEnd(5)} ${h.name}`);
      console.log(`     hotelId ${h.hotelId}`);
    }
    console.log('\nNext: navan hotels rooms --search=' + searchId + ' --hotel=<hotelId>');
    return;
  }
  if (sub === 'rooms') {
    const searchId = arg(rest, 'search'), hotelId = arg(rest, 'hotel');
    if (!searchId || !hotelId) { console.error('Usage: navan hotels rooms --search=<id> --hotel=<hotelId>'); process.exit(2); }
    // Rooms load via POST /api/v2/.../rooms with the hotelId; results live at _embedded.hotels[].rooms
    const r = await api('POST', `/api/v2/trip/hotel/searches/${searchId}/rooms`, [hotelId]);
    if (r.status !== 200) fail(r, 'hotel rooms');
    const hotelsArr = (r.json && r.json._embedded && r.json._embedded.hotels) || [];
    const h = hotelsArr.find(x => (x.uuid === hotelId || x.hotelId === hotelId)) || hotelsArr[0] || {};
    const roomArr = h.rooms || [];
    const rooms = roomArr.map(rm => ({ roomId: rm.uuid, name: rm.displayName || rm.fullDisplayName || rm.rawRoomName || rm.shortDescription,
      total: rm.priceInfo && (rm.priceInfo.totalPriceAndFee || rm.priceInfo.basePrice),
      refundable: rm.bookPolicy }));
    if (json) { console.log(JSON.stringify({ searchId, hotelId, hotel: h.name, rooms }, null, 2)); return; }
    console.log(`${h.name || hotelId}  ${rooms.length} rooms:`);
    for (const rm of rooms) {
      console.log(`  ${String(rm.total != null ? Math.round(rm.total) + ' EUR' : '—').padStart(10)}  ${rm.name || ''}`);
      console.log(`     roomId ${rm.roomId}`);
    }
    console.log('\nNext: navan hotels price --search=' + searchId + ' --hotel=' + hotelId + ' --room=<roomId>');
    return;
  }
  if (sub === 'price') {
    const searchId = arg(rest, 'search'), hotelId = arg(rest, 'hotel'), roomId = arg(rest, 'room');
    if (!searchId || !hotelId || !roomId) { console.error('Usage: navan hotels price --search=<id> --hotel=<hotelId> --room=<roomId>'); process.exit(2); }
    const r = await api('POST', `/api/v1/trip/hotel/searches/${searchId}/hotels/${hotelId}/rooms/${roomId}/contract`, {});
    if (r.status !== 200) fail(r, 'hotel contract');
    const c = (r.json && r.json.contract) || r.json;
    const out = { contractId: c && c.uuid, total: c && (c.totalPriceWithCCFeeInAgencyCurrency || c.totalPriceAndFee), requiresApproval: c && c.requiresApproval };
    if (json) { console.log(JSON.stringify(out, null, 2)); return; }
    console.log(`contractId: ${out.contractId}`);
    console.log(`total:      ${money(out.total)}`);
    console.log(`approval:   ${out.requiresApproval ? 'required' : 'no'}`);
    console.log('\nNext: navan book hotel --search=' + searchId + ' --contract=' + out.contractId + ' --confirm');
    return;
  }
  console.error('Usage: navan hotels <search|rooms|price> ...');
  process.exit(2);
}

// ----------------- commands: book (gated) -----------------
function parseSSE(text) {
  const events = [];
  for (const block of text.replace(/\r/g, '').split('\n\n')) {
    let ev = null; const data = [];
    for (const ln of block.split('\n')) {
      if (ln.indexOf('event:') === 0) ev = ln.slice(6).trim();
      else if (ln.indexOf('data:') === 0) data.push(ln.slice(5));
    }
    if (data.length) events.push({ event: ev, data: data.join('\n') });
  }
  return events;
}
function bookResultFromSSE(text) {
  const evs = parseSSE(text);
  let final = null, error = null;
  for (const e of evs) {
    let d; try { d = JSON.parse(e.data); } catch (x) { continue; }
    if (e.event === 'error' || (d && d.status >= 400)) error = d;
    if (d && d.completed && d.bookResponses && d.bookResponses.length) {
      const b = d.bookResponses[0];
      final = { status: 'CONFIRMED', bookingId: b.bookingId, confirmationNumber: b.confirmationNumber, tripId: b.tripId };
    }
  }
  return { final, error };
}
async function getContract(type, searchId, contractId) {
  const path = type === 'flight'
    ? `/api/v1/trip/flight/searches/${searchId}/contracts/${contractId}?currency=EUR`
    : `/api/v1/trip/hotel/searches/${searchId}/contracts/${contractId}`;
  const r = await api('GET', path);
  if (r.status !== 200) fail(r, 'get contract');
  return (r.json && r.json.contract) || r.json;
}
function summarizeContract(type, c) {
  const total = c.totalPriceWithCCFeeInAgencyCurrency || c.totalPriceAndFee;
  const lines = [];
  if (type === 'flight') {
    const it = c.flightItinerary || {};
    const all = (it.allSegments) ||
      [].concat(((it.departureFlight && it.departureFlight.flight && it.departureFlight.flight.flightSegments) || []),
                ((it.returnFlight && it.returnFlight.flight && it.returnFlight.flight.flightSegments) || []));
    for (const s of all) lines.push('  ' + segLine(s));
  } else {
    lines.push('  ' + (c.hotelName || (c.hotel && c.hotel.name) || 'Hotel') + '  room ' + (c.roomUuid || ''));
  }
  return { total, lines };
}
async function cmdBook(args) {
  const type = args[0];
  const rest = args.slice(1);
  const searchId = arg(rest, 'search'), contractId = arg(rest, 'contract');
  const confirm = hasFlag(rest, 'confirm');
  const json = hasFlag(rest, 'json');
  if (type !== 'flight' && type !== 'hotel') { console.error('Usage: navan book <flight|hotel> --search=<id> --contract=<id> [--confirm]'); process.exit(2); }
  if (!searchId || !contractId) { console.error('Usage: navan book ' + type + ' --search=<id> --contract=<id> [--confirm]'); process.exit(2); }

  const c = await getContract(type, searchId, contractId);
  const sum = summarizeContract(type, c);

  // ---- confirmation gate ----
  if (!confirm) {
    console.log('=== BOOKING PREVIEW (not booked) ===');
    console.log(type.toUpperCase() + ' contract ' + contractId);
    sum.lines.forEach(l => { console.log(l); });
    console.log('  TOTAL: ' + money(sum.total));
    if (c.requiresApproval) console.log('  NOTE: this booking requires approval.');
    console.log('');
    console.log('Booking spends real money and was NOT performed.');
    console.log('To book, re-run with --confirm:');
    console.log('  navan book ' + type + ' --search=' + searchId + ' --contract=' + contractId + ' --confirm');
    return;
  }

  // ---- actual booking (only with --confirm) ----
  const pr = await api('GET', '/api/user/passenger');
  if (pr.status !== 200) fail(pr, 'passenger');
  const passenger = pr.json;
  const pmr = await api('GET', '/api/user/paymentMethods');
  const pms = Array.isArray(pmr.json) ? pmr.json : [];
  const pm = pms.find(m => m.validForPurchase) || pms[0];
  if (!pm) { console.error('No payment method available on the account.'); process.exit(1); }
  const paymentMethodUuid = pm.uuid;

  const passengerData = [{
    airlineLoyaltyCards: {}, airlineDiscountCards: {},
    passenger: Object.assign({
      uuid: passenger.uuid, givenName: passenger.givenName, middleName: passenger.middleName,
      familyName: passenger.familyName, fullName: ((passenger.givenName || '') + ' ' + (passenger.familyName || '')).trim(),
      birthdate: passenger.birthdate, email: passenger.contact && passenger.contact.email,
      travelerType: 'BUSINESS', passenger: passenger,
    }),
  }];
  const body = type === 'flight'
    ? { passengerData, customFieldValues: [], sendEmailToAll: true }
    : { customFieldValues: [], sendEmailToAll: true, passengerData };

  const tripName = (c.flightItinerary && c.flightItinerary.tripName) || 'Trip';
  const q = new URLSearchParams();
  q.set('paymentMethodUuid', paymentMethodUuid);
  q.set('tripName', tripName);
  q.set('locale', LOCALE);
  if (type === 'flight') { q.set('tripId', ''); q.set('tripUuid', ''); q.set('hold', 'false'); q.set('platedBooking', 'false'); }
  const path = `/api/v1/trip/${type}/searches/${searchId}/contracts/${contractId}/book/streaming?${q.toString()}`;
  const r = await api('POST', path, body);
  const parsed = bookResultFromSSE(r.text);
  if (parsed.error && !parsed.final) {
    console.error('Booking failed: ' + (parsed.error.message || parsed.error.error || JSON.stringify(parsed.error).slice(0, 300)));
    process.exit(1);
  }
  const out = parsed.final || { status: 'UNKNOWN', raw: r.text.slice(0, 300) };
  if (json) { console.log(JSON.stringify(out, null, 2)); return; }
  console.log('Booking ' + (out.status || 'UNKNOWN'));
  console.log('  bookingId:          ' + (out.bookingId || '—'));
  console.log('  confirmationNumber: ' + (out.confirmationNumber || '—'));
  console.log('  tripId:             ' + (out.tripId || '—'));
}

// ----------------- commands: invoice + push-to-expense (Concur) -----------------
// All keyed by the booking's bookingUuid (e.g. 6693f5ab-...), shown by `navan trip`.
async function expenseStatus(bookingId) {
  const elig = await api('GET', `/api/v1/expenseFromTravel/${bookingId}/isEligible`);
  const after = await api('GET', `/api/v1/expenseFromTravel/${bookingId}/wasBookedAfterBookingExpenseFeature`);
  const sync = await api('GET', `/api/invoices/v2/sync_status/${bookingId}`);
  return {
    eligible: elig.json ? elig.json.eligible : null,
    eligibleStatus: elig.status,
    bookedAfterFeature: after.json ? after.json.bookedAfterBookingExpenseFeature : null,
    invoices: sync.status === 200 ? sync.json : null,
    invoicesStatus: sync.status,
  };
}
function invoiceFlags(inv) {
  if (!inv) return [];
  return Object.keys(inv).filter(k => inv[k] === true);
}
async function cmdInvoice(args) {
  const json = hasFlag(args, 'json');
  const bookingId = args.find(a => a.indexOf('--') !== 0);
  const download = arg(args, 'download');
  if (!bookingId) { console.error('Usage: navan invoice <bookingId> [--download=<path>] [--json]\n  <bookingId> is the bookingUuid shown by `navan trip <tripId>`.'); process.exit(2); }
  const st = await expenseStatus(bookingId);
  const available = invoiceFlags(st.invoices);
  let saved = null;
  if (download) {
    const dl = await apiDownload(`/api/v1/invoicesinternal/download/${bookingId}?lng=${LOCALE}`);
    if (dl.status !== 200 || !dl.base64) {
      console.error('Invoice download failed (HTTP ' + dl.status + ')' + (dl.error ? ': ' + dl.error.slice(0, 200) : '. No invoice available yet.'));
      process.exit(1);
    }
    let outPath = download;
    if (!/\.[a-z0-9]{2,4}$/i.test(outPath)) outPath += (dl.contentType.indexOf('pdf') >= 0 ? '.pdf' : '');
    await writeBase64(outPath, dl.base64);
    saved = outPath;
  }
  if (json) { console.log(JSON.stringify({ bookingId, ...st, invoicesAvailable: available, downloaded: saved }, null, 2)); return; }
  console.log(`Booking ${bookingId}`);
  console.log(`  Eligible for expense push: ${st.eligible === null ? 'unknown' : st.eligible}`);
  console.log(`  Booked after expense feature: ${st.bookedAfterFeature === null ? 'unknown' : st.bookedAfterFeature}`);
  if (st.invoices) {
    console.log('  Invoice availability:');
    for (const k of Object.keys(st.invoices)) console.log(`    ${k.padEnd(22)} ${st.invoices[k] ? 'available' : 'no'}`);
  } else {
    console.log('  Invoice availability: unavailable (sync_status HTTP ' + st.invoicesStatus + ')');
  }
  if (saved) console.log(`  Invoice saved to: ${saved}`);
  else if (available.length) console.log('  To save the invoice PDF: navan invoice ' + bookingId + ' --download=<path>');
}

async function cmdPushExpense(args) {
  const json = hasFlag(args, 'json');
  const confirm = hasFlag(args, 'confirm');
  const bookingId = args.find(a => a.indexOf('--') !== 0);
  if (!bookingId) { console.error('Usage: navan push-expense <bookingId> [--confirm]\n  <bookingId> is the bookingUuid shown by `navan trip <tripId>`.'); process.exit(2); }
  const st = await expenseStatus(bookingId);
  const available = invoiceFlags(st.invoices);

  // ---- confirmation gate ----
  if (!confirm) {
    console.log('=== PUSH-TO-EXPENSE PREVIEW (not pushed) ===');
    console.log('Booking ' + bookingId);
    console.log('  Eligible for expense push: ' + (st.eligible === null ? 'unknown' : st.eligible));
    console.log('  Invoices available: ' + (available.length ? available.join(', ') : 'none reported yet'));
    console.log('  Would: PUT /api/user/bookings/' + bookingId + '/expense  -> push this booking + its invoice(s) to your expense system (Concur).');
    if (st.eligible === false) console.log('  NOTE: isEligible is false — the push may be rejected (e.g. already expensed or not eligible).');
    console.log('');
    console.log('This MUTATES your expense system (Concur) and was NOT performed.');
    console.log('To push, re-run with --confirm:');
    console.log('  navan push-expense ' + bookingId + ' --confirm');
    return;
  }

  // ---- perform the push (only with --confirm) ----
  const r = await api('PUT', `/api/user/bookings/${bookingId}/expense`, null);
  if (r.status === 400 && r.json && r.json.exceptionClass === 'EmailAccessRequiredException') {
    console.error('Push failed: Navan needs email (Outlook/Gmail) access to send the invoice to expense.');
    console.error('Grant it once in the Navan UI, then retry. Provider: ' + (r.json.provider || '?'));
    if (r.json.authorizeUri) console.error('Authorize URL: ' + r.json.authorizeUri);
    process.exit(1);
  }
  if (r.status !== 200) fail(r, 'push-expense');
  const out = { bookingId, status: r.status, result: 'PUSHED', expenseUuid: r.json && r.json.uuid, dateModified: r.json && r.json.dateModified };
  if (json) { console.log(JSON.stringify(out, null, 2)); return; }
  console.log('Pushed to expense (Concur): ' + bookingId);
  if (out.expenseUuid) console.log('  expense/booking uuid: ' + out.expenseUuid);
  if (out.dateModified) console.log('  dateModified:         ' + out.dateModified);
}

// ----------------- help -----------------
function cmdHelp() {
  console.log(`navan — Navan (TripActions) corporate travel: search, view trips, and book.

Usage:
  navan whoami                              Show the logged-in user
  navan trips [--json]                      List trips (name, dates, item counts, tripId)
  navan trip <tripId> [--json]              Trip detail: flights + hotels with bookingId/confirmation
  navan airports <query> [--json]           Airport/city autocomplete (code, name)

  navan flights search --from=BER --to=BSL --depart=YYYY-MM-DD [--return=YYYY-MM-DD] [--pax=1] [--cabin=ECONOMY]
                                            Search flights -> outbound options (departureId, price)
  navan flights returns --search=<id> --departure=<departureId>
                                            Return options for a chosen outbound (returnId, price)
  navan flights price   --search=<id> --departure=<departureId> [--return=<returnId>]
                                            Price a chosen pair -> contractId + total

  navan hotels search --city=Basel --checkin=YYYY-MM-DD --checkout=YYYY-MM-DD [--guests=1] [--rooms=1]
                                            Search hotels -> options (hotelId, price, stars)
  navan hotels rooms  --search=<id> --hotel=<hotelId>     Rooms for a hotel (roomId, price)
  navan hotels price  --search=<id> --hotel=<hotelId> --room=<roomId>   Price a room -> contractId + total

  navan book <flight|hotel> --search=<id> --contract=<id> [--confirm]
                                            WITHOUT --confirm: print itinerary + total and STOP (no booking).
                                            WITH --confirm: book and print {status, bookingId, confirmationNumber, tripId}.

  navan invoice <bookingId> [--download=<path>] [--json]
                                            Report invoice sync_status + expense eligibility for a booking.
                                            With --download, save the invoice PDF to <path>.
  navan push-expense <bookingId> [--confirm]
                                            Push the booking + invoice to the expense system (Concur).
                                            WITHOUT --confirm: print eligibility + what would be pushed and STOP.
                                            WITH --confirm: perform the PUT and report the result.
  navan help                                Show this help

Booking ids:
  - <bookingId> for invoice / push-expense is the bookingUuid shown by
    "navan trip <tripId>" (e.g. 6693f5ab-...), NOT the airline PNR.

Auth & safety:
  - Requires a logged-in Navan tab (${TRIPS_URL}) open in the browser. All calls run
    inside that tab and use the "Authorization: TripActions <JWT>" header.
  - On 401/403 the session expired: open Navan, log in, and retry.
  - BOOKING SPENDS REAL MONEY. The book command never books without --confirm.
  - PUSH-EXPENSE MUTATES your expense system (Concur). It never pushes without --confirm.`);
}

// ----------------- dispatch -----------------
const argv = process.argv.slice(2);
const cmd = argv[0];
const rest = argv.slice(1);
try {
  if (cmd === 'whoami') await cmdWhoami(rest);
  else if (cmd === 'trips') await cmdTrips(rest);
  else if (cmd === 'trip') await cmdTrip(rest);
  else if (cmd === 'airports') await cmdAirports(rest);
  else if (cmd === 'flights') await cmdFlights(rest);
  else if (cmd === 'hotels') await cmdHotels(rest);
  else if (cmd === 'book') await cmdBook(rest);
  else if (cmd === 'invoice') await cmdInvoice(rest);
  else if (cmd === 'push-expense') await cmdPushExpense(rest);
  else if (!cmd || cmd === 'help' || cmd === '--help' || cmd === '-h') cmdHelp();
  else { console.error('Unknown command: ' + cmd); cmdHelp(); process.exit(2); }
} catch (e) { console.error('Error:', e && e.message ? e.message : String(e)); process.exit(1); }

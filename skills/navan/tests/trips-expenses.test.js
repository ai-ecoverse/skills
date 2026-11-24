import fs from 'node:fs';
import path from 'node:path';
import test, { is, ok, throws } from 'tst';
import { exitStub, load } from './extract.js';

const SOURCE = fs.readFileSync(path.join(process.cwd(), 'scripts/navan.jsh'), 'utf8');
const stub = exitStub();
const { filterTrips, tripFilterOpts, expenseLines, invoiceNotes } = load(
  SOURCE,
  ['arg', 'hasFlag', 'todayIso', 'isoDay', 'filterTrips', 'tripFilterOpts', 'round2', 'numOrNull', 'expenseLines', 'invoiceNotes'],
  { process: { exit: stub.die }, console: { error: () => {}, log: () => {} } }
);

const trips = [
  { tripId: 'a', start: '2025-01-10', end: '2025-01-12' },
  { tripId: 'c', start: '2026-03-01', end: '2026-03-03' },
  { tripId: 'b', start: '2025-06-01', end: '2025-06-02' },
  { tripId: 'n', start: null, end: null },
];
const ids = (l) => l.map((t) => t.tripId).join('');

test('trips default to newest first, undated last', () => {
  is(ids(filterTrips(trips, {})), 'cban');
});

test('--oldest-first restores chronological order', () => {
  is(ids(filterTrips(trips, { oldestFirst: true })), 'abcn');
});

test('--limit keeps the most recent trips', () => {
  is(ids(filterTrips(trips, { limit: 2 })), 'cb');
});

test('--since and --until bound the start date', () => {
  is(ids(filterTrips(trips, { since: '2025-06-01', until: '2026-03-01' })), 'cb');
});

test('--upcoming and --past split on today', () => {
  is(ids(filterTrips(trips, { upcoming: true, today: '2026-03-02' })), 'c');
  is(ids(filterTrips(trips, { past: true, today: '2026-03-02' })), 'ba');
});

test('flag parsing accepts = and space forms and rejects bad input', () => {
  const o = tripFilterOpts(['--since=2025-01-01', '--limit', '5', '--past']);
  is(o.since, '2025-01-01');
  is(o.limit, 5);
  ok(o.past);
  throws(() => tripFilterOpts(['--since=yesterday']));
  throws(() => tripFilterOpts(['--limit=0']));
  throws(() => tripFilterOpts(['--upcoming', '--past']));
});

const flight = {
  departureFlight: {},
  bookingId: 'A29I1Z71I',
  bookingUuid: 'u1',
  bookingStatus: 'TICKETED',
  confirmationNumber: 'KDMDXPL',
  agencyCurrency: 'EUR',
  grandTotal: 446.9,
  chargedAmount: { currency: 'EUR', total: 401.23, tripFee: 16.14 },
  priceBreakdown: { priceQuotes: [{ providerPrice: { total: { amount: 468.1, currency: 'EUR' } } }] },
  passengerDatum: { etickets: ['KDMDXPL'], eticket: 'KDMDXPL' },
};

test('flight yields an air charge and a trip-fee charge with vendor patterns', () => {
  const [air, fee] = expenseLines(flight);
  is(air.vendor, 'NVN-AL-A29I1Z71I');
  is(air.amount, 468.1);
  is(air.ticketNumber, 'KDMDXPL');
  is(air.concurType, 'TOLLS');
  is(fee.vendor, 'NVN  TRP FEE A29I1Z71I');
  is(fee.amount, 16.14);
  is(fee.concurType, '01145');
});

test('without provider price the air amount falls back to total minus fee', () => {
  const { priceBreakdown, ...bare } = flight;
  is(expenseLines(bare)[0].amount, 385.09);
});

test('a pending ticket yields no ticketNumber', () => {
  const [air] = expenseLines({ ...flight, passengerDatum: { etickets: [], eticket: 'Pending' } });
  is(air.ticketNumber, null);
});

test('hotel yields a charge without a Navan vendor', () => {
  const lines = expenseLines({ hotel: {}, bookingId: 'HDR', confirmationNumber: 'SAB1', agencyCurrency: 'EUR', grandTotal: 269.2, tripFee: 0, hotelPaymentDescription: ['A credit card was needed at check-in to pay the amount of CHF223.00 plus incidentals.'] });
  is(lines.length, 1);
  is(lines[0].kind, 'hotel');
  is(lines[0].vendor, null);
  is(lines[0].currency, 'CHF');
  is(lines[0].amount, 223);
  is(lines[0].confirmation, 'SAB1');
});

test('invoice notes distinguish flight bundles from hotel summaries', () => {
  ok(invoiceNotes({ provider_invoices: true, trip_fee_invoices: true })[0].includes('2 pages'));
  ok(invoiceNotes({ provider_invoices: true, trip_fee_invoices: false })[0].includes('folio'));
  is(invoiceNotes(null).length, 0);
});

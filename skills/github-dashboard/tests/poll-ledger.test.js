import test, { is, ok } from 'tst';

// Evaluates the FENCED ledgerLogLine block of the poll script named by GHD_POLL
// (default: the staged copy), and the fetcher's formatter via GHD_FETCHER.
// Never imports poll.jsh: loading it starts the scheduler.
const fs = require('fs');
const POLL = (process.env && process.env.GHD_POLL) ||
  ['../scripts/poll.jsh', '../poll.jsh']
    .map((p) => new URL(p, import.meta.url).pathname)
    .find((p) => require('fs').existsSync(p)) ||
  (() => { throw new Error('poll.jsh not found; set GHD_POLL'); })();
const FETCHER = (process.env && process.env.GHD_FETCHER) ||
  ['../scripts/fetch-snapshot.mjs', '../fetch-snapshot.mjs']
    .map((p) => new URL(p, import.meta.url).pathname)
    .find((p) => require('fs').existsSync(p)) ||
  (() => { throw new Error('fetch-snapshot.mjs not found; set GHD_FETCHER'); })();
const P = fs.readFileSync(POLL, 'utf8');
const pa = P.indexOf('/* ---- 8< ledgerLogLine');
const pb = P.indexOf('/* ---- >8 end ledgerLogLine');
const ledgerLogLine = pa >= 0 && pb > pa ? new Function(P.slice(pa, pb) + '\nreturn ledgerLogLine;')() : () => { throw new Error(`ledgerLogLine not in ${POLL}`); };
const F = fs.readFileSync(FETCHER, 'utf8');
const fa = F.indexOf('/* ---- 8< agentLedger');
const fb = F.indexOf('/* ---- >8 end agentLedger');
const formatLedgerLine = fa >= 0 && fb > fa ? new Function(F.slice(fa, fb) + '\nreturn formatLedgerLine;')() : () => { throw new Error(`formatLedgerLine not in ${FETCHER}`); };

const STDOUT = [
  'records        : 113',
  'requests       : 190',
  'agent ledger   : 3 calls (haiku-4-5), 14.2 s agent time (max 6.1 s), 11 cached, 0 failed',
  'ledger file    : /x/agent-ledger.jsonl',
  'status agents  : 3 calls (concurrency 6), 3 generated, 0 fell back, 9.0s wall clock',
].join('\n');

test('P1 the fetcher ledger line becomes ONE indented poll-log line', () => {
  is(ledgerLogLine(STDOUT), '  agents: 3 calls (haiku-4-5), 14.2 s agent time (max 6.1 s), 11 cached, 0 failed');
});

test('P2 no ledger line (an older fetcher, empty or null stdout): said, not swallowed', () => {
  for (const out of ['records : 1\n', '', null, undefined]) is(ledgerLogLine(out), '  agents: (no "agent ledger" line in the fetcher output)');
});

test('P3 end to end: what the fetcher prints is what the poll log shows', () => {
  const sum = { calls: 1, retries: 0, models: ['global.anthropic.claude-haiku-4-5-20251001-v1:0'], wallMs: { total: 98613, max: 98613 }, cache: { servedWithoutCall: 19 }, failed: 0 };
  const printed = `agent ledger   : ${formatLedgerLine(sum)}`;
  is(ledgerLogLine(`x\n${printed}\ny`), `  agents: ${formatLedgerLine(sum)}`);
});

test('P4 the SUCCESS path logs it, before the mirror runs (the fetch stdout is otherwise dropped)', () => {
  const ok1 = P.indexOf('failures = 0;');
  const call = P.indexOf('log(ledgerLogLine(r && r.stdout));', ok1);
  const mirror = P.indexOf('await mirror();', ok1);
  ok(ok1 > 0 && call > ok1 && mirror > call, `success branch ${ok1}, ledger log ${call}, mirror ${mirror}`);
});

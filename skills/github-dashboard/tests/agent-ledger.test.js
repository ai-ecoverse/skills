import test, { is, ok } from 'tst';

// Evaluates the FENCED agentLedger block of the fetcher named by GHD_FETCHER
// (default: the staged copy). If the block is absent, every function is a stub
// that throws, so each test goes red on its own.
const fs = require('fs');
const FILE = (process.env && process.env.GHD_FETCHER) ||
  ['../scripts/fetch-snapshot.mjs', '../fetch-snapshot.mjs']
    .map((p) => new URL(p, import.meta.url).pathname)
    .find((p) => require('fs').existsSync(p)) ||
  (() => { throw new Error('fetch-snapshot.mjs not found; set GHD_FETCHER'); })();
const src = fs.readFileSync(FILE, 'utf8');
const a = src.indexOf('/* ---- 8< agentLedger');
const b = src.indexOf('/* ---- >8 end agentLedger');
const NAMES = ['newAgentLedger', 'runStatusAgent', 'summariseAgentLedger', 'formatLedgerLine', 'ledgerJsonLine', 'capJsonl', 'shortModelName'];
const M = a >= 0 && b > a
  ? new Function(src.slice(a, b) + '\nreturn {' + NAMES.map((n) => `${n}: typeof ${n} === 'function' ? ${n} : null`).join(', ') + ', AGENT_LEDGER_MAX_LINES, AGENT_LEDGER_MAX_BYTES };')()
  : {};
for (const n of NAMES) if (!M[n]) M[n] = () => { throw new Error(`${n} is not defined in ${FILE}`); };

const MODEL = 'global.anthropic.claude-haiku-4-5-20251001-v1:0';
const parse = (t) => JSON.parse(t); // the fetcher injects parseStatusJson; the ledger does not depend on it
const good = (short) => JSON.stringify({ short, long: 'x', actions: [] });
// A stubbed agent: scripted results, and a fake clock advanced by each call.
function stub(script) {
  let t = 1000;
  const cmds = [];
  return {
    cmds,
    now: () => t,
    exec: async (cmd) => { cmds.push(cmd); const s = script.shift(); t += s.ms; if (s.throws) throw new Error(s.throws); return s.r; },
  };
}
const run = (s, ledger, key, attempt = 'first', promptChars = 100) =>
  M.runStatusAgent({ exec: s.exec, cmd: `agent --model ${MODEL} ...${key}`, key, attempt, model: MODEL, promptChars, ledger, parse, now: s.now });

test('L1 stubbed agent: every invocation is counted, retries separately, with wall ms and chars', async () => {
  const s = stub([
    { ms: 4000, r: { exitCode: 0, stdout: good('a'.repeat(200)), stderr: '' } },
    { ms: 6100, r: { exitCode: 0, stdout: good('short'), stderr: '' } },
    { ms: 4100, r: { exitCode: 0, stdout: good('b'.repeat(190)), stderr: '' } },
  ]);
  const L = M.newAgentLedger();
  await run(s, L, 'o/r#1');
  await run(s, L, 'o/r#2');
  await run(s, L, 'o/r#2', 'retry', 150);
  const sum = M.summariseAgentLedger(L, { cacheStats: {} });
  is(s.cmds.length, 3);
  is(sum.calls, 3);
  is(sum.firstAttempts, 2);
  is(sum.retries, 1);
  is(sum.ok, 3);
  is(sum.failed, 0);
  is(sum.wallMs.total, 14200);
  is(sum.wallMs.max, 6100);
  is(sum.promptChars, 350);
  is(sum.outputChars, good('a'.repeat(200)).length + good('short').length + good('b'.repeat(190)).length);
  is(sum.models.join(), MODEL);
});

test('L2 cache hits: calls the status cache avoided are reported next to the calls made', async () => {
  const s = stub([{ ms: 2000, r: { exitCode: 0, stdout: good('ok answer'), stderr: '' } }]);
  const L = M.newAgentLedger();
  await run(s, L, 'o/r#1');
  const sum = M.summariseAgentLedger(L, { cacheStats: { hits: 7, doneServedFromCache: 4, doneMechanical: 30, misses: 1 } });
  is(sum.calls, 1);
  is(sum.cache.servedWithoutCall, 11);
  is(sum.cache.hits, 7);
  is(sum.cache.doneServedFromCache, 4);
  is(sum.cache.misses, 1);
});

test('L3 a failed agent call (non-zero exit) is counted as a failure, returns null, keeps the old warning', async () => {
  const s = stub([{ ms: 1500, r: { exitCode: 1, stdout: '', stderr: 'bridge unavailable\n' } }]);
  const L = M.newAgentLedger();
  const out = await run(s, L, 'o/r#9');
  is(out.g, null);
  is(out.warning, 'agent failed for o/r#9 (exit 1): bridge unavailable');
  const sum = M.summariseAgentLedger(L, {});
  is(sum.calls, 1);
  is(sum.failed, 1);
  is(sum.ok, 0);
  is(sum.failures.exit, 1);
});

test('L4 unparseable output and an unusable short are failures too; an exec that throws is contained', async () => {
  const s = stub([
    { ms: 10, r: { exitCode: 0, stdout: 'I cannot help with that', stderr: '' } },
    { ms: 10, r: { exitCode: 0, stdout: good('ab'), stderr: '' } },
    { ms: 10, throws: 'spawn failed' },
  ]);
  const L = M.newAgentLedger();
  await run(s, L, 'o/r#1');
  await run(s, L, 'o/r#2');
  const thrown = await run(s, L, 'o/r#3');
  is(thrown.g, null);
  const sum = M.summariseAgentLedger(L, {});
  is(sum.failed, 3);
  is(sum.failures.unparseable, 1);
  is(sum.failures.unusable, 1);
  is(sum.failures.exit, 1);
});

test('L5 the jsonl cap holds by lines: newest kept, oldest dropped', () => {
  let text = '';
  for (let i = 0; i < 2500; i++) text = M.capJsonl(text, JSON.stringify({ i }));
  const lines = text.trim().split('\n');
  is(lines.length, M.AGENT_LEDGER_MAX_LINES);
  is(JSON.parse(lines[lines.length - 1]).i, 2499);
  is(JSON.parse(lines[0]).i, 2500 - M.AGENT_LEDGER_MAX_LINES);
});

test('L6 the jsonl cap holds by bytes, blank lines are dropped, the newest line always survives', () => {
  let text = '\n\n';
  for (let i = 0; i < 50; i++) text = M.capJsonl(text, JSON.stringify({ i, pad: 'x'.repeat(90) }), { maxLines: 1000, maxBytes: 1000 });
  ok(new TextEncoder().encode(text).length <= 1000, 'within maxBytes: ' + text.length);
  ok(!text.split('\n').slice(0, -1).some((l) => !l.trim()), 'no blank lines');
  is(JSON.parse(text.trim().split('\n').pop()).i, 49);
  const huge = M.capJsonl('', 'y'.repeat(5000), { maxLines: 10, maxBytes: 100 });
  is(huge.trim().length, 5000);
});

test('L7 a jsonl line is one line and carries at most 40 per-call entries', async () => {
  const script = Array.from({ length: 45 }, () => ({ ms: 1, r: { exitCode: 0, stdout: good('fine answer'), stderr: '' } }));
  const s = stub(script);
  const L = M.newAgentLedger();
  for (let i = 0; i < 45; i++) await run(s, L, `o/r#${i}`);
  const line = M.ledgerJsonLine(M.summariseAgentLedger(L, {}));
  ok(!line.includes('\n'), 'single line');
  const j = JSON.parse(line);
  is(j.calls, 45);
  is(j.perCall.length, 40);
  is(j.perCallTruncated, 5);
});

test('L8 the log line: calls, model, agent time, cached, failed', () => {
  const sum = { calls: 3, retries: 1, models: ['global.anthropic.claude-haiku-4-5-20251001-v1:0'], wallMs: { total: 14200, max: 6100 }, cache: { servedWithoutCall: 11 }, failed: 0 };
  is(M.formatLedgerLine(sum), '3 calls incl. 1 retry (haiku-4-5), 14.2 s agent time (max 6.1 s), 11 cached, 0 failed');
  is(M.formatLedgerLine({ calls: 0, retries: 0, models: [], wallMs: { total: 0, max: 0 }, cache: { servedWithoutCall: 40 }, failed: 0 }), '0 calls (no model called), 0.0 s agent time, 40 cached, 0 failed');
});

test('L9 no token counts and no cost estimate are invented', () => {
  const sum = M.summariseAgentLedger(M.newAgentLedger(), {});
  is(sum.tokens, null);
  is(sum.costEstimate, null);
  ok(/slicc#3437/.test(sum.tokensWhy));
});

test('L10 wiring: the fetcher has exactly one agent command, and it goes through runStatusAgent', () => {
  is(src.split('`agent --model ${').length - 1, 1);
  is(src.split('await execAsync(cmd)').length - 1, 0);
  is(src.split('await runStatusAgent({').length - 1, 1);
});

import fs from 'node:fs';
import path from 'node:path';
import test, { is, ok } from 'tst';

// Runs the real smileys.jsh against a fake sliccy:browser: findTab answers
// from a list of open tab URLs, browser.fetch serves GETs, and evalAsync
// records every in-page write (method, URL, body) instead of sending it.
const source = fs.readFileSync(path.join(process.cwd(), 'scripts/smileys.jsh'), 'utf8');
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;

class NodeExitError extends Error {
  constructor(code) {
    super(`exit ${code}`);
    this.name = 'NodeExitError';
    this.code = code;
  }
}

function parseFlags(args) {
  const flags = {};
  const positional = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--confirm' || a === '--json') flags[a.slice(2)] = true;
    else if (a.startsWith('--')) flags[a.slice(2)] = args[++i];
    else positional.push(a);
  }
  return { flags, positional, subcommand: positional[0] || '' };
}

async function smileys(args, { tabs = ['https://shop.smileys.de/store/potsdam'] } = {}) {
  const writes = [];
  const out = [];
  const err = [];
  const browser = {
    findTab: async ({ urlMatch }) => {
      const url = tabs.find((u) => urlMatch.test(u));
      return url ? { targetId: `T-${url}`, url } : null;
    },
    fetch: async () => ({ ok: true, status: 200, body: { data: [] } }),
    evalAsync: async (_tab, expr) => {
      const url = JSON.parse(/fetch\((".*?"),/.exec(expr)[1]);
      const method = JSON.parse(/method: (".*?"),/.exec(expr)[1]);
      const m = /body: (".*"),\n/.exec(expr);
      writes.push({ method, url, body: m ? JSON.parse(JSON.parse(m[1])) : undefined });
      return { ok: true, status: 200, body: { data: { ok: true } } };
    },
  };
  const cli = {
    die(msg, o = {}) {
      err.push(String(msg));
      throw new NodeExitError(o.exitCode ?? 1);
    },
    help(t) {
      out.push(t);
      throw new NodeExitError(0);
    },
    out: (v) => out.push(typeof v === 'string' ? v : JSON.stringify(v)),
  };
  const argv = ['node', 'smileys.jsh', ...args];
  argv.parseFlags = () => parseFlags(args);
  const modules = { 'sliccy:browser': browser, 'sliccy:cli': cli };
  let code = 0;
  try {
    await new AsyncFunction('require', 'process', 'console', source)(
      (n) => modules[n],
      { argv, env: {} },
      { log: (...a) => out.push(a.join(' ')), error: (...a) => err.push(a.join(' ')) }
    );
  } catch (e) {
    if (e?.name !== 'NodeExitError') throw e;
    code = e.code;
  }
  return { code, stdout: out.join('\n'), stderr: err.join('\n'), writes };
}

const ADDRESS = [
  '--firstname',
  'Ada',
  '--lastname',
  'Lovelace',
  '--email',
  'ada@example.org',
  '--phone',
  '0331 000000',
  '--street',
  'Beispielweg',
  '--number',
  '1',
  '--zip',
  '14467',
  '--city',
  'Potsdam',
];
const CHECKOUT = 'https://shop.smileys.de/api/v1/store/potsdam/checkout';

test('checkout without --confirm previews the customer and writes nothing', async () => {
  const r = await smileys(['checkout', ...ADDRESS]);
  is(r.code, 0, r.stderr);
  is(r.writes, []);
  ok(r.stdout.includes('nothing written'));
  ok(r.stdout.includes('Ada Lovelace <ada@example.org>'));
  ok(r.stdout.includes('Beispielweg 1, 14467 Potsdam'));
});

test('checkout --confirm starts checkout (POST) before saving the customer (PUT)', async () => {
  const r = await smileys(['checkout', '--confirm', ...ADDRESS]);
  is(r.code, 0, r.stderr);
  is(
    r.writes.map((w) => `${w.method} ${w.url}`),
    [`POST ${CHECKOUT}`, `PUT ${CHECKOUT}`]
  );
  is(r.writes[0].body, { customer: {}, shipping_time: null, message: null });
  is(r.writes[1].body.customer.firstname, 'Ada');
  is(r.writes[1].body.customer.zipcode, '14467');
  is(r.writes[1].body.customer.telephone_raw, '0331 000000');
});

test('checkout names every missing address flag and writes nothing (no default identity)', async () => {
  const r = await smileys(['checkout', '--confirm', '--firstname', 'Ada']);
  is(r.code, 1);
  ok(r.stderr.includes('--lastname --email --phone --street --number --zip --city'), r.stderr);
  is(r.writes, []);
});

test('writes come from a shop.smileys.de tab, never from mein/www', async () => {
  const meinOnly = await smileys(['add', 'sp_x', '--size', 'large'], {
    tabs: ['https://mein.smileys.de/konto'],
  });
  is(meinOnly.code, 1);
  ok(meinOnly.stderr.includes('not the shop'), meinOnly.stderr);
  is(meinOnly.writes, []);
  const both = await smileys(['add', 'sp_x', '--size', 'large'], {
    tabs: ['https://www.smileys.de/bestellen', 'https://shop.smileys.de/store/potsdam'],
  });
  is(both.code, 0, both.stderr);
  is(both.writes[0].url, 'https://shop.smileys.de/api/v1/store/potsdam/cart/items');
  is(both.writes[0].body, { item: 'sp_x', options: [], quantity: 1, size: 'large' });
});

test('there is no payment command', async () => {
  for (const cmd of ['pay', 'paypal', 'wallet', 'payment']) {
    const r = await smileys([cmd]);
    is(r.code, 1, cmd);
    ok(r.stderr.includes('unknown command'), cmd);
    is(r.writes, []);
  }
});

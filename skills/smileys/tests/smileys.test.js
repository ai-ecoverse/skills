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

// The runtime's own parser (slicc-jsh parseFlags, same as SLICC 6): a `--flag`
// followed by a word takes it as its value, so a flag may swallow a word.
function parseFlags(args) {
  const positional = [];
  const flags = {};
  const set = (k, v) => {
    if (k in flags) flags[k] = [...[].concat(flags[k]).map(String), String(v)];
    else flags[k] = v;
  };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg.startsWith('--')) {
      const body = arg.slice(2);
      const eq = body.indexOf('=');
      if (eq !== -1) set(body.slice(0, eq), body.slice(eq + 1));
      else if (args[i + 1] !== undefined && !args[i + 1].startsWith('-')) set(body, args[++i]);
      else set(body, true);
    } else if (arg.startsWith('-') && arg.length > 1) {
      for (const ch of arg.slice(1)) set(ch, true);
    } else positional.push(arg);
  }
  const subcommand =
    positional.length && /^[a-z][\w-]*$/i.test(positional[0]) ? positional[0] : null;
  return { positional, flags, subcommand };
}

async function smileys(
  args,
  {
    tabs = ['https://shop.smileys.de/store/potsdam'],
    reply = () => ({ ok: true, status: 200, body: { data: { ok: true } } }),
  } = {}
) {
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
      const w = { method, url, body: m ? JSON.parse(JSON.parse(m[1])) : undefined };
      writes.push(w);
      return reply(w);
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
const CONFIRM_LAST = (extra = []) => ['checkout', ...ADDRESS, ...extra, '--confirm'];

test('checkout without --confirm previews the customer and writes nothing', async () => {
  const r = await smileys(['checkout', ...ADDRESS]);
  is(r.code, 0, r.stderr);
  is(r.writes, []);
  ok(r.stdout.includes('nothing written'));
  ok(r.stdout.includes('Ada Lovelace <ada@example.org>'));
  ok(r.stdout.includes('Beispielweg 1, 14467 Potsdam'));
});

test('checkout --confirm starts checkout (POST) before saving the customer (PUT)', async () => {
  const r = await smileys(CONFIRM_LAST());
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
  const r = await smileys(['checkout', '--firstname', 'Ada', '--confirm']);
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

test('a valued --confirm (--confirm=false, --confirm no) is refused and writes nothing', async () => {
  for (const extra of [['--confirm=false'], ['--confirm', 'no']]) {
    const r = await smileys(['checkout', ...ADDRESS, ...extra]);
    is(r.code, 1, extra.join(' '));
    ok(r.stderr.includes('--confirm takes no value'), r.stderr);
    is(r.writes, []);
  }
});

test('the store comes from the shop tab or --store, never a silent default', async () => {
  const berlin = await smileys(['add', 'sp_x', '--size', 'large'], {
    tabs: ['https://shop.smileys.de/store/berlin-mitte/category/pizza'],
  });
  is(berlin.writes[0].url, 'https://shop.smileys.de/api/v1/store/berlin-mitte/cart/items');
  const flag = await smileys(['add', 'sp_x', '--size', 'large', '--store', 'hamburg']);
  is(flag.writes[0].url, 'https://shop.smileys.de/api/v1/store/hamburg/cart/items');
  const none = await smileys(['add', 'sp_x', '--size', 'large'], {
    tabs: ['https://shop.smileys.de/'],
  });
  is(none.code, 1);
  ok(none.stderr.includes('which store?'), none.stderr);
  is(none.writes, []);
});

test('--qty must be a whole number from 1 to 20', async () => {
  for (const q of ['0', '21', '2x', 'abc']) {
    const r = await smileys(['add', 'sp_x', '--size', 'large', '--qty', q]);
    is(r.code, 1, q);
    ok(r.stderr.includes('--qty must be a whole number'), r.stderr);
    is(r.writes, []);
  }
  const twice = await smileys(['add', 'sp_x', '--size', 'large', '--qty', '3', '--qty', '4']);
  is(twice.code, 1);
  is((await smileys(['add', 'sp_x', '--size', 'large', '--qty', '3'])).writes[0].body.quantity, 3);
});

test('usage errors are reported before the missing-tab error', async () => {
  const r = await smileys(['add'], { tabs: [] });
  is(r.code, 1);
  ok(r.stderr.includes('usage: smileys add'), r.stderr);
});

test('a login page in reply to a write is a session error, not "added"', async () => {
  const r = await smileys(['add', 'sp_x', '--size', 'large'], {
    reply: () => ({
      ok: true,
      status: 200,
      body: '<!DOCTYPE html><html><body>Anmelden</body></html>',
    }),
  });
  is(r.code, 1);
  ok(r.stderr.includes('session expired'), r.stderr);
  ok(!r.stdout.includes('added'));
});

test('a failed customer save after checkout started points to --resume, which sends only the PUT', async () => {
  const failPut = await smileys(CONFIRM_LAST(), {
    reply: (w) =>
      w.method === 'PUT'
        ? { ok: false, status: 422, body: {} }
        : { ok: true, status: 200, body: {} },
  });
  is(failPut.code, 1);
  ok(failPut.stderr.includes('--resume --confirm'), failPut.stderr);
  const resumed = await smileys(CONFIRM_LAST(['--resume']));
  is(resumed.code, 0, resumed.stderr);
  is(
    resumed.writes.map((w) => w.method),
    ['PUT']
  );
});

test('checkout success does not dump the customer record into the transcript', async () => {
  const r = await smileys(CONFIRM_LAST(), {
    reply: () => ({
      ok: true,
      status: 200,
      body: { data: { customer: { email: 'ada@example.org' } } },
    }),
  });
  is(r.code, 0, r.stderr);
  ok(!r.stdout.includes('ada@example.org'), r.stdout);
  ok(r.stdout.includes('verify with: smileys delivery'));
});

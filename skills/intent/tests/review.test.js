// Findings from the #473 code review (Codex, on 24c9454), one test each.
import test, { is, ok } from 'tst';
import * as intentMod from '../scripts/intent.js';
import * as coreMod from '../scripts/intent-core.js';
import * as kevMod from '../scripts/kev/kev-runtime.js';

const core = coreMod.default || coreMod;
const lib = intentMod.default || intentMod;
const kev = kevMod.default || kevMod;

const TAB = 'AB12';

/** An intent engine over a fake tab: the snapshot, page evals and VFS. */
function engine(
  snapshot,
  { scan = { clickable: [], disambiguation: [] }, pick = () => 'ok', state = null } = {}
) {
  const files = new Map();
  if (state) files.set(core.STATE, JSON.stringify(state));
  const fs = {
    async exists(p) {
      return files.has(p);
    },
    async readFile(p) {
      if (!files.has(p)) throw new Error(`ENOENT ${p}`);
      return files.get(p);
    },
    async writeFile(p, v) {
      files.set(p, String(v));
    },
    async mkdir() {},
    async rm(p) {
      files.delete(p);
    },
    async readDir() {
      return [];
    },
  };
  const spawned = [];
  const exec = {
    spawn: async (argv) => {
      spawned.push(argv);
      return argv[1] === 'snapshot'
        ? { exitCode: 0, stdout: snapshot, stderr: '' }
        : {
            exitCode: 0,
            stdout: argv[1] === 'tab-list' ? `[${TAB}] https://x "x"` : '',
            stderr: '',
          };
    },
  };
  const picks = [];
  const browser = {
    eval: async (_target, expr) => {
      const picked = /\)\((\{[\s\S]*\})\)$/.exec(expr);
      if (picked && expr.includes('function scan')) {
        const p = JSON.parse(picked[1]);
        picks.push(p);
        return pick(p);
      }
      if (expr.includes('function scan')) return JSON.stringify(scan);
      if (expr.includes('readyState')) return 'complete';
      if (expr.includes('innerWidth'))
        return JSON.stringify({ width: 1280, height: 800, scrollY: 0, scrollHeight: 800 });
      return '[]';
    },
  };
  const system1 = {
    name: 'kev test',
    key: '4b-vision',
    vision: false,
    intent: {},
    ask: async () => ({ answers: { action: { probabilities: {} } } }),
  };
  const { handle } = core.createIntent({ exec, fs, browser, system1 });
  return { handle, picks, spawned };
}

const CART = [
  'Page URL: https://shop.example/list',
  'Page Title: List',
  '- rootwebarea',
  '  - text "Lamp" [ref=e10]',
  '  - button "Add to cart" [ref=e1]',
  '  - text "Chair" [ref=e11]',
  '  - button "Add to cart" [ref=e2]',
].join('\n');

test('a renumbered ref keeps the remembered occurrence of a repeated control', async () => {
  // e1 was the 2nd "Add to cart" when the caller saw it; the page re-rendered
  // and e1 is now the 1st.
  const { handle } = engine(CART, {
    state: { tab: TAB, candidates: [{ ref: 'e1', role: 'button', label: 'Add to cart', k: 2 }] },
  });
  const out = await handle(
    { intent: 'click Add to cart', ref: 'e1', dryRun: true, tab: TAB, json: true },
    {}
  );
  is(JSON.parse(out.stdout).ref, 'e2');
});

const BOXES = [
  'Page URL: https://news.example/settings',
  'Page Title: Settings',
  '- rootwebarea',
  '  - text "Weekly digest" [ref=e10]',
  '  - checkbox "Subscribe" [ref=e1]',
  '  - text "Monthly digest" [ref=e11]',
  '  - checkbox "Subscribe" [ref=e2]',
].join('\n');
const TWO_BOXES = {
  clickable: [],
  disambiguation: [
    { name: 'Subscribe', b: [10, 10, 12, 12], ctx: 'Weekly digest' },
    { name: 'Subscribe', b: [10, 40, 12, 12], ctx: 'Monthly digest' },
  ],
};

test('uncheck on a repeated checkbox that is already unchecked does not click it', async () => {
  const { handle, picks } = engine(BOXES, {
    scan: TWO_BOXES,
    pick: (p) => (p.op === 'uncheck' ? 'already' : 'ok'),
  });
  const out = await handle(
    { intent: 'uncheck the Subscribe box for Monthly digest', ref: 'e2', tab: TAB, json: true },
    {}
  );
  const r = JSON.parse(out.stdout);
  ok(/already/.test(r.did), r.did);
  is(picks, [{ name: 'Subscribe', nth: 1, op: 'uncheck' }]);
});

test('select on a repeated dropdown sets the option, not just a click', async () => {
  const SIZES = [
    'Page URL: https://shop.example/cart',
    'Page Title: Cart',
    '- rootwebarea',
    '  - text "Lamp" [ref=e10]',
    '  - combobox "Quantity" [ref=e1]',
    '  - text "Chair" [ref=e11]',
    '  - combobox "Quantity" [ref=e2]',
  ].join('\n');
  const scan = {
    clickable: [],
    disambiguation: [
      { name: 'Quantity', b: [10, 10, 60, 20], ctx: 'Lamp' },
      { name: 'Quantity', b: [10, 40, 60, 20], ctx: 'Chair' },
    ],
  };
  const { handle, picks } = engine(SIZES, { scan });
  const out = await handle(
    { intent: 'select "3" from the Quantity for Chair', ref: 'e2', tab: TAB, json: true },
    {}
  );
  ok(/selected "3"/.test(JSON.parse(out.stdout).did), out.stdout);
  is(picks, [{ name: 'Quantity', nth: 1, op: 'select', value: '3' }]);
});

test('rawTab: --tab ID with a space names the tab too', () => {
  is(lib.rawTab(['click', 'e5', '--tab', 'AB12'], ''), 'AB12');
  is(lib.rawTab(['click', 'e5', '--tab=CD34'], ''), 'CD34');
});

test('a bundle manifest cannot name files outside its directory', () => {
  const manifest = (model) => ({
    files: {
      tokenizer: 'tokenizer.json',
      tokenizer_config: 'tokenizer_config.json',
      head: 'head.json',
    },
    variants: { q8f32: { model, data: [] } },
  });
  is(kev.variantFiles(manifest('model.onnx')).rels.length, 4);
  for (const bad of ['../../other/file', '/etc/passwd', 'a/../../b', '', 'a\\..\\b']) {
    let err = null;
    try {
      kev.variantFiles(manifest(bad));
    } catch (e) {
      err = e;
    }
    ok(err, `refused ${JSON.stringify(bad)}`);
  }
});

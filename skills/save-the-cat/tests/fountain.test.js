import test, { is, ok, rejects } from 'tst';
import * as _mod_0 from '../assets/render-fountain.js';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const __dirname = path.dirname(fileURLToPath(import.meta.url));

const { renderFountain } = _mod_0.default || _mod_0;
const source =
  'Title: Last Signal\nAuthor: Example Writer\n\nINT. OBSERVATORY - NIGHT #1#\n\nA **green light** blinks.\n\nMARA\n(quietly)\nSomebody is there.\n\nELI ^\nOr the machine is remembering.\n\n> CUT TO:\n\nEXT. MOUNTAIN - DAWN\n\n===\n\n[[private note]]\n\n/* omitted action */\n';

test('renders screenplay structure, emphasis, dual dialogue and stable review anchors', () => {
  const result = renderFountain(source, '/shared/draft.fountain');
  is(result.title, 'Last Signal');
  for (const expected of [
    'class="title-page"',
    'data-fountain-type="scene_heading"',
    'class="dialogue left"',
    'class="dialogue right"',
    'class="parenthetical"',
    'class="bold"',
    'data-fountain-type="page_break"',
    'data-scene="INT. OBSERVATORY - NIGHT"',
  ])
    ok(result.html.includes(expected), expected);
  ok(!result.html.includes('omitted action'));
  const ids = [...result.html.matchAll(/ id="(fountain-\d+)"/g)].map((m) => m[1]);
  is(new Set(ids).size, ids.length);
  is(renderFountain(source).html, renderFountain(source).html);
});

test('source HTML and scene numbers cannot inject executable markup', () => {
  const result = renderFountain(
    'Title: <img src=x onerror=alert(1)>\n\nINT. ROOM - DAY #" onmouseover="alert(1)#\n\n<script>alert(1)</script>\n'
  );
  ok(!result.html.includes('<script>'));
  ok(!result.html.includes('<img src=x'));
  ok(!result.html.includes('id="" onmouseover'));
  ok(result.html.includes('&lt;script&gt;'));
});

test('empty, CRLF, Unicode, forced headings and dialogue are handled', () => {
  is(renderFountain('', '/shared/empty.fountain').title, 'empty.fountain');
  const result = renderFountain('.雪の駅\r\n\r\n@ÉLISE\r\nBonjour.\r\n');
  ok(result.html.includes('data-fountain-type="scene_heading"'));
  ok(result.html.includes('雪の駅'));
  ok(result.html.includes('ÉLISE'));
});

async function run(args, delivery = 0, env = {}) {
  const messages = [],
    output = [],
    written = [];
  const argv = ['node', '/custom/save-the-cat/scripts/fountain.jsh', ...args];
  argv.parseFlags = () => {
    const positional = [],
      flags = {};
    for (let i = 0; i < args.length; i++) {
      if (args[i].startsWith('--'))
        flags[args[i].slice(2)] = ['--json', '--help'].includes(args[i]) ? true : args[++i];
      else positional.push(args[i]);
    }
    return { positional, flags };
  };
  const req = (id) => {
    if (id === 'fs')
      return { readFile: async () => source, writeFile: async (...a) => written.push(a) };
    if (id === 'path') return path.posix;
    if (id === '../assets/render-fountain.js') return { renderFountain };
    if (id === 'sliccy:exec')
      return {
        spawn: async (a) => {
          messages.push(a);
          return { exitCode: delivery, stderr: delivery ? 'Panel closed' : '' };
        },
      };
    if (id === 'sliccy:cli')
      return {
        out: (v) => output.push(v),
        help: (v) => output.push(v),
        die: (m) => {
          const e = Error(m);
          e.name = 'NodeExitError';
          throw e;
        },
      };
    throw Error('Unexpected dependency: ' + id);
  };
  const program = fs.readFileSync(path.join(__dirname, '../scripts/fountain.jsh'), 'utf8');
  await new (Object.getPrototypeOf(async function () {}).constructor)(
    'require',
    'process',
    program
  )(req, { argv, cwd: () => '/shared', env });
  return { messages, output, written };
}

test('render --json returns a complete preview, without queue side effects', async () => {
  const r = await run(['render', 'draft.fountain', '--json']);
  is(r.output[0].path, '/shared/draft.fountain');
  is(r.output[0].format, 'fountain');
  is(r.messages.length, 0);
});

test('review opens the source, preserves literal paths, and reports failed delivery', async () => {
  const name = "a '$(echo test)'.fountain";
  const r = await run(['review', name]);
  is(r.messages.length, 2);
  const [item, open] = r.messages.map((a) => JSON.parse(a[3]));
  is(item.path, '/shared/' + name);
  is(item.action, 'ensure-item');
  is(item.cone, undefined);
  is(open.path, item.path);
  is(open.id, item.id);
  await rejects(() => run(['review', 'draft.fountain'], 1), /Open the Review sprinkle/);
});

test('review stamps the filing cone from TMPDIR on ensure-item', async () => {
  const r = await run(['review', 'draft.fountain'], 0, { TMPDIR: '/tmp/cone-helix' });
  const item = JSON.parse(r.messages[0][3]);
  is(item.action, 'ensure-item');
  is(item.cone, 'cone-helix');
  const open = JSON.parse(r.messages[1][3]);
  is(open.cone, undefined);
});

test('render refuses to overwrite its Fountain source', async () => {
  await rejects(
    () => run(['render', 'draft.fountain', '--out', 'draft.fountain']),
    /different output path/
  );
});

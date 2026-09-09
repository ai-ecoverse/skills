const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { renderFountain } = require('../assets/render-fountain');
const source =
  'Title: Last Signal\nAuthor: Example Writer\n\nINT. OBSERVATORY - NIGHT #1#\n\nA **green light** blinks.\n\nMARA\n(quietly)\nSomebody is there.\n\nELI ^\nOr the machine is remembering.\n\n> CUT TO:\n\nEXT. MOUNTAIN - DAWN\n\n===\n\n[[private note]]\n\n/* omitted action */\n';

test('renders screenplay structure, emphasis, dual dialogue and stable review anchors', () => {
  const result = renderFountain(source, '/shared/draft.fountain');
  assert.equal(result.title, 'Last Signal');
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
    assert.ok(result.html.includes(expected), expected);
  assert.ok(!result.html.includes('omitted action'));
  const ids = [...result.html.matchAll(/ id="(fountain-\d+)"/g)].map((m) => m[1]);
  assert.equal(new Set(ids).size, ids.length);
  assert.equal(renderFountain(source).html, renderFountain(source).html);
});

test('source HTML and scene numbers cannot inject executable markup', () => {
  const result = renderFountain(
    'Title: <img src=x onerror=alert(1)>\n\nINT. ROOM - DAY #" onmouseover="alert(1)#\n\n<script>alert(1)</script>\n'
  );
  assert.ok(!result.html.includes('<script>'));
  assert.ok(!result.html.includes('<img src=x'));
  assert.ok(!result.html.includes('id="" onmouseover'));
  assert.ok(result.html.includes('&lt;script&gt;'));
});

test('empty, CRLF, Unicode, forced headings and dialogue are handled', () => {
  assert.equal(renderFountain('', '/shared/empty.fountain').title, 'empty.fountain');
  const result = renderFountain('.雪の駅\r\n\r\n@ÉLISE\r\nBonjour.\r\n');
  assert.ok(result.html.includes('data-fountain-type="scene_heading"'));
  assert.ok(result.html.includes('雪の駅'));
  assert.ok(result.html.includes('ÉLISE'));
});

async function run(args, delivery = 0) {
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
  )(req, { argv, cwd: () => '/shared' });
  return { messages, output, written };
}

test('render --json returns a complete preview, without queue side effects', async () => {
  const r = await run(['render', 'draft.fountain', '--json']);
  assert.equal(r.output[0].path, '/shared/draft.fountain');
  assert.equal(r.output[0].format, 'fountain');
  assert.equal(r.messages.length, 0);
});

test('review opens the source, preserves literal paths, and reports failed delivery', async () => {
  const name = "a '$(echo test)'.fountain";
  const r = await run(['review', name]);
  assert.equal(r.messages.length, 2);
  const [item, open] = r.messages.map((a) => JSON.parse(a[3]));
  assert.equal(item.path, '/shared/' + name);
  assert.equal(item.action, 'ensure-item');
  assert.equal(open.path, item.path);
  assert.equal(open.id, item.id);
  await assert.rejects(run(['review', 'draft.fountain'], 1), /Open the Review sprinkle/);
});

test('render refuses to overwrite its Fountain source', async () => {
  await assert.rejects(
    run(['render', 'draft.fountain', '--out', 'draft.fountain']),
    /different output path/
  );
});

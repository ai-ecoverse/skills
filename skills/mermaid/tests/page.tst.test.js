import test, { is, ok } from 'tst';
import * as pageMod from '../scripts/render-page.js';

const page = pageMod.default || pageMod;
const {
  THEMES,
  RENDER_TIMEOUT_MS,
  awaitRender,
  entrySource,
  parseArgs,
  pageHtml,
  targetIdFrom,
  checkSvg,
} = page;

test('parseArgs accepts a bare file, render, theme, and -o', () => {
  const bare = parseArgs(['diagram.mmd', '-o', 'out.svg', '--theme', 'dark']);
  is(bare.positional, ['diagram.mmd']);
  is(bare.flags.output, 'out.svg');
  is(bare.flags.theme, 'dark');

  const rendered = parseArgs(['render', '-', '--theme=forest', '--output=a.svg']);
  is(rendered.positional, ['render', '-']);
  is(rendered.flags.theme, 'forest');
  is(rendered.flags.output, 'a.svg');
});

test('parseArgs rejects an unknown flag and a missing value', () => {
  ok(parseArgs(['--nope']).error.includes('unknown option: --nope'));
  ok(parseArgs(['--theme']).error.includes('--theme needs a name'));
  ok(parseArgs(['-o']).error.includes('-o needs a path'));
});

test('pageHtml keeps diagram text inside JSON and escapes a script closer', () => {
  const html = pageHtml({
    source: 'flowchart LR\n  A["</script><b>x</b>"] --> B',
    theme: 'neutral',
    bundle: 'var x = "</script>";',
  });
  ok(html.includes("securityLevel: 'strict'"));
  ok(html.includes('globalThis.__sliccMermaid'));
  ok(!html.includes('</script><b>'));
  ok(html.includes('\\u003c/script'));
  ok(html.includes('<\\/script'));
  ok(html.includes('"neutral"'));
  ok(THEMES.includes('neutral'));
});

test('targetIdFrom reads the open command suffix', () => {
  is(
    targetIdFrom('opened /tmp/x.html → https://preview.example/x (targetId: ABC_123)\n'),
    'ABC_123'
  );
  is(targetIdFrom('opened /tmp/x.html\n'), null);
});

test('checkSvg accepts only a whole SVG document', () => {
  is(checkSvg('<svg>x</svg>'), null);
  is(checkSvg('  <svg>x</svg>\n'), null);
  ok(checkSvg('<svg>x</s').includes('no complete SVG'));
  ok(checkSvg('<div></div>').includes('no complete SVG'));
  ok(checkSvg(undefined).includes('no complete SVG'));
});

test('awaitRender stands alone (it runs in the page) and waits RENDER_TIMEOUT_MS', () => {
  const src = awaitRender.toString();
  ok(src.includes(`Date.now() + ${RENDER_TIMEOUT_MS}`), 'the literal timeout matches the constant');
  ok(src.includes('dataset') && src.includes('getElementById'));
});

test("entrySource imports the package's own ESM entry file and publishes it", () => {
  const s = entrySource('/shared/lib/node_modules/mermaid', { module: './dist/mermaid.core.mjs' });
  ok(
    s.includes('import mermaid from "/shared/lib/node_modules/mermaid/dist/mermaid.core.mjs";'),
    s
  );
  ok(entrySource('/m', { main: 'index.js' }).includes('from "/m/index.js"'));
  ok(s.includes('globalThis.__sliccMermaid = mermaid;'));
});

test('parseArgs refuses empty --theme= and --output=', () => {
  ok(parseArgs(['--theme=']).error.includes('--theme needs a name'));
  ok(parseArgs(['--output=']).error.includes('-o needs a path'));
});

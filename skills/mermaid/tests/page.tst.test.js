import test, { is, ok } from 'tst';
import * as pageMod from '../scripts/render-page.js';

const page = pageMod.default || pageMod;
const { THEMES, POLL_EXPR, parseArgs, pageHtml, targetIdFrom, splitRenderResult } = page;

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

test('splitRenderResult distinguishes pending, svg, and errors', () => {
  is(splitRenderResult('PENDING\n'), { pending: true });
  is(splitRenderResult('ok\n<svg></svg>\n'), { svg: '<svg></svg>' });
  is(splitRenderResult('ok\n<svg>\n</svg>\n\n'), { svg: '<svg>\n</svg>\n' });
  is(splitRenderResult('err\nParse error\n'), { error: 'Parse error' });
});

test('POLL_EXPR reads the ready flag the page sets', () => {
  ok(POLL_EXPR.includes('dataset.ready'));
  ok(POLL_EXPR.includes('PENDING'));
  ok(POLL_EXPR.includes('getElementById("out")'));
});

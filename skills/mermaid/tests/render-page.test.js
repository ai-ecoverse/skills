const assert = require('node:assert/strict');
const test = require('node:test');
const {
  THEMES,
  POLL_EXPR,
  parseArgs,
  pageHtml,
  targetIdFrom,
  splitRenderResult,
} = require('../scripts/render-page.js');

test('parseArgs accepts a bare file, render, theme, and -o', () => {
  const bare = parseArgs(['diagram.mmd', '-o', 'out.svg', '--theme', 'dark']);
  assert.deepEqual(bare.positional, ['diagram.mmd']);
  assert.equal(bare.flags.output, 'out.svg');
  assert.equal(bare.flags.theme, 'dark');

  const rendered = parseArgs(['render', '-', '--theme=forest', '--output=a.svg']);
  assert.deepEqual(rendered.positional, ['render', '-']);
  assert.equal(rendered.flags.theme, 'forest');
  assert.equal(rendered.flags.output, 'a.svg');
});

test('parseArgs rejects an unknown flag and a missing value', () => {
  assert.match(parseArgs(['--nope']).error, /unknown option: --nope/);
  assert.match(parseArgs(['--theme']).error, /--theme needs a name/);
  assert.match(parseArgs(['-o']).error, /-o needs a path/);
});

test('pageHtml keeps diagram text inside JSON and escapes a script closer', () => {
  const html = pageHtml({
    source: 'flowchart LR\n  A["</script><b>x</b>"] --> B',
    theme: 'neutral',
    bundle: 'var x = "</script>";',
  });
  assert.match(html, /securityLevel: 'strict'/);
  assert.match(html, /globalThis\.__sliccMermaid/);
  assert.equal(html.includes('</script><b>'), false);
  assert.match(html, /\\u003c\/script/);
  assert.match(html, /<\\\/script/);
  assert.match(html, /"neutral"/);
  assert.ok(THEMES.includes('neutral'));
});

test('targetIdFrom reads the open command suffix', () => {
  assert.equal(
    targetIdFrom('opened /tmp/x.html → https://preview.example/x (targetId: ABC_123)\n'),
    'ABC_123'
  );
  assert.equal(targetIdFrom('opened /tmp/x.html\n'), null);
});

test('splitRenderResult distinguishes pending, svg, and errors', () => {
  assert.deepEqual(splitRenderResult('PENDING\n'), { pending: true });
  assert.deepEqual(splitRenderResult('ok\n<svg></svg>\n'), { svg: '<svg></svg>' });
  assert.deepEqual(splitRenderResult('ok\n<svg>\n</svg>\n\n'), { svg: '<svg>\n</svg>\n' });
  assert.deepEqual(splitRenderResult('err\nParse error\n'), { error: 'Parse error' });
});

test('POLL_EXPR reads the ready flag the page sets', () => {
  assert.match(POLL_EXPR, /dataset\.ready/);
  assert.match(POLL_EXPR, /PENDING/);
  assert.match(POLL_EXPR, /getElementById\("out"\)/);
});

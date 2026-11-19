import test, { is, ok } from 'tst';
import { render } from './markdown.js';

const run = (cases) => {
  const r = render(cases);
  ok(r.ok, `the renderer finished: ${JSON.stringify(r)}`);
  return r.ok ? r.out : cases.map(() => '');
};

test('every block the renderer knows ends, whatever its first line looks like', async () => {
  const inputs = [
    '| Name | Value\n| --- | ---\n| status | ready',
    '| a pipe-led line that is not a table',
    '|',
    '| x |\n| y |',
    'text\n| a pipe after text',
    '```\nunterminated fence',
    '#',
    '# ',
    '>',
    '- ',
    '---',
    '- - -',
    '1.',
    '|---|---|',
    '\r\n\r\n|\r\n',
    'a\n\n\n\n|b|\n|-|',
  ];
  const out = run(inputs.map((md) => ['markdown', md, 'x/y']));
  is(out.length, inputs.length, 'one rendering per input');
  for (const html of out) ok(typeof html === 'string', 'a string');
});

test('a table needs no outer pipes, and a pipe-led line that is no table stays a paragraph', async () => {
  const [table, lone] = run([
    ['markdown', '| Name | Value\n| --- | ---\n| status | ready', 'x'],
    ['markdown', '| not a table', 'x'],
  ]);
  is(
    table,
    '<table><thead><tr><th>Name</th><th>Value</th></tr></thead><tbody><tr><td>status</td><td>ready</td></tr></tbody></table>'
  );
  is(lone, '<p>| not a table</p>');
});

test('the renderer escapes HTML, drops script links and keeps http(s) ones', async () => {
  const [script, js, data, web, attr] = run([
    ['markdown', '<script>alert(1)</script>', 'x'],
    ['inline', '[click](JavaScript:alert.call)', 'x'],
    ['inline', '[img](data:text/html,hi)', 'x'],
    ['inline', '[spec](https://example.com/a?b=1&c=2)', 'x'],
    ['inline', '[t](https://e.x/"onmouseover="alert(1))', 'x'],
  ]);
  is(script, '<p>&lt;script&gt;alert(1)&lt;/script&gt;</p>');
  is(js, 'click');
  is(data, 'img');
  is(
    web,
    '<a href="https://example.com/a?b=1&amp;c=2" target="_blank" rel="noopener noreferrer">spec</a>'
  );
  ok(!attr.includes('" onmouseover'), attr);
});

test('footnote references become superscripts, as rule 4 asks for on every claim', async () => {
  const [ref, def] = run([
    ['inline', 'The model drops recurrence.[^arxiv]', 'x'],
    ['markdown', '[^arxiv]: arXiv 1706.03762', 'x'],
  ]);
  is(ref, 'The model drops recurrence.<sup>[arxiv]</sup>');
  is(def, '<p><sup>[arxiv]</sup>: arXiv 1706.03762</p>');
});

test('links to concepts resolve against the concept they are in', async () => {
  const out = run([
    ['resolveId', '/tables/events.md', 'datasets/ga4'],
    ['resolveId', '../tables/events.md', 'playbooks/freshness'],
    ['resolveId', 'sibling.md#part', 'playbooks/freshness'],
    ['resolveId', 'events.md', 'top'],
    ['resolveId', '//evil.example/x.md', 'a/b'],
    ['resolveId', 'https://example.com/x.md', 'a/b'],
    ['resolveId', '../../../x.md', 'a/b'],
    ['inline', '[events](../tables/events.md)', 'playbooks/freshness'],
    ['inline', '[Café Royal](/places/café royal.md)', 'people/ada'],
    ['inline', '[spec](https://example.com/spec "The spec")', 'x'],
    ['inline', '[seen](notes.md "Notes")', 'people/ada'],
  ]);
  is(out.slice(0, 7), [
    'tables/events',
    'tables/events',
    'playbooks/sibling',
    'events',
    null,
    null,
    'x',
  ]);
  is(out[7], '<button type="button" class="link" data-open="tables/events">events</button>');
  is(
    out[8],
    '<button type="button" class="link" data-open="places/café royal">Café Royal</button>',
    'okf keeps spaces in link paths as they are, and so does the panel'
  );
  is(
    out[9],
    '<a href="https://example.com/spec" target="_blank" rel="noopener noreferrer">spec</a>'
  );
  is(out[10], '<button type="button" class="link" data-open="people/notes">seen</button>');
});

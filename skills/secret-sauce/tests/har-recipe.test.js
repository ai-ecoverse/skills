import fs from 'node:fs';
import path from 'node:path';
import test, { is, ok } from 'tst';

const read = (rel) => fs.readFileSync(path.join(process.cwd(), rel), 'utf8');
const SKILL = read('SKILL.md');
const FILTER_DOC = read('references/har-filter.md');

function section(text, start, end) {
  const from = text.indexOf(start);
  if (from < 0) return '';
  const to = end ? text.indexOf(end, from + start.length) : -1;
  return text.slice(from, to < 0 ? undefined : to);
}

function sevenFilters(text) {
  return [...text.matchAll(/(?:--filter=|--url-filter )'([^']*)'/g)].map((m) => m[1]);
}

const refusedBySeven = (glob) =>
  glob.includes('=>') || glob.includes('function') || glob.includes(';');

test('SKILL.md says how to tell SLICC 7 from SLICC 6', () => {
  ok(SKILL.includes('playwright-cli --version'));
  ok(SKILL.includes('**SLICC 7**'));
  ok(SKILL.includes('**SLICC 6**'));
});

test('every SLICC 7 record filter in SKILL.md is a URL glob seven accepts', () => {
  const seven = section(SKILL, '**SLICC 7**', '**SLICC 6**');
  const globs = sevenFilters(seven);
  ok(globs.length >= 2, `found ${globs.length} globs`);
  is(globs.filter(refusedBySeven), []);
  ok(/playwright-cli -s capture record \S+ --filter='[^']+' --content embed/.test(seven));
});

test('the SLICC 7 holder keeps stdin open and is stopped in the same session', () => {
  const seven = section(SKILL, '**SLICC 7**', '**SLICC 6**');
  ok(/: > \/tmp\/har-events\.jsonl\n\(sleep \d+ \| playwright-cli -s capture record /.test(seven));
  ok(/do \[ -s \/tmp\/har-events\.jsonl \] && break; sleep 1; done; head -1/.test(seven));
  ok(seven.includes('playwright-cli -s capture stop-recording'));
  ok(seven.includes('/recordings/<recordingId>/recording.har'));
  ok(seven.includes('--include-credentials'));
});

test('the SLICC 6 JS filter stays in the SLICC 6 section only', () => {
  const six = section(SKILL, '**SLICC 6**', '**Extract from HAR:**');
  ok(six.includes('playwright-cli record https://app.example.com --filter="(e) =>'));
  const seven = section(SKILL, '**SLICC 7**', '**SLICC 6**');
  is(seven.includes('(e) =>'), false);
});

test('har-filter.md lists only globs that seven accepts', () => {
  const seven = section(FILTER_DOC, '## SLICC 7', '## SLICC 6');
  const globs = [...seven.matchAll(/\| `'([^']+)'` \|/g)].map((m) => m[1]);
  ok(globs.length >= 4, `found ${globs.length} globs`);
  is(globs.filter(refusedBySeven), []);
});

test('the annotated SLICC 6 predicate keeps API JSON and drops noise', () => {
  const src = /```js\n([\s\S]*?)\n```/g;
  const blocks = [...FILTER_DOC.matchAll(src)].map((m) => m[1]);
  const predicate = blocks.find((b) => b.trimStart().startsWith('(e) =>'));
  ok(predicate, 'predicate block present');
  const keep = new Function(`return (${predicate});`)();
  const entry = (url, ct) => ({
    request: { url },
    response: { headers: [{ name: 'Content-Type', value: ct }] },
  });
  is(keep(entry('https://app.example.com/data', 'application/json; charset=utf-8')), true);
  is(keep(entry('https://app.example.com/logo.png', 'image/png')), false);
  is(keep(entry('https://www.google-analytics.com/collect', 'application/json')), false);
  is(keep(entry('https://app.example.com/api/items', 'text/plain')), true);
  is(keep({ request: { url: 'https://app.example.com/api/x' } }), false);
});

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const template = fs.readFileSync(path.join(__dirname, '../templates/review.shtml'), 'utf8');
function extract(start, end) {
  const a = template.indexOf(start),
    b = template.indexOf(end, a);
  assert.ok(a >= 0 && b > a, 'shipped preview implementation is present');
  return template.slice(a, b);
}
function store(state) {
  return new Function(
    'state',
    extract('function documentKey(', 'function openDocument(') +
      '\nreturn {documentKey,currentDocument,annotations};'
  )(state);
}

test('open-file overrides the queued source and title while retaining item metadata', () => {
  const item = { id: 'draft', path: '/old.md', title: 'Old title', type: 'document' };
  const open = new Function(
    'state',
    'openPreview',
    extract('function openDocument(', 'async function openPreview(') + '\nreturn openDocument;'
  )({ items: [item] }, (preview) => preview);
  assert.deepEqual(open('/moved.md', 'Revised title', 'draft'), {
    ...item,
    path: '/moved.md',
    title: 'Revised title',
  });
  assert.deepEqual(open('/moved.md', null, 'draft'), { ...item, path: '/moved.md' });
  assert.deepEqual(open('/old.md', 'Title only'), { ...item, title: 'Title only' });
  assert.equal(item.path, '/old.md', 'a preview override does not mutate the queue');
  assert.deepEqual(open('/new.md', 'New document', 'new'), {
    id: 'new',
    path: '/new.md',
    title: 'New document',
  });
});

test('text anchors use the selected occurrence, including normalized boundary whitespace', () => {
  const anchorFor = new Function(
    'textOf',
    'selectorFor',
    extract('function anchorFor(', 'function selectForComment(') + '\nreturn anchorFor;'
  )(
    (el) => el.textContent.replace(/\s+/g, ' ').trim(),
    () => '#paragraph'
  );
  const source = '  First: echo.\n\t Next:   echo. Last: echo.  ';
  const el = { textContent: source, localName: 'p', closest: () => null };
  const second = source.indexOf('echo', source.indexOf('echo') + 1);
  const cases = [
    {
      start: source.indexOf('echo'),
      end: source.indexOf('echo') + 4,
      prefix: 'First: ',
      suffix: '. Next: echo. Last: echo.',
    },
    { start: second, end: second + 4, prefix: 'First: echo. Next: ', suffix: '. Last: echo.' },
    { start: second - 2, end: second + 4, prefix: 'First: echo. Next: ', suffix: '. Last: echo.' },
    { start: 0, end: source.length, prefix: '', suffix: '' },
  ];
  for (const { start, end, prefix, suffix } of cases) {
    const range = {
      startContainer: el,
      startOffset: start,
      toString: () => source.slice(start, end),
      cloneRange: () => ({
        selectNodeContents: () => {},
        setEnd: (node, offset) => {
          assert.equal(node, el);
          assert.equal(offset, start);
        },
        toString: () => source.slice(0, start),
      }),
    };
    const quote = range.toString().replace(/\s+/g, ' ').trim();
    const anchor = anchorFor(el, quote, range);
    assert.equal(anchor.prefix, prefix);
    assert.equal(anchor.suffix, suffix);
    assert.equal(anchor.kind, 'text');
    assert.equal(anchor.quote, quote);
  }
  const whole = anchorFor(el, source.replace(/\s+/g, ' ').trim(), null);
  assert.equal(whole.kind, 'element');
  assert.equal(whole.prefix, '');
  assert.equal(whole.suffix, '');
});

test('drafts are keyed to the source and survive switching documents or preview URLs', () => {
  const state = { docItem: { path: '/shared/a.md', previewUrl: 'https://one.test/a' } };
  const s = store(state);
  s.annotations().push({ id: 'a', note: 'Keep this draft' });
  state.docItem = { path: '/shared/b.md' };
  assert.equal(s.annotations().length, 0);
  s.annotations().push({ id: 'b' });
  state.docItem = { path: '/shared/a.md', previewUrl: 'https://two.test/a' };
  assert.deepEqual(s.annotations(), [{ id: 'a', note: 'Keep this draft' }]);
  state.docItem = { previewUrl: 'https://one.test/a' };
  assert.equal(s.annotations().length, 0);
});

function dispatch(notes, fail = false) {
  let click;
  const events = [],
    saves = [];
  const document = {
    getElementById: () => ({
      addEventListener: (_, fn) => {
        click = fn;
      },
    }),
  };
  const slicc = {
    lick: (event) => {
      if (fail) throw Error('Bridge unavailable');
      events.push(event);
    },
  };
  const code = extract(
    "document.getElementById('submit-btn').addEventListener",
    "document.getElementById('annotations-toggle').addEventListener"
  );
  new Function(
    'document',
    'slicc',
    'annotations',
    'state',
    'currentDocument',
    'saveState',
    'renderAnnotationsList',
    'updateSubmitBtn',
    'crypto',
    code
  )(
    document,
    slicc,
    () => notes,
    { docItem: { id: 'script', path: '/shared/draft.fountain' } },
    () => ({ format: 'fountain' }),
    () => saves.push(JSON.parse(JSON.stringify(notes))),
    () => {},
    () => {},
    { randomUUID: () => String(saves.length + 1) }
  );
  return { click, events, saves };
}

test('dispatch sends only drafts with anchors and records the batch before delivery', () => {
  const notes = [
    { id: 'old', text: 'Old', note: 'Already sent', batchId: 'previous' },
    { id: 'new', text: 'Hello', note: 'Quieter', anchor: { scene: 'INT. ROOM', token: '7' } },
  ];
  const d = dispatch(notes);
  d.click();
  d.click();
  assert.equal(d.events.length, 1);
  assert.equal(d.events[0].data.path, '/shared/draft.fountain');
  assert.equal(d.events[0].data.format, 'fountain');
  assert.deepEqual(d.events[0].data.revisions, [
    { id: 'new', text: 'Hello', note: 'Quieter', anchor: { scene: 'INT. ROOM', token: '7' } },
  ]);
  assert.equal(d.saves[0][1].batchId, d.events[0].data.batchId);
  assert.equal(notes[0].batchId, 'previous');
});

test('a synchronous delivery failure restores drafts rather than losing feedback', () => {
  const notes = [{ id: 'new', text: 'Hello', note: 'Quieter' }];
  const d = dispatch(notes, true);
  d.click();
  assert.equal(notes[0].batchId, undefined);
  assert.equal(notes[0].deliveryError, 'Bridge unavailable');
  assert.equal(notes[0].note, 'Quieter');
});

test('anchor recovery verifies content and rejects an ambiguous relocated quote', () => {
  const old = { textContent: 'A changed paragraph' },
    match = { textContent: 'Original paragraph' };
  let candidates = [match];
  const previewFrame = {
    contentDocument: { querySelector: () => old, querySelectorAll: () => candidates },
  };
  const find = new Function(
    'previewFrame',
    'textOf',
    'BLOCKS',
    extract('function findAnchor(', 'function paintAnnotations(') + '\nreturn findAnchor;'
  )(previewFrame, (e) => e.textContent, 'p');
  const ann = { anchor: { selector: '#same-id', elementText: 'Original paragraph' } };
  assert.equal(find(ann), match);
  candidates = [match, { ...match }];
  assert.equal(find(ann), null);
  old.textContent = 'Original paragraph';
  assert.equal(find(ann), old);
});

test('command arguments preserve quotes and shell metacharacters literally', () => {
  const quote = new Function(
    extract('function quoteArg(', 'let previewEpoch') + '\nreturn quoteArg;'
  )();
  assert.equal(quote("a '$(echo x)'.fountain"), "'a '\\''$(echo x)'\\''.fountain'");
});

test('standalone hydration reads durable state and waits if the host store is inaccessible', () => {
  const source = extract('function standaloneSavedState(', '// _stateReady');
  const saved = {
    view: 'document',
    documents: { 'path:/a.md': { annotations: [{ note: 'Keep this' }] } },
  };
  const read = new Function('parent', 'slicc', source + '\nreturn standaloneSavedState;');
  const storage = {
    getItem: (key) => {
      assert.equal(key, 'slicc-sprinkle-state:review');
      return JSON.stringify(saved);
    },
  };
  assert.deepEqual(read({ localStorage: storage }, { name: 'review' })(), saved);
  assert.equal(
    read(
      {
        get localStorage() {
          throw Error('Cross-origin');
        },
      },
      {}
    )(),
    undefined
  );
  assert.equal(read({ localStorage: { getItem: () => '{bad' } }, {})(), undefined);
});

test('Fountain anchors never follow matching dialogue into a different scene', () => {
  const wrong = { textContent: 'Yes.', closest: () => ({ dataset: { scene: 'INT. OTHER ROOM' } }) };
  const frame = {
    contentDocument: { querySelector: () => wrong, querySelectorAll: () => [wrong] },
  };
  const find = new Function(
    'previewFrame',
    'textOf',
    'BLOCKS',
    extract('function findAnchor(', 'function paintAnnotations(') + '\nreturn findAnchor;'
  )(frame, (e) => e.textContent, 'p');
  assert.equal(
    find({ anchor: { selector: '#fountain-4', elementText: 'Yes.', scene: 'INT. KITCHEN' } }),
    null
  );
});

import test, { is, ok } from 'tst';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const __dirname = path.dirname(fileURLToPath(import.meta.url));

const template = fs.readFileSync(path.join(__dirname, '../templates/review.shtml'), 'utf8');
function extract(start, end) {
  const a = template.indexOf(start),
    b = template.indexOf(end, a);
  ok(a >= 0 && b > a, 'shipped preview implementation is present');
  return template.slice(a, b);
}
function store(state) {
  return new Function(
    'state',
    extract('function documentKey(', 'function openDocument(') +
      '\nreturn {documentKey,currentDocument,annotations};'
  )(state);
}

test('primary labels default to Approve and accept only non-empty source text', () => {
  const label = new Function(
    extract('function primaryActionLabel(', 'function createItemCard(') +
      '\nreturn primaryActionLabel;'
  )();
  for (const value of [undefined, null, '', '  ', false, 42, {}]) {
    is(label({ primaryActionLabel: value }), 'Approve');
  }
  is(label({ primaryActionLabel: ' Publish ' }), 'Publish');
  is(label({ primaryActionLabel: 'Accept draft' }), 'Accept draft');
});

test('open-file overrides the queued source and title while retaining item metadata', () => {
  const item = { id: 'draft', path: '/old.md', title: 'Old title', type: 'document' };
  const open = new Function(
    'state',
    'openPreview',
    extract('function openDocument(', 'async function openPreview(') + '\nreturn openDocument;'
  )({ items: [item] }, (preview) => preview);
  is(open('/moved.md', 'Revised title', 'draft'), {
    ...item,
    path: '/moved.md',
    title: 'Revised title',
  });
  is(open('/moved.md', null, 'draft'), { ...item, path: '/moved.md' });
  is(open('/old.md', 'Title only'), { ...item, title: 'Title only' });
  is(item.path, '/old.md', 'a preview override does not mutate the queue');
  is(open('/new.md', 'New document', 'new'), {
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
          is(node, el);
          is(offset, start);
        },
        toString: () => source.slice(0, start),
      }),
    };
    const quote = range.toString().replace(/\s+/g, ' ').trim();
    const anchor = anchorFor(el, quote, range);
    is(anchor.prefix, prefix);
    is(anchor.suffix, suffix);
    is(anchor.kind, 'text');
    is(anchor.quote, quote);
  }
  const whole = anchorFor(el, source.replace(/\s+/g, ' ').trim(), null);
  is(whole.kind, 'element');
  is(whole.prefix, '');
  is(whole.suffix, '');
});

test('drafts are keyed to the source and survive switching documents or preview URLs', () => {
  const state = { docItem: { path: '/shared/a.md', previewUrl: 'https://one.test/a' } };
  const s = store(state);
  s.annotations().push({ id: 'a', note: 'Keep this draft' });
  state.docItem = { path: '/shared/b.md' };
  is(s.annotations().length, 0);
  s.annotations().push({ id: 'b' });
  state.docItem = { path: '/shared/a.md', previewUrl: 'https://two.test/a' };
  is(s.annotations(), [{ id: 'a', note: 'Keep this draft' }]);
  state.docItem = { previewUrl: 'https://one.test/a' };
  is(s.annotations().length, 0);
});

function dispatch(notes, fail = false, extraState = {}) {
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
  const lickBoundSrc = extract('function lickBound(', 'function handleItemAction(');
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
    lickBoundSrc + '\n' + code
  )(
    document,
    slicc,
    () => notes,
    {
      docItem: { id: 'script', path: '/shared/draft.fountain', cone: 'cone-adobe' },
      items: [],
      ...extraState,
    },
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
  is(d.events.length, 1);
  is(d.events[0].target, 'cone-adobe');
  is(d.events[0].data.path, '/shared/draft.fountain');
  is(d.events[0].data.format, 'fountain');
  is(d.events[0].data.revisions, [
    { id: 'new', text: 'Hello', note: 'Quieter', anchor: { scene: 'INT. ROOM', token: '7' } },
  ]);
  is(d.saves[0][1].batchId, d.events[0].data.batchId);
  is(notes[0].batchId, 'previous');
});

test('submit-revisions uses the queue card cone when the open snapshot is stale', () => {
  const notes = [
    { id: 'new', text: 'Hello', note: 'Quieter', anchor: { scene: 'INT. ROOM', token: '7' } },
  ];
  const d = dispatch(notes, false, {
    docItem: { id: 'script', path: '/shared/draft.fountain', cone: 'cone-old' },
    items: [{ id: 'script', path: '/shared/draft.fountain', cone: 'cone-helix' }],
  });
  d.click();
  is(d.events[0].target, 'cone-helix');
  is(d.events[0].data.path, '/shared/draft.fountain');
});

test('a synchronous delivery failure restores drafts rather than losing feedback', () => {
  const notes = [{ id: 'new', text: 'Hello', note: 'Quieter' }];
  const d = dispatch(notes, true);
  d.click();
  is(notes[0].batchId, undefined);
  is(notes[0].deliveryError, 'Bridge unavailable');
  is(notes[0].note, 'Quieter');
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
  is(find(ann), match);
  candidates = [match, { ...match }];
  is(find(ann), null);
  old.textContent = 'Original paragraph';
  // Identity, not deep equality — old and match share the same properties once
  // the selector target is valid again; is() would also pass for match.
  ok(find(ann) === old, 'recovered selector target by identity');
});

test('command arguments preserve quotes and shell metacharacters literally', () => {
  const quote = new Function(
    extract('function quoteArg(', 'let previewEpoch') + '\nreturn quoteArg;'
  )();
  is(quote("a '$(echo x)'.fountain"), "'a '\\''$(echo x)'\\''.fountain'");
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
      is(key, 'slicc-sprinkle-state:review');
      return JSON.stringify(saved);
    },
  };
  is(read({ localStorage: storage }, { name: 'review' })(), saved);
  is(
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
  is(read({ localStorage: { getItem: () => '{bad' } }, {})(), undefined);
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
  is(
    find({ anchor: { selector: '#fountain-4', elementText: 'Yes.', scene: 'INT. KITCHEN' } }),
    null
  );
});

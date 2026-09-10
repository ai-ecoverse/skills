const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const template = fs.readFileSync(path.join(__dirname, '../templates/review.shtml'), 'utf8');
const start = template.indexOf('function renderFindings(');
const end = template.indexOf('\n}\n', start) + 2;
assert.ok(start >= 0 && end > start, 'shipped findings renderer exists');

// Record DOM construction without supplying an HTML parser: source-provided
// text must be assigned as text, and the native disclosure body must be a
// sibling of its always-visible summary. Visibility itself is browser-tested.
function element(tagName) {
  let text = '';
  const node = {
    tagName,
    childNodes: [],
    attributes: {},
    appendChild(child) {
      node.childNodes.push(child);
    },
    setAttribute(name, value) {
      node.attributes[name] = value;
    },
    get textContent() {
      return text + node.childNodes.map((child) => child.textContent).join('');
    },
    set textContent(value) {
      text = String(value);
      node.childNodes = [];
    },
  };
  return node;
}

function render(block) {
  const state = { findings: { page: { checker: block } } };
  const renderFindings = new Function(
    'state',
    'document',
    template.slice(start, end) + '\nreturn renderFindings;'
  )(state, { createElement: element });
  const container = element('div');
  renderFindings('page', container);
  return { state, container, renderFindings };
}

test('a source explanation collapses even when it has no finding rows', () => {
  const { container } = render({ summary: 'Preview only · never published', findings: [] });
  const details = container.childNodes[0];
  const [summary, body] = details.childNodes;
  assert.equal(details.tagName, 'details');
  assert.equal(summary.tagName, 'summary');
  assert.equal(summary.textContent, 'checker · Info');
  assert.equal(body.textContent, 'Preview only · never published');
  assert.equal(details.attributes.open, undefined, 'starts collapsed');
  const chevron = summary.childNodes.find((node) => node.attributes['data-lucide']);
  assert.equal(chevron.attributes['aria-hidden'], 'true', 'decorative icon has no spoken label');
});

test('explanations and finding rows remain literal text outside the trigger', () => {
  const text = '<img src=x onerror=alert(1)>';
  const { container } = render({
    summary: text,
    severity: 'fail',
    findings: [{ title: 'Heading', body: text }, { body: 'Body only' }],
  });
  const [summary, explanation, list] = container.childNodes[0].childNodes;
  assert.equal(summary.textContent, 'checker · Needs attention');
  assert.equal(explanation.textContent, text);
  assert.equal(explanation.childNodes.length, 0);
  assert.equal(list.tagName, 'ul');
  assert.deepEqual(
    list.childNodes.map((node) => node.textContent),
    ['Heading: ' + text, 'Body only']
  );
});

test('clearing findings removes the disclosure instead of retaining its old body', () => {
  const { state, container, renderFindings } = render({ summary: 'Old result' });
  state.findings.page = {};
  renderFindings('page', container);
  assert.equal(container.hidden, true);
  assert.equal(container.childNodes.length, 0);
});

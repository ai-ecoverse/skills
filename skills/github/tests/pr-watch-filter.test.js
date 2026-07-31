const assert = require('node:assert/strict');
const test = require('node:test');
const { buildPrWatchFilter, composePrWatchFilter } = require('../scripts/pr-watch-filter.js');

function compile(source) {
  return Function(`return (${source});`)();
}

test('matches every PR-linked GitHub webhook payload shape', () => {
  const filter = compile(buildPrWatchFilter(267, 'trieloff/topic'));
  const bodies = [
    { number: 267, pull_request: { number: 267 } },
    { pull_request: { number: 267 } },
    { issue: { number: 267, pull_request: {} } },
    { check_run: { pull_requests: [{ number: 267 }] } },
    { check_run: { pull_requests: [], check_suite: { pull_requests: [{ number: 267 }] } } },
    { check_suite: { pull_requests: [{ number: 267 }] } },
    { branches: [{ name: 'trieloff/topic' }] },
  ];

  for (const body of bodies) assert.equal(filter({ body }), true);
});

test('uses the head branch when check payloads omit pull_requests', () => {
  const filter = compile(buildPrWatchFilter(267, 'fork/topic'));

  assert.equal(
    filter({
      body: {
        check_run: {
          pull_requests: [],
          check_suite: {
            pull_requests: [],
            head_branch: 'fork/topic',
          },
        },
      },
    }),
    true
  );
  assert.equal(
    filter({
      body: {
        check_suite: {
          pull_requests: [],
          head_branch: 'fork/topic',
        },
      },
    }),
    true
  );
});

test('drops unrelated repository events', () => {
  const filter = compile(buildPrWatchFilter(267, 'trieloff/topic'));
  const bodies = [
    { pull_request: { number: 266 } },
    { issue: { number: 261 } },
    { check_run: { pull_requests: [{ number: 265 }] } },
    { check_suite: { pull_requests: [], head_branch: 'someone/else' } },
    { branches: [{ name: 'main' }] },
    {},
  ];

  for (const body of bodies) assert.equal(filter({ body }), false);
});

test('composes a user predicate with the mandatory PR scope', () => {
  const scoped = buildPrWatchFilter(267, 'trieloff/topic');
  const filter = compile(composePrWatchFilter(scoped, "e => e.body.action !== 'synchronize'"));

  assert.equal(filter({ body: { action: 'opened', pull_request: { number: 267 } } }), true);
  assert.equal(filter({ body: { action: 'synchronize', pull_request: { number: 267 } } }), false);
  assert.equal(filter({ body: { action: 'opened', pull_request: { number: 266 } } }), false);
});

test('safely embeds unusual branch names', () => {
  const headRef = 'feature/quote-"-$()';
  const filter = compile(buildPrWatchFilter(267, headRef));
  assert.equal(filter({ body: { branches: [{ name: headRef }] } }), true);
});

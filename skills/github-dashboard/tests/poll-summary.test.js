import test, { is, ok, throws } from 'tst';

/* Tests for summariseFailure() in ../scripts/poll.jsh.

   The function is evaluated OUT OF THE SHIPPED FILE, between its 8</>8 markers,
   so this suite cannot pass against a stale copy: if the file changes, this
   tests the change. poll.jsh itself must never be imported — loading it starts
   the 30-minute scheduler and spawns a fetch. */
const fs = require('fs');
const SRC = fs.readFileSync(new URL('../scripts/poll.jsh', import.meta.url).pathname, 'utf8');
const START = '/* ---- 8< summariseFailure';
const END = '/* ---- >8 end summariseFailure';
const i = SRC.indexOf(START);
const j = SRC.indexOf(END);
if (i < 0 || j < 0) throw new Error('summariseFailure markers not found in poll.jsh');
const BLOCK = SRC.slice(i, j);
const summariseFailure = new Function(BLOCK + '\nreturn summariseFailure;')();

/* The line this change REPLACED, copied verbatim from poll.jsh before the edit:
     const why = String((r && r.stderr) || (r && r.stdout) || '').trim()
       .split('\n').slice(-2).join(' | ').slice(0, 200);
   Kept here so every "this would have been red" claim is executable rather than
   asserted in prose. */
const oldWhy = (t) => String(t || '').trim().split('\n').slice(-2).join(' | ').slice(0, 200);

/* ── Fixtures ─────────────────────────────────────────────────────────────
   The FRAMES are verbatim from the 2026-09-23 05:07Z incident line. The message
   line is a faithful stand-in for that failure class (a realm asset-load
   failure, seen earlier in this project) because the real message was destroyed
   by the very bug under test — there is no log that still holds it. */
const REAL_MSG =
  'TypeError: Failed to fetch dynamically imported module: https://www.sliccy.ai/assets/realm-body-handles-DtLxL_rB.js';
const REAL = [
  REAL_MSG,
  '    at async tl (https://www.sliccy.ai/assets/js-realm-worker-QT2JnICz.js:50:9562)',
  '    at async el (https://www.sliccy.ai/assets/js-realm-worker-QT2JnICz.js:50:9069)',
].join('\n');

const FRAMES_ONLY = [
  '    at async tl (https://www.sliccy.ai/assets/js-realm-worker-QT2JnICz.js:50:9562)',
  '    at lc (https://www.sliccy.ai/assets/js-realm-worker-QT2JnICz.js:49:30)',
  '    at nl (https://www.sliccy.ai/assets/js-realm-worker-QT2JnICz.js:50:10121)',
  '    at async el (https://www.sliccy.ai/assets/js-realm-worker-QT2JnICz.js:50:9069)',
].join('\n');

const LONG_MULTI = ['Error: config ./config.json lists no repos']
  .concat(new Array(400).fill('    at frame (https://www.sliccy.ai/assets/js-realm-worker-QT2JnICz.js:50:9562)'))
  .join('\n');

const LONG_ONE_LINE = 'Error: ' + 'x'.repeat(5000);

const CAP = 300;
const firstFrameAt = (s) => s.search(/at\s/);

// 1. THE INCIDENT. The message must survive, and must come before any frame.
test('real incident stderr: message survives and precedes the frames', () => {
  const out = summariseFailure(REAL);
  ok(out.includes('Failed to fetch dynamically imported module'), 'message present: ' + out.slice(0, 80));
  const m = out.indexOf('TypeError');
  const f = firstFrameAt(out);
  ok(m === 0, 'message starts the summary (index ' + m + ')');
  ok(f > m, 'first frame (index ' + f + ') comes after the message (index ' + m + ')');
  // Executable proof this is red against the old behaviour:
  ok(!oldWhy(REAL).includes('Failed to fetch'), 'OLD dropped the message entirely: ' + oldWhy(REAL).slice(0, 60));
});

// 2. FRAMES ONLY. Nothing else exists, so frames must be kept — and the TOP of
//    the stack is the useful end, which the old tail-slice threw away.
test('frames-only stderr: stays non-empty and leads with the top frame', () => {
  const out = summariseFailure(FRAMES_ONLY);
  ok(out.length > 0, 'not blank');
  ok(out.startsWith('at async tl'), 'top frame first: ' + out.slice(0, 40));
  ok(!oldWhy(FRAMES_ONLY).startsWith('at async tl'), 'OLD led with a later frame: ' + oldWhy(FRAMES_ONLY).slice(0, 40));
});

// 3. EMPTY. Must not throw, and must say something rather than nothing.
test('empty stderr: no throw, and a harmless non-empty note', () => {
  let out;
  ok((() => { out = summariseFailure(''); return true; })(), 'did not throw on empty string');
  ok(out.length > 0, 'non-empty: ' + JSON.stringify(out));
  is(oldWhy(''), '', 'OLD produced a blank suffix for empty stderr');
  ok((() => { summariseFailure(undefined); summariseFailure(null); return true; })(), 'no throw on undefined/null');
});

// 4. LONG MULTI-LINE. The message is one line among 400 frames.
test('long multi-line stderr: the message still survives', () => {
  const out = summariseFailure(LONG_MULTI);
  ok(out.includes('lists no repos'), 'message present: ' + out.slice(0, 70));
  ok(!oldWhy(LONG_MULTI).includes('lists no repos'), 'OLD kept only trailing frames');
});

// 5. CAP. Regression guard for the new bound (NOT a test of the fix: the old
//    code capped at 200, so it satisfied a <= 300 assertion too).
test('output is bounded by the cap on huge input', () => {
  ok(summariseFailure(LONG_MULTI).length <= CAP, 'multi-line <= ' + CAP + ' (got ' + summariseFailure(LONG_MULTI).length + ')');
  ok(summariseFailure(LONG_ONE_LINE).length <= CAP, 'single long line <= ' + CAP + ' (got ' + summariseFailure(LONG_ONE_LINE).length + ')');
  ok(summariseFailure(FRAMES_ONLY).length <= CAP, 'frames-only <= ' + CAP);
});

// 6. SINGLE LINE, NO NEWLINE. Input-handling guard (NOT a test of the fix: the
//    old code also surfaced a single-line message, just with a 200 cap).
test('single long line with no newline: message kept, bounded', () => {
  const out = summariseFailure(LONG_ONE_LINE);
  ok(out.startsWith('Error: xxx'), 'message kept: ' + out.slice(0, 20));
  ok(out.length <= CAP, 'bounded');
});

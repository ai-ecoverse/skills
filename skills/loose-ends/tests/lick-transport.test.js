// Every lick the loose-ends panel emits must survive the SLICC transport.
//
// The runtime forwards a sprinkle lick as { action, data, target } and drops
// every other top-level key, so a field placed beside `action` never reaches
// the owner (issue #427: load-ack arrived as exactly {"action":"load-ack"}).
//
// Run with:
//
//   cd skills/loose-ends && tst tests/lick-transport.test.js

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import test, { is, ok } from 'tst';

const TEMPLATE = fileURLToPath(new URL('../templates/loose-ends.shtml', import.meta.url));
const html = readFileSync(TEMPLATE, 'utf8');

const TRANSPORT_KEYS = ['action', 'data', 'target'];
const EXPECTED_ACTIONS = [
  'do',
  'done',
  'load-ack',
  'open-session',
  'request-load',
  'snooze',
  'unsnooze',
];

// The panel logic lives in the first inline <script>; the second one only
// renders icons.
function panelScript() {
  const open = html.indexOf('<script>');
  const close = html.indexOf('</script>', open);
  ok(open >= 0 && close > open, 'panel <script> not found');
  return html.slice(open + '<script>'.length, close);
}
const script = panelScript();

// The shipped transport, restated: only these three keys cross the bridge.
function forward(msg) {
  const out = { action: msg.action, data: msg.data };
  if (msg.target !== undefined) out.target = msg.target;
  return out;
}

function extractFunction(name) {
  const lines = script.split('\n');
  const start = lines.findIndex((l) => l.startsWith(`function ${name}(`));
  ok(start >= 0, `${name} not found in template`);
  let end = -1;
  for (let i = start + 1; i < lines.length; i++) {
    if (lines[i] === '}') {
      end = i;
      break;
    }
  }
  ok(end > start, `end of ${name} not found`);
  return lines.slice(start, end + 1).join('\n');
}

// Return the balanced `{ ... }` literal starting at `from`, skipping strings.
function balancedObject(src, from) {
  let depth = 0;
  let quote = null;
  for (let i = from; i < src.length; i++) {
    const c = src[i];
    if (quote) {
      if (c === '\\') i++;
      else if (c === quote) quote = null;
      continue;
    }
    if (c === "'" || c === '"' || c === '`') quote = c;
    else if (c === '{' || c === '[' || c === '(') depth++;
    else if (c === '}' || c === ']' || c === ')') {
      depth--;
      if (depth === 0) return src.slice(from, i + 1);
    }
  }
  throw new Error(`unbalanced object literal at ${from}`);
}

// Top-level property names of an object literal source, without evaluating it
// (its values reference panel-local variables). A spread is reported as `...`.
function topLevelKeys(literal) {
  const keys = [];
  let depth = 0;
  let quote = null;
  let expectKey = false;
  for (let i = 0; i < literal.length; i++) {
    const c = literal[i];
    if (quote) {
      if (c === '\\') i++;
      else if (c === quote) quote = null;
      continue;
    }
    if (depth === 1 && expectKey && /\S/.test(c)) {
      expectKey = false;
      const m = /^(\.\.\.|[A-Za-z_$][\w$]*|'[^']*'|"[^"]*")/.exec(literal.slice(i));
      if (m) {
        keys.push(m[1] === '...' ? '...' : m[1].replace(/^['"]|['"]$/g, ''));
        i += m[1].length - 1;
        continue;
      }
    }
    if (c === "'" || c === '"' || c === '`') quote = c;
    else if (c === '{' || c === '[' || c === '(') {
      depth++;
      if (depth === 1) expectKey = true;
    } else if (c === '}' || c === ']' || c === ')') depth--;
    else if (c === ',' && depth === 1) expectKey = true;
  }
  return keys;
}

// Every `slicc.lick(` call site in the panel, classified. An inline object
// literal is checked by its keys; a lick built into an onclick string must be
// built by lickPayload(), which is exercised directly below.
function lickCalls() {
  const calls = [];
  const re = /slicc\.lick\(/g;
  let m = re.exec(script);
  while (m) {
    const at = m.index + m[0].length;
    if (script[at] === '{') {
      const literal = balancedObject(script, at);
      const action = /^\{\s*action:\s*'([^']+)'/.exec(literal);
      calls.push({
        kind: 'literal',
        action: action ? action[1] : null,
        keys: topLevelKeys(literal),
        literal,
      });
    } else if (script[at] === "'") {
      const ref = /^' \+ (\w+) \+ '\)/.exec(script.slice(at));
      ok(ref, `unrecognised string-built lick at ${at}`);
      const def = new RegExp(
        `const ${ref[1]} = esc\\(JSON\\.stringify\\(lickPayload\\('([^']+)'`
      ).exec(script);
      calls.push({ kind: 'lickPayload', action: def ? def[1] : null, variable: ref[1] });
    } else {
      calls.push({ kind: 'unknown', action: null, at });
    }
    m = re.exec(script);
  }
  return calls;
}

test('every slicc.lick call site in the panel is accounted for', () => {
  const calls = lickCalls();
  for (const call of calls) {
    ok(call.kind !== 'unknown', `unclassified slicc.lick call: ${JSON.stringify(call)}`);
    ok(call.action, `lick call without a resolvable action: ${JSON.stringify(call)}`);
  }
  is(calls.map((c) => c.action).sort(), EXPECTED_ACTIONS);
});

test('inline lick literals carry only action, data and target at the top level', () => {
  const literals = lickCalls().filter((c) => c.kind === 'literal');
  ok(literals.length > 0, 'no inline lick literals found');
  // Collect every offender first so one run names all of them.
  const outside = {};
  const withoutData = [];
  for (const call of literals) {
    const extra = call.keys.filter((k) => !TRANSPORT_KEYS.includes(k));
    if (extra.length) outside[call.action] = extra;
    if (!call.keys.includes('data')) withoutData.push(call.action);
  }
  is(outside, {}, 'lick literals with keys outside {action,data,target}');
  is(withoutData, [], 'lick literals without a data object');
});

test('lickPayload builds only transport keys', () => {
  const lickPayload = new Function(`${extractFunction('lickPayload')}\nreturn lickPayload;`)();
  for (const cone of ['cone-a', undefined]) {
    const payload = lickPayload('do', { id: 'le-1' }, cone);
    is(
      Object.keys(payload).filter((k) => !TRANSPORT_KEYS.includes(k)),
      [],
      'lickPayload added a non-transport key'
    );
    is(forward(payload), payload, 'lickPayload output does not survive transport');
  }
});

// Run the shipped hydration-handshake functions against a recording slicc.
function handshake() {
  const src = [
    'const INSTANCE_ID = "inst-1";',
    'const MOUNTED_AT = "2026-01-01T00:00:00.000Z";',
    'const REQUEST_LOAD_MIN_GAP_MS = 5000;',
    'const REQUEST_LOAD_BACKOFF_FACTOR = 2;',
    'const REQUEST_LOAD_MAX_GAP_MS = 60000;',
    'let requestLoadGapMs = REQUEST_LOAD_MIN_GAP_MS;',
    'let requestLoadLastAt = 0;',
    extractFunction('requestLoad'),
    extractFunction('emitLoadAck'),
    'return { requestLoad, emitLoadAck };',
  ].join('\n');
  const sent = [];
  const slicc = { lick: (msg) => sent.push(msg) };
  return { sent, ...new Function('slicc', src)(slicc) };
}

test('load-ack carries instanceId, count and at inside data', () => {
  const h = handshake();
  h.emitLoadAck(7);
  is(h.sent.length, 1, 'emitLoadAck did not lick');
  const msg = h.sent[0];
  is(Object.keys(msg).sort(), ['action', 'data']);
  is(msg.action, 'load-ack');
  const delivered = forward(msg);
  is(delivered.data.instanceId, 'inst-1');
  is(delivered.data.count, 7);
  ok(
    typeof delivered.data.at === 'string' && !Number.isNaN(Date.parse(delivered.data.at)),
    'at is not an ISO time'
  );
});

test('request-load carries its diagnostics inside data', () => {
  const h = handshake();
  h.requestLoad('store-unreachable', 'exec-timeout');
  is(h.sent.length, 1, 'requestLoad did not lick');
  const msg = h.sent[0];
  is(Object.keys(msg).sort(), ['action', 'data']);
  is(forward(msg), {
    action: 'request-load',
    data: {
      instanceId: 'inst-1',
      reason: 'store-unreachable',
      detail: 'exec-timeout',
      mountedAt: '2026-01-01T00:00:00.000Z',
    },
  });
});

test('request-load sends a null detail inside data when none is known', () => {
  const h = handshake();
  h.requestLoad('no-bridge');
  is(forward(h.sent[0]).data.detail, null);
  is(forward(h.sent[0]).data.reason, 'no-bridge');
});

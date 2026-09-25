/* Shared plumbing for the thread-state tests (thread-stage, thread-overlay,
   thread-poll, thread-stage-drift). Not a test file itself.

   Targets, env first, then a flat staging layout (files beside tests/), then the skill-repo layout (scripts/, assets/sprinkle/):
     GHD_PANEL         github-dashboard.shtml
     GHD_THREAD_STAGE  thread-stage-shared.cjs
     GHD_THREAD_POLL   thread-poll.jsh
     GHD_FETCHER       fetch-snapshot.mjs (READ only; falls back to the live one) */
const fs = require('fs');

function locate(envName, rels, what, extra) {
  const env = (typeof process !== 'undefined' && process.env) || {};
  if (env[envName]) {
    if (!fs.existsSync(env[envName])) throw new Error(`${envName}=${env[envName]} does not exist`);
    return env[envName];
  }
  const cands = rels.map((p) => __dirname + '/' + p).concat(extra || []);
  const found = cands.find((p) => fs.existsSync(p));
  if (!found) throw new Error(`${what} not found (tried ${cands.join(', ')}); set ${envName}`);
  return found;
}

const paths = {
  panel: () => locate('GHD_PANEL', ['../github-dashboard.shtml', '../assets/sprinkle/github-dashboard.shtml'], 'github-dashboard.shtml'),
  shared: () => locate('GHD_THREAD_STAGE', ['../thread-stage-shared.cjs', '../scripts/thread-stage-shared.cjs'], 'thread-stage-shared.cjs'),
  poll: () => locate('GHD_THREAD_POLL', ['../thread-poll.jsh', '../scripts/thread-poll.jsh'], 'thread-poll.jsh'),
  fetcher: () => locate('GHD_FETCHER', ['../fetch-snapshot.mjs', '../scripts/fetch-snapshot.mjs'], 'fetch-snapshot.mjs', ['/shared/sprinkles/github-dashboard/fetch-snapshot.mjs']),
};

/** The text between two markers (from the start of the marker's comment to
    the end of the END marker's line). Throws when either is missing. */
function fenced(text, startTag, endTag, where) {
  const a = text.indexOf(startTag);
  const b = text.indexOf(endTag, a < 0 ? 0 : a);
  if (a < 0 || b < 0) throw new Error(`${where}: no "${startTag}" ... "${endTag}" block`);
  const from = text.lastIndexOf('/*', a);
  const eol = text.indexOf('\n', b);
  return text.slice(from, eol < 0 ? text.length : eol);
}

/** The panel's GHD-CLASSIFY region, evaluated. Every name a test may want is
    returned when it exists, undefined otherwise, so a test against an OLD
    panel fails on its assertion rather than on a ReferenceError. */
function panelApi(panelPath) {
  const s = fs.readFileSync(panelPath || paths.panel(), 'utf8');
  const a = s.indexOf('GHD-CLASSIFY:START');
  const b = s.indexOf('GHD-CLASSIFY:END');
  if (a < 0 || b < 0 || b < a) throw new Error('panel has no GHD-CLASSIFY region');
  const code = s.slice(s.lastIndexOf('/*', a), s.lastIndexOf('\n', b));
  const names = ['categorize', 'workingDaysSince', 'ISSUE_STALL_AFTER_WORKING_DAYS', 'STALL_AFTER_HOURS', 'stageFromThread', 'threadPhase', 'threadSettledIssue', 'threadSettledSince', 'overlayThreadState', 'threadDrivenBaseStage', 'threadStateOf', 'THREAD_STATE_FIELDS'];
  const ret = '{ ' + names.map((n) => `${n}: typeof ${n} === 'undefined' ? undefined : ${n}`).join(', ') + ' }';
  return new Function('let META = null; function fmtHours(h) { return String(h); }\n' + code + '\nreturn ' + ret + ';')();
}

/** The panel's module script. */
function panelModule(panelPath) {
  const m = fs.readFileSync(panelPath || paths.panel(), 'utf8').match(/<script type="module">([\s\S]*?)<\/script>/);
  if (!m) throw new Error('module script not found');
  return m[1];
}

/** The body of `function name(` in `code`, brace-matched; null when absent. */
function fnBody(code, name) {
  const a = code.search(new RegExp(`(?:async )?function ${name}\\(`));
  if (a < 0) return null;
  const i = code.indexOf('{', code.indexOf(')', a));
  let depth = 0;
  for (let j = i; j < code.length; j++) {
    if (code[j] === '{') depth++;
    else if (code[j] === '}' && --depth === 0) return code.slice(i, j + 1);
  }
  throw new Error(`unbalanced ${name}`);
}

const stripComments = (code) => code.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');

/** thread-stage-shared.cjs, evaluated from its text with no require(). */
function sharedModule(p) {
  const src = fs.readFileSync(p || paths.shared(), 'utf8');
  const mod = { exports: {} };
  new Function('module', 'exports', 'require', src)(mod, mod.exports, (x) => {
    throw new Error(`thread-stage-shared.cjs requires ${x}; it must stay dependency-free`);
  });
  return mod.exports;
}

const H = 36e5;
const iso = (ms) => new Date(ms).toISOString();

/** A RECORD-shape thread (what snapshot.json carries as record.thread). */
function recThread(over) {
  return {
    id: 'thr_example01',
    provider: 'acp-example',
    state: 'idle',
    title: 'Fix the example widget (#101)',
    branch: 'bb/fix-the-example-widget-101-thr_example01',
    archived: false,
    live: true,
    busy: false,
    hasPendingInteraction: false,
    queuedWork: 'none',
    updatedAt: '2026-09-23T10:00:00.000Z',
    matchedBy: 'both',
    ...over,
  };
}

/** A snapshot record for octocat/hello-world. */
function record(over) {
  return {
    id: '101',
    repo: 'octocat/hello-world',
    kind: 'issue',
    title: 'Example widget breaks',
    url: 'https://github.com/octocat/hello-world/issues/101',
    stage: 2,
    labels: [],
    openedAt: '2026-09-20T09:00:00.000Z',
    lastActivityAt: '2026-09-22T09:00:00.000Z',
    stateReason: 'open',
    status: 'An agent is working on the widget.',
    statusSource: 'agent',
    ...over,
  };
}

module.exports = { fs, locate, paths, fenced, panelApi, panelModule, fnBody, stripComments, sharedModule, H, iso, recThread, record };

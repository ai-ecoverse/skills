// Loads the real gh.jsh the way the other suites in this directory do (compile
// the source into an AsyncFunction with a mock `require`), but hands it the
// REAL `fs`, so commands that own a local file (`gh monitor`, `gh dashboard`)
// read and write a scratch file under /tmp. Everything that would leave the
// machine is mocked: GitHub (`api`), the shell (`exec`, e.g. `bb project list`)
// and the token lookup.
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as _assignFieldMod from '../scripts/assign-field.js';
import * as _prEditMod from '../scripts/pr-edit.js';
import * as _prWatchFilterMod from '../scripts/pr-watch-filter.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const target = path.resolve(__dirname, '../scripts/gh.jsh');
const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor;

class NodeExitError extends Error {
  constructor(message, exitCode = 1) {
    super(message);
    this.name = 'NodeExitError';
    this.exitCode = exitCode;
  }
}

/**
 * Run `gh <args>` in-process.
 * scenario.env       process.env for the run
 * scenario.repos     { 'owner/repo': { full_name, private } } for GET /repos/{slug}
 * scenario.bb        array returned by `bb project list --json` (omit: bb fails)
 * scenario.source    override the gh.jsh source (used by the red proofs)
 * Returns { code, error, stdout, stderr, calls, execs, tokenCalls }; code is the
 * exit code (0 when the command returned normally).
 */
export async function runGh(args, scenario = {}) {
  const source = scenario.source ?? fs.readFileSync(target, 'utf8');
  const calls = [];
  const execs = [];
  const tokenCalls = [];
  const stdout = [];
  const stderr = [];
  const notFound = () =>
    Object.assign(new Error('Not Found'), { status: 404, body: { message: 'Not Found' } });
  const api = {
    get: async (requestPath, options) => {
      calls.push({ method: 'get', path: requestPath, options });
      const m = requestPath.match(/^\/repos\/([^/]+\/[^/]+)$/);
      if (m) {
        const hit = (scenario.repos || {})[m[1]];
        if (!hit) throw notFound();
        return hit;
      }
      if (requestPath === '/user') return { login: 'octocat' };
      throw notFound();
    },
    patch: async () => {
      throw new Error('unexpected PATCH');
    },
    post: async () => {
      throw new Error('unexpected POST');
    },
    delete: async () => {
      throw new Error('unexpected DELETE');
    },
    put: async () => {
      throw new Error('unexpected PUT');
    },
  };
  const cli = {
    die: (message, options) => {
      throw new NodeExitError(String(message), options?.exitCode ?? 1);
    },
    help: (message) => {
      stdout.push(String(message));
      throw new NodeExitError('help', 0);
    },
    out: (value) => stdout.push(JSON.stringify(value)),
    warn: (message) => stderr.push(String(message)),
  };
  const color = new Proxy({}, { get: () => (value) => String(value) });
  const fmt = new Proxy(
    { date: (value) => String(value), table: (rows) => rows.map((r) => r.join('  ')).join('\n') },
    { get: (object, key) => object[key] || ((value) => String(value)) }
  );
  const exec = async (command) => {
    execs.push(command);
    if (/^bb project list --json/.test(command) && Array.isArray(scenario.bb)) {
      return { stdout: JSON.stringify(scenario.bb), stderr: '', exitCode: 0 };
    }
    return { stdout: '', stderr: 'not available in tests', exitCode: 1 };
  };
  exec.spawn = exec;
  exec.start = exec;
  const mocks = {
    'sliccy:skill': {
      token: async (provider) => {
        tokenCalls.push(provider);
        return 'fake';
      },
    },
    'sliccy:cli': cli,
    'sliccy:fmt': fmt,
    'sliccy:color': color,
    'sliccy:http': { client: () => api },
    'sliccy:exec': exec,
    'sliccy:time': {},
    fs,
  };
  const relativeModules = {
    './pr-watch-filter.js': () => _prWatchFilterMod.default || _prWatchFilterMod,
    './assign-field.js': () => _assignFieldMod.default || _assignFieldMod,
    './pr-edit.js': () => _prEditMod.default || _prEditMod,
  };
  const realRequire = createRequire(target);
  const mockRequire = (id) => {
    if (Object.hasOwn(mocks, id)) return mocks[id];
    if (Object.hasOwn(relativeModules, id)) return relativeModules[id]();
    return realRequire(id);
  };
  const mockProcess = {
    argv: ['node', target, ...args],
    env: scenario.env || {},
    stdin: { read: async () => '' },
    exit: (code) => {
      throw new NodeExitError('exit', code);
    },
  };
  const mockConsole = {
    log: (message) => stdout.push(String(message)),
    info: (message) => stdout.push(String(message)),
    warn: (message) => stderr.push(String(message)),
    error: (message) => stderr.push(String(message)),
  };
  const result = { calls, execs, tokenCalls, stdout, stderr, code: 0, error: null };
  try {
    await new AsyncFunction('require', 'process', 'console', 'fetch', source)(
      mockRequire,
      mockProcess,
      mockConsole,
      async () => {
        throw new Error('unexpected fetch');
      }
    );
  } catch (error) {
    result.error = error;
    result.code = error?.name === 'NodeExitError' ? error.exitCode : 99;
  }
  result.out = stdout.join('\n');
  result.err = [result.error?.message || '', ...stderr].join('\n');
  return result;
}

/** A fresh scratch directory under /tmp for one test. */
export function scratchDir(label) {
  const dir = `/tmp/gh-tst-${label}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export const GH_SOURCE_PATH = target;

import fs from 'node:fs';
import path from 'node:path';
import test, { is, ok } from 'tst';
import { nodeFs } from './node-fs.js';

// The checkers read their reference rates and the file under test through fs.
// Run against Node's fs semantics (slicc-jsh, SLICC 7), the SLICC 6 promise
// dialect fails; Node's fs.promises works on both (ai-ecoverse/skills#487).
const ROOT = process.cwd();
const RATES = fs.readFileSync(path.join(ROOT, 'references/ai_word_rates.txt'), 'utf8');
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
const SKILL_DIR = '/workspace/skills/ai-writing-detector/scripts';

class NodeExitError extends Error {
  constructor(code) {
    super(`exit ${code}`);
    this.name = 'NodeExitError';
    this.code = code;
  }
}

async function run(script, args, files) {
  const vfs = nodeFs({ [`${SKILL_DIR}/../references/ai_word_rates.txt`]: RATES, ...files });
  const out = [];
  const err = [];
  const modules = { fs: vfs, 'sliccy:skill': { dir: SKILL_DIR } };
  const proc = {
    argv: ['node', `${SKILL_DIR}/${script}`, ...args],
    env: {},
    exit: (code) => {
      throw new NodeExitError(code);
    },
    stdout: { write: (s) => out.push(String(s)), isTTY: false },
    stderr: { write: (s) => err.push(String(s)), isTTY: false },
    stdin: { isTTY: true, read: () => null },
  };
  let code = 0;
  try {
    await new AsyncFunction(
      'require',
      'process',
      'console',
      fs.readFileSync(path.join(ROOT, 'scripts', script), 'utf8')
    )(
      (id) => {
        if (id in modules) return modules[id];
        throw new Error(`unexpected require(${id})`);
      },
      proc,
      {
        log: (...a) => out.push(a.join(' ')),
        error: (...a) => err.push(a.join(' ')),
        warn: (...a) => err.push(a.join(' ')),
      }
    );
  } catch (e) {
    if (e?.name !== 'NodeExitError') throw e;
    code = e.code;
  }
  return { code, stdout: out.join(''), stderr: err.join('') };
}

const DRAFT =
  'We delve into a rich tapestry of insights.\nIt is a testament to the robust landscape.\n';

test('check-ai-words reads the rates and the draft through fs.promises', async () => {
  const r = await run('check-ai-words.jsh', ['/shared/draft.md'], { '/shared/draft.md': DRAFT });
  is(r.code, 0, r.stderr);
  ok(/delve/i.test(r.stdout), r.stdout.slice(0, 400));
});

test('check-ai-patterns reads the rates and the draft through fs.promises', async () => {
  const r = await run('check-ai-patterns.jsh', ['/shared/draft.md'], { '/shared/draft.md': DRAFT });
  is(r.code, 0, r.stderr);
  ok(r.stdout.includes('# AI Pattern Analysis Report'));
  ok(r.stdout.includes('/shared/draft.md'));
});

test('check-llm-cliches reads the draft through fs.promises', async () => {
  const r = await run('check-llm-cliches.jsh', ['/shared/draft.md'], { '/shared/draft.md': DRAFT });
  ok(r.code === 0 || r.code === 1, `exit ${r.code}: ${r.stderr}`);
  ok(!/is not a function|"cb" argument/.test(r.stderr), r.stderr);
  ok(r.stdout.length > 0, 'it reported something');
});

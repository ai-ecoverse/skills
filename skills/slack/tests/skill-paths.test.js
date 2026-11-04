import fs from 'node:fs';
import path from 'node:path';
import test, { is } from 'tst';
import { load } from './extract.js';

// slack finds its own files relative to where it is installed (__dirname),
// not at a literal /workspace/skills path, so the host jsh can run it from
// anywhere (ai-ecoverse/skills#491). This evaluates the shipped definitions
// with the script installed at /opt/skills/slack/scripts.
const SOURCE = fs.readFileSync(path.join(process.cwd(), 'scripts/slack.jsh'), 'utf8');
const INSTALLED = '/opt/skills/slack/scripts';

// The top-level `const` lines named, evaluated in file order with __dirname set.
function consts(names) {
  const lines = SOURCE.split('\n').filter((l) =>
    names.some((n) => new RegExp(`^const ${n} = `).test(l))
  );
  return new Function('__dirname', `${lines.join('\n')}\nreturn { ${names.join(', ')} };`)(
    INSTALLED
  );
}

const { stateDir } = load(SOURCE, ['stateDir'], {
  require: () => ({ homedir: () => '/home/fallback' }),
});

test('the skill’s own files live under its install directory', () => {
  is(consts(['SKILL_ROOT']), { SKILL_ROOT: '/opt/skills/slack' });
});

test('SLICC 6 keeps state in the skill folder, whatever the environment says', () => {
  is(
    stateDir({ SLACK_STATE_DIR: '/x', HOME: '/home/u' }, false, '/opt/skills/slack'),
    '/opt/skills/slack'
  );
});

test('jsh keeps state in a per-user directory, not in the skill folder', () => {
  const root = '/opt/skills/slack';
  is(stateDir({ SLACK_STATE_DIR: '/s', XDG_STATE_HOME: '/x', HOME: '/home/u' }, true, root), '/s');
  is(stateDir({ XDG_STATE_HOME: '/x', HOME: '/home/u' }, true, root), '/x/slack');
  is(stateDir({ HOME: '/home/u' }, true, root), '/home/u/.local/state/slack');
  is(stateDir({}, true, root), '/home/fallback/.local/state/slack');
});

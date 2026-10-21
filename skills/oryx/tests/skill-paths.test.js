import fs from 'node:fs';
import path from 'node:path';
import test, { is } from 'tst';

// oryx finds its own files relative to where it is installed (__dirname),
// not at a literal /workspace/skills path, so the host jsh can run it from
// anywhere (ai-ecoverse/skills#491). This evaluates the shipped definitions
// with the script installed at /opt/skills/oryx/scripts.
const SOURCE = fs.readFileSync(path.join(process.cwd(), 'scripts/oryx.jsh'), 'utf8');
const INSTALLED = '/opt/skills/oryx/scripts';

// The top-level `const` lines named, evaluated in file order with __dirname set.
function consts(names) {
  const lines = SOURCE.split('\n').filter((l) =>
    names.some((n) => new RegExp(`^const ${n} = `).test(l))
  );
  return new Function('__dirname', `${lines.join('\n')}\nreturn { ${names.join(', ')} };`)(
    INSTALLED
  );
}

test('the skill’s own files live under its install directory', () => {
  is(consts(['SKILL_ROOT', 'CONFIG_FILE']), {
    SKILL_ROOT: '/opt/skills/oryx',
    CONFIG_FILE: '/opt/skills/oryx/.config',
  });
});

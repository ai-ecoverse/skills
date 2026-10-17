import fs from 'node:fs';
import path from 'node:path';
import test, { is } from 'tst';

// tiktok finds its own files relative to where it is installed (__dirname),
// not at a literal /workspace/skills path, so the host jsh can run it from
// anywhere (ai-ecoverse/skills#491). This evaluates the shipped definitions
// with the script installed at /opt/skills/tiktok/scripts.
const SOURCE = fs.readFileSync(path.join(process.cwd(), 'scripts/tiktok.jsh'), 'utf8');
const INSTALLED = '/opt/skills/tiktok/scripts';

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
  is(consts(['SKILL_ROOT', 'TMP_DIR']), {
    SKILL_ROOT: '/opt/skills/tiktok',
    TMP_DIR: '/opt/skills/tiktok/.tmp',
  });
});

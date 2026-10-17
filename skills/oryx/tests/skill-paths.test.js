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

test('help prints the header comment of the installed script itself', async () => {
  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
  const out = [];
  const req = (id) => {
    if (id === 'sliccy:exec')
      return { exec: async () => ({ exitCode: 1, stdout: '', stderr: '' }) };
    if (id === 'sliccy:browser') return {};
    if (id === 'fs')
      return {
        promises: {
          readFile: async (p, enc) => {
            is([p, enc], [`${INSTALLED}/oryx.jsh`, 'utf8']);
            return '// oryx — demo header\n// second line\nconst x = 1;\n';
          },
        },
      };
    throw new Error(`unexpected require(${id})`);
  };
  try {
    await new AsyncFunction('require', 'process', 'console', '__dirname', '__filename', SOURCE)(
      req,
      {
        argv: ['node', `${INSTALLED}/oryx.jsh`, 'help'],
        env: {},
        exit: (c) => {
          throw Object.assign(new Error(`exit ${c}`), { name: 'NodeExitError' });
        },
      },
      { log: (m) => out.push(m), error: (m) => out.push(m) },
      INSTALLED,
      `${INSTALLED}/oryx.jsh`
    );
  } catch (e) {
    if (e.name !== 'NodeExitError') throw e;
  }
  is(out, ['oryx — demo header\nsecond line']);
});

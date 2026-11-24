import { readFileSync } from 'node:fs';
import test, { is, ok } from 'tst';

const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
const skill = readFileSync('SKILL.md', 'utf8');

test('concur is a private package whose bin is the script', () => {
  is(pkg.bin, { concur: 'scripts/concur.jsh' });
  is(pkg.private, true);
  ok(pkg.files.includes('scripts') && pkg.files.includes('references'));
});

test('sliccy-browser is a pinned dependency', () => {
  ok(/^\d+\.\d+\.\d+$/.test(pkg.dependencies['@ai-ecoverse/sliccy-browser']));
});

test('SKILL.md links the host guide and keeps the description short', () => {
  ok(skill.includes('references/jsh-host.md'));
  const description = /^description: (.*)$/m.exec(skill)[1];
  ok(description.length <= 1024);
});

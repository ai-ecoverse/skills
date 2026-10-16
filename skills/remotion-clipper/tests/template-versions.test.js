import fs from 'node:fs';
import path from 'node:path';
import test, { is, ok } from 'tst';

// Skill root: tst runs from the installed skill dir (CI + local harness).
const ROOT = process.cwd();

// tst cannot require() a .json (TS emit failure), so read and parse it.
function readJson(rel) {
  return JSON.parse(fs.readFileSync(path.join(ROOT, rel), 'utf8'));
}

const template = readJson('assets/remotion-template/package.json');
const allDeps = { ...template.dependencies, ...template.devDependencies };

// Remotion refuses to render when `remotion` and any `@remotion/*` package
// differ ("Version mismatch"), and React throws "Incompatible React versions"
// when react and react-dom differ. Renovate bumps them as separate PRs unless
// renovate.json groups them, so the template must stay coherent on its own.
test('every remotion package in the template pins the same exact version', () => {
  const remotion = Object.entries(allDeps).filter(
    ([name]) => name === 'remotion' || name.startsWith('@remotion/')
  );
  ok(remotion.length >= 2, 'template lists remotion and at least one @remotion/* package');
  for (const [name, version] of remotion) {
    ok(/^\d+\.\d+\.\d+$/.test(version), `${name} is pinned exactly (got ${version})`);
    is(version, allDeps.remotion, `${name} matches remotion`);
  }
});

test('react and react-dom share one exact version', () => {
  ok(/^\d+\.\d+\.\d+$/.test(allDeps.react), `react is pinned exactly (got ${allDeps.react})`);
  is(allDeps['react-dom'], allDeps.react, 'react-dom matches react');
});

test('the skill runtime deps stay on the template remotion major.minor', () => {
  const runtime = readJson('package.json').dependencies;
  const [major, minor] = allDeps.remotion.split('.');
  for (const [name, range] of Object.entries(runtime)) {
    if (!name.startsWith('@remotion/')) continue;
    const m = /^[\^~]?(\d+)\.(\d+)\./.exec(range);
    ok(m, `${name} has a semver range (got ${range})`);
    is(`${m[1]}.${m[2]}`, `${major}.${minor}`, `${name} is on remotion ${major}.${minor}`);
  }
});

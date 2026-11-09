import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { launch } from '@ai-ecoverse/slicc-shared-web/harness';

export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
export const BASE = [
  '@ai-ecoverse/wasm-bash',
  '@ai-ecoverse/wasm-coreutils',
  '@ai-ecoverse/slicc-jsh',
];
export const PNPM = '@ai-ecoverse/wasi-pnpm';
export const SUITE_MODULES = ['tst', 'minimatch'];

function lockPackages(repoRoot) {
  return JSON.parse(readFileSync(join(repoRoot, 'package-lock.json'), 'utf8')).packages ?? {};
}

function locate(packages, from, name) {
  for (let at = from; ; at = at.slice(0, Math.max(at.lastIndexOf('/node_modules/'), 0))) {
    const path = at ? `${at}/node_modules/${name}` : `node_modules/${name}`;
    if (packages[path]) return path;
    if (!at) return null;
  }
}

export function closure(names, { repoRoot = REPO_ROOT } = {}) {
  const packages = lockPackages(repoRoot);
  const seen = new Set();
  const queue = names.map((name) => {
    const path = locate(packages, '', name);
    if (!path) throw new Error(`${name} is not in package-lock.json: add it to devDependencies`);
    return path;
  });
  while (queue.length) {
    const path = queue.shift();
    if (seen.has(path)) continue;
    seen.add(path);
    const entry = packages[path];
    for (const dep of Object.keys(entry.dependencies ?? {})) {
      const found = locate(packages, path, dep);
      if (!found) throw new Error(`${path} needs ${dep}, which package-lock.json does not have`);
      queue.push(found);
    }
    for (const dep of Object.keys(entry.optionalDependencies ?? {})) {
      const found = locate(packages, path, dep);
      if (found) queue.push(found);
    }
  }
  return [...seen].sort();
}

function treeFiles(dir) {
  return readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => relative(dir, join(entry.parentPath, entry.name)).split('\\').join('/'))
    .sort();
}

export function skillFiles(name, { repoRoot = REPO_ROOT } = {}) {
  const prefix = `skills/${name}/`;
  return execFileSync('git', ['ls-files', '-z', '--', prefix], { cwd: repoRoot, encoding: 'utf8' })
    .split('\0')
    .filter(Boolean)
    .map((path) => path.slice(prefix.length));
}

export async function launchKernel({ pack } = {}) {
  return launch({
    roots: [
      ['/kernel/', 'node_modules/@ai-ecoverse/slicc-kernel/dist/'],
      ['/node_modules/', 'node_modules/'],
      ['/skills/', 'skills/'],
      ...(pack ? [['/pack/', pack]] : []),
      ['/', 'test/integration/page/'],
    ],
    isolated: true,
    intercept: ['https://registry.npmjs.org/'],
    timeout: 600_000,
    stallAfter: 180_000,
    coverage: [],
  });
}

export const packUrl = (chrome) =>
  `${chrome.url.replace('//127.0.0.1:', '//host.slicc.internal:')}pack/`;

export async function bootKernel(
  chrome,
  t,
  { modules = [], skills = [], append = [], repoRoot = REPO_ROOT } = {}
) {
  const page = await chrome.page(t);
  await page.goto('/');
  await page.until(() => typeof window.boot === 'function');
  for (const path of closure(modules, { repoRoot })) {
    const names = treeFiles(join(repoRoot, path));
    await page.evaluate(
      (from, to, n) => window.installTree(from, to, n),
      `/${path}/`,
      `${path}/`,
      names
    );
  }
  for (const name of skills) {
    const names = skillFiles(name, { repoRoot });
    await page.evaluate(
      (from, to, n) => window.installTree(from, to, n),
      `/skills/${name}/`,
      `home/skills/${name}/`,
      names
    );
  }
  await page.evaluate((options) => window.boot(options), { append });
  const run = (argv, options = {}) =>
    page.evaluate((a, o) => window.run(a, o), argv, { cwd: '/home', ...options });
  return {
    page,
    run,
    bash: (script, options) => run(['bash', '-c', script], options),
  };
}

#!/usr/bin/env node

import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { isMain } from './is-main.mjs';

const REPO_ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
export const JSH_BUILTINS = new Set([
  'cli',
  'color',
  'exec',
  'fmt',
  'http',
  'pool',
  'skill',
  'time',
]);
const JSH_HASHBANG = /^#!\s*(?:\/usr\/bin\/env\s+(?:-S\s+)?jsh|\/usr\/bin\/jsh)(?:\s|$)/;
const SLICCY_REQUIRE =
  /(?:require|import)\(\s*['"]sliccy:([a-z][a-z0-9-]*)['"]\s*\)|from\s+['"]sliccy:([a-z][a-z0-9-]*)['"]/g;
const SOURCE = /\.(?:jsh|js|mjs|cjs)$/;
const NOT_SHIPPED = /(?:^|\/)(?:tests?|evals?|node_modules)\//;
const COMMAND_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export function parseLsFiles(text) {
  const tracked = new Map();
  for (const line of String(text ?? '').split('\n')) {
    const match = /^(\d{6}) [0-9a-f]+ \d\t(.+)$/.exec(line);
    if (match) tracked.set(match[2], match[1]);
  }
  return tracked;
}

export function skillNames(tracked) {
  const names = new Set();
  for (const path of tracked.keys()) {
    const match = /^skills\/([^/]+)\/SKILL\.md$/.exec(path);
    if (match) names.add(match[1]);
  }
  return [...names].sort();
}

function firstLine(text) {
  return String(text ?? '').split('\n', 1)[0];
}

function extensionless(rel) {
  return !rel.split('/').pop().includes('.');
}

export function skillFiles(name, tracked) {
  const prefix = `skills/${name}/`;
  return [...tracked.keys()]
    .filter((path) => path.startsWith(prefix))
    .map((path) => path.slice(prefix.length));
}

export function commandFiles(name, { tracked, read }) {
  return skillFiles(name, tracked)
    .filter((rel) => !NOT_SHIPPED.test(rel))
    .filter(
      (rel) =>
        rel.endsWith('.jsh') ||
        (extensionless(rel) && JSH_HASHBANG.test(firstLine(read(`skills/${name}/${rel}`))))
    )
    .sort();
}

export function shippedChanges(changedFiles) {
  const names = new Set();
  for (const path of changedFiles) {
    const match = /^skills\/([^/]+)\/(.+)$/.exec(path);
    if (match && !NOT_SHIPPED.test(match[2])) names.add(match[1]);
  }
  return [...names].sort();
}

export function binEntries(manifest) {
  const { bin, name } = manifest ?? {};
  if (typeof bin === 'string') return [[String(name ?? '').replace(/^@[^/]+\//, ''), bin]];
  if (bin && typeof bin === 'object') return Object.entries(bin);
  return [];
}

const normal = (target) => String(target).replace(/^\.\//, '');

function shipped(target, files) {
  if (!Array.isArray(files)) return true;
  return files.some((entry) => {
    const prefix = normal(entry).replace(/\/+$/, '');
    if (/[*?[{]/.test(prefix)) return true;
    return target === prefix || target.startsWith(`${prefix}/`);
  });
}

export function sliccyModules(source) {
  const found = new Set();
  for (const match of String(source ?? '').matchAll(SLICCY_REQUIRE))
    found.add(match[1] ?? match[2]);
  return [...found].sort();
}

function checkBins(name, manifest, { tracked, read }) {
  const problems = [];
  for (const [command, rawTarget] of binEntries(manifest)) {
    const target = normal(rawTarget);
    const path = `skills/${name}/${target}`;
    const where = `skills/${name}/package.json bin.${command}`;
    if (!COMMAND_NAME.test(command))
      problems.push(`${where}: ${JSON.stringify(command)} is not a command name`);
    if (!tracked.has(path)) {
      problems.push(`${where}: ${target} is not a tracked file`);
      continue;
    }
    if (tracked.get(path) !== '100755') {
      problems.push(`${where}: ${target} is not executable (git update-index --chmod=+x ${path})`);
    }
    if (!JSH_HASHBANG.test(firstLine(read(path)))) {
      problems.push(`${where}: ${target} does not start with #!/usr/bin/env jsh`);
    }
    if (!shipped(target, manifest.files)) {
      problems.push(`${where}: ${target} is not in package.json files, so npm pack leaves it out`);
    }
  }
  return problems;
}

function checkSliccy(name, manifest, { tracked, read }) {
  const declared = new Set(
    Object.keys({ ...manifest.dependencies, ...manifest.optionalDependencies })
  );
  const problems = [];
  const missing = new Map();
  for (const rel of skillFiles(name, tracked)) {
    if (NOT_SHIPPED.test(rel)) continue;
    const path = `skills/${name}/${rel}`;
    const source = read(path);
    const isSource =
      SOURCE.test(rel) || (extensionless(rel) && JSH_HASHBANG.test(firstLine(source)));
    if (!isSource) continue;
    for (const module of sliccyModules(source)) {
      if (JSH_BUILTINS.has(module)) continue;
      if (declared.has(`@ai-ecoverse/sliccy-${module}`) || declared.has(`sliccy-${module}`))
        continue;
      if (!missing.has(module)) missing.set(module, rel);
    }
  }
  for (const [module, rel] of missing) {
    problems.push(
      `skills/${name}/package.json: ${rel} requires sliccy:${module}; add @ai-ecoverse/sliccy-${module} to dependencies`
    );
  }
  return problems;
}

export function checkSkill(name, { tracked, read, requirePackage = false }) {
  const manifestPath = `skills/${name}/package.json`;
  const commands = commandFiles(name, { tracked, read });
  if (!tracked.has(manifestPath)) {
    if (requirePackage && commands.length) {
      return [
        `skills/${name}: add a package.json whose bin lists its commands (${commands.join(', ')}), so SLICC 7 can install them (CLAUDE.md §16)`,
      ];
    }
    return [];
  }
  let manifest;
  try {
    manifest = JSON.parse(read(manifestPath));
  } catch (error) {
    return [`${manifestPath}: can't be read as JSON (${error.message})`];
  }
  const bins = binEntries(manifest);
  if (!bins.length && !requirePackage) return [];
  const problems = [];
  if (typeof manifest.name !== 'string' || !manifest.name)
    problems.push(`${manifestPath}: needs a name`);
  problems.push(...checkBins(name, manifest, { tracked, read }));
  const targets = new Set(bins.map(([, target]) => normal(target)));
  for (const rel of commands) {
    if (!targets.has(rel))
      problems.push(
        `${manifestPath}: ${rel} is not in bin, so SLICC 7 never installs it as a command`
      );
  }
  problems.push(...checkSliccy(name, manifest, { tracked, read }));
  return problems;
}

export function checkSkills({
  tracked,
  read,
  names = skillNames(tracked),
  requirePackage = false,
}) {
  return names.flatMap((name) => checkSkill(name, { tracked, read, requirePackage }));
}

export const readFrom = (root) => (path) => readFileSync(join(root, path), 'utf8');

async function main() {
  let input = '';
  process.stdin.setEncoding('utf8');
  for await (const chunk of process.stdin) input += chunk;
  const tracked = parseLsFiles(input);
  const read = readFrom(REPO_ROOT);
  const names = skillNames(tracked);
  const problems = checkSkills({ tracked, read, names });
  for (const problem of problems) console.error(`::error title=check-skill-packages::${problem}`);
  if (problems.length) throw new Error(`${problems.length} problem(s)`);
  const packaged = names.filter(
    (name) =>
      tracked.has(`skills/${name}/package.json`) &&
      binEntries(JSON.parse(read(`skills/${name}/package.json`))).length
  );
  console.error(`check-skill-packages: PASS ${packaged.length} packaged of ${names.length} skills`);
}

if (isMain(import.meta.url)) {
  main().catch((error) => {
    console.error(`check-skill-packages: ${error.message}`);
    process.exitCode = 1;
  });
}

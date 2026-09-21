#!/usr/bin/env node

import { readdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import { detectTesslChanges } from './detect-tessl-changes.mjs';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const TEST_FILE = /\.test\.(js|ts)$/;
const TST_IMPORT = /(?:from\s+|require\(\s*)['"]tst['"]/;
const NODE_TEST_IMPORT = /(?:from\s+|require\(\s*)['"]node:test['"]/;
const SAFE_SKILL_NAME = /^[a-z0-9][a-z0-9-]*$/;
const SAFE_TEST_PATH = /^[A-Za-z0-9._/-]+$/;
const SKIP_DIRS = new Set(['node_modules', '.git']);

export function classifyTestSource(source) {
  if (TST_IMPORT.test(source)) return 'tst';
  if (NODE_TEST_IMPORT.test(source)) return 'node:test';
  return 'unknown';
}

export function isSafeRelPath(rel) {
  if (typeof rel !== 'string' || !SAFE_TEST_PATH.test(rel)) return false;
  if (rel.startsWith('/') || rel.endsWith('/')) return false;
  return rel.split('/').every((seg) => seg !== '' && seg !== '.' && seg !== '..');
}

function toPosix(rel) {
  return rel.split(sep).join('/');
}

async function walkTestFiles(skillDir) {
  const files = [];

  async function walk(dir) {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch (error) {
      if (error.code === 'ENOENT') return;
      throw error;
    }
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name)) continue;
        await walk(full);
        continue;
      }
      if (entry.isFile() && TEST_FILE.test(entry.name)) files.push(full);
    }
  }

  await walk(skillDir);
  return files.sort();
}

export async function classifySkillTests(skillPath, { repoRoot = REPO_ROOT } = {}) {
  const skillDir = resolve(repoRoot, skillPath);
  const tstTests = [];
  const skippedTests = [];

  for (const full of await walkTestFiles(skillDir)) {
    const rel = toPosix(relative(skillDir, full));
    if (!isSafeRelPath(rel)) {
      skippedTests.push({ path: rel, runner: 'unsafe-path' });
      continue;
    }
    const source = await readFile(full, 'utf8');
    const runner = classifyTestSource(source);
    if (runner === 'tst') tstTests.push(rel);
    else skippedTests.push({ path: rel, runner });
  }

  let action = 'skip';
  let reason = 'none';
  if (tstTests.length > 0) {
    action = 'tst';
    reason = skippedTests.length > 0 ? 'partial' : '';
  } else if (skippedTests.some((t) => t.runner === 'node:test')) {
    reason = 'node:test';
  } else if (skippedTests.length > 0) {
    reason = skippedTests[0].runner;
  }

  return {
    name: skillPath.slice('skills/'.length),
    path: skillPath,
    action,
    reason,
    tstTests,
    skippedTests,
  };
}

// Pipe-separated, not tab-separated: bash `read` collapses consecutive IFS
// whitespace, so an empty tst-tests field would shift skip_count left.
export function toTsv(result) {
  return result.targets
    .map((t) =>
      [t.name, t.action, t.reason, t.tstTests.join(','), String(t.skippedTests.length)].join('|')
    )
    .concat('')
    .join('\n');
}

export async function detectSkillIntegration({
  changedFiles,
  repoRoot = REPO_ROOT,
  all = false,
} = {}) {
  let files = changedFiles;
  if (all) {
    const names = await readdir(join(repoRoot, 'skills'));
    files = names.sort().map((name) => `skills/${name}/SKILL.md`);
  }
  const { skills } = await detectTesslChanges({ changedFiles: files, repoRoot });
  const targets = [];
  for (const skillPath of skills) {
    targets.push(await classifySkillTests(skillPath, { repoRoot }));
  }
  return {
    skills,
    has_skills: skills.length > 0,
    has_tst: targets.some((t) => t.action === 'tst'),
    targets,
  };
}

function parseArgs(argv) {
  const args = argv.slice(2);
  const parsed = { format: 'json', all: false, skills: [], tsvFile: '' };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--format' && args[i + 1]) parsed.format = args[++i];
    else if (arg.startsWith('--format=')) parsed.format = arg.slice('--format='.length);
    else if (arg === '--all') parsed.all = true;
    else if (arg === '--tsv-file' && args[i + 1]) parsed.tsvFile = args[++i];
    else if (arg.startsWith('--tsv-file=')) parsed.tsvFile = arg.slice('--tsv-file='.length);
    else if (arg === '--skills' && args[i + 1]) {
      parsed.skills.push(
        ...args[++i]
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean)
      );
    } else if (arg.startsWith('--skills=')) {
      parsed.skills.push(
        ...arg
          .slice('--skills='.length)
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean)
      );
    } else if (arg === '--skill' && args[i + 1]) parsed.skills.push(args[++i]);
    else throw new Error(`unknown option: ${arg}`);
  }
  if (parsed.format !== 'json' && parsed.format !== 'tsv') {
    throw new Error(`unknown format: ${parsed.format}`);
  }
  for (const name of parsed.skills) {
    if (!SAFE_SKILL_NAME.test(name)) throw new Error(`unsafe skill name: ${JSON.stringify(name)}`);
  }
  return parsed;
}

async function readStdinLines() {
  let input = '';
  process.stdin.setEncoding('utf8');
  for await (const chunk of process.stdin) input += chunk;
  return input
    .split(/\r?\n/)
    .map((file) => file.trim())
    .filter(Boolean);
}

async function main() {
  const parsed = parseArgs(process.argv);
  let changedFiles;
  if (parsed.all) changedFiles = undefined;
  else if (parsed.skills.length) {
    changedFiles = parsed.skills.map((name) => `skills/${name}/SKILL.md`);
  } else {
    changedFiles = await readStdinLines();
  }
  const result = await detectSkillIntegration({
    changedFiles,
    all: parsed.all,
  });
  if (parsed.tsvFile) await writeFile(parsed.tsvFile, toTsv(result));
  if (parsed.format === 'tsv') process.stdout.write(toTsv(result));
  else console.log(JSON.stringify(result));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(`detect-skill-integration: ${error.message}`);
    process.exitCode = 1;
  });
}

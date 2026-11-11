#!/usr/bin/env node
import { spawnSync as spawnSyncNode } from 'node:child_process';
import {
  cpSync as cpSyncNode,
  existsSync as existsSyncNode,
  mkdtempSync as mkdtempSyncNode,
} from 'node:fs';
import { tmpdir as tmpdirNode } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

export async function boot(env = process.env, deps = {}) {
  const spawnSync = deps.spawnSync ?? spawnSyncNode;
  const cpSync = deps.cpSync ?? cpSyncNode;
  const existsSync = deps.existsSync ?? existsSyncNode;
  const mkdtempSync = deps.mkdtempSync ?? mkdtempSyncNode;
  const tmpdir = deps.tmpdir ?? tmpdirNode;
  const exit = deps.exit ?? ((code) => process.exit(code));
  const dynamicImport = deps.import ?? ((specifier) => import(specifier));
  const fail = (m) => {
    console.log(`::error::harness boot: ${m}`);
    exit(1);
    throw new Error(m);
  };
  const scripts = join(env.HARNESS_SLICC ?? '', 'packages/github-workflow/scripts');
  if (!existsSync(join(scripts, 'start-leader.mjs'))) fail(`no start-leader.mjs under ${scripts}`);

  const started = spawnSync(process.execPath, [join(scripts, 'start-leader.mjs')], {
    stdio: 'inherit',
    env,
  });
  if (started.status !== 0) {
    exit(started.status ?? 1);
    return;
  }

  const io = await dynamicImport(join(scripts, 'gh-io.mjs'));
  const url = io.readState()?.joinUrl;
  if (!url) fail('start-leader left no join URL');
  console.log(`::add-mask::${url}`);

  const names = (env.HARNESS_SKILLS ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  if (!names.length) return { url, skills: [] };
  const src = env.HARNESS_SKILLS_DIR ?? '';
  const stage = mkdtempSync(join(tmpdir(), 'harness-skills-'));
  for (const name of names) {
    if (!/^[a-z0-9][a-z0-9-]*$/.test(name)) fail(`bad skill name ${name}`);
    if (!existsSync(join(src, name, 'SKILL.md'))) fail(`${src}/${name} has no SKILL.md`);
    cpSync(join(src, name), join(stage, name), {
      recursive: true,
      filter: (p) => !/\/evals(\/|$)/.test(p.slice(src.length)),
    });
  }
  let ok = false;
  for (let attempt = 1; attempt <= 4 && !ok; attempt += 1) {
    const r = spawnSync(process.execPath, [join(scripts, 'inject-files.mjs')], {
      stdio: 'inherit',
      env: {
        ...env,
        SLICC_JOIN_URL: url,
        INPUT_SOURCE: stage,
        INPUT_TARGET: '/workspace/skills',
      },
    });
    ok = r.status === 0;
    if (!ok) spawnSync('sleep', ['10']);
  }
  if (!ok) fail('could not inject the skills into /workspace/skills');
  for (const name of names) {
    const out = io
      .execOnLeader(url, `ls /workspace/skills/${name}/SKILL.md`, { timeoutMs: 60_000 })
      .toString();
    if (!out.includes('SKILL.md')) fail(`${name} is not in /workspace/skills after injection`);
  }
  console.log(`[harness] injected ${names.join(', ')} into /workspace/skills`);
  return { url, skills: names };
}

const isMain = Boolean(process.argv[1]) && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) await boot();

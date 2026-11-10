#!/usr/bin/env node
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { REPO_ROOT } from '../../test/integration/kernel.mjs';
import { bootKernelSession } from './kernel-session.mjs';

export async function boot(env = process.env, deps = {}) {
  const sessionBoot = deps.bootKernelSession ?? bootKernelSession;
  const mkdir = deps.mkdirSync ?? mkdirSync;
  const root = deps.REPO_ROOT ?? REPO_ROOT;
  const skills = (env.HARNESS_SKILLS ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const out = env.HARNESS_OUT || join(root, 'artifacts', 'harness-boot');
  mkdir(out, { recursive: true });
  const session = await sessionBoot({
    skills,
    skillsDir: env.HARNESS_SKILLS_DIR || join(root, 'skills'),
    artifacts: out,
  });
  console.log('[harness] kernel ready');
  await session.stop();
  return session;
}

const isMain = Boolean(process.argv[1]) && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) await boot();

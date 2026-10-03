#!/usr/bin/env node
/** stop-leader — slicc's stop-leader.mjs, unchanged (the runner expects both in one directory). */

import { spawnSync } from 'node:child_process';
import { join } from 'node:path';

const scripts = process.env.SKILL_EVALS_SLICC_SCRIPTS ?? '';
const r = spawnSync(process.execPath, [join(scripts, 'stop-leader.mjs')], {
  stdio: 'inherit',
  env: process.env,
});
process.exit(r.status ?? 1);

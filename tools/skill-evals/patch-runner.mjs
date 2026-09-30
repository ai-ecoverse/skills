#!/usr/bin/env node
/**
 * patch-runner — make slicc's runner accept a `+` skills condition, in the CHECKED-OUT copy only.
 *
 *   node tools/skill-evals/patch-runner.mjs <slicc checkout>
 *
 * At SLICC_REF (and on slicc main as of 2026-09-30) every run of a `none+<skill>` or
 * `builtin+<set>` condition errors before the agent starts: run.mjs builds the run id from
 * `pathSegment(config.skills)`, which keeps `+` (format.mjs pathSegment keeps [A-Za-z0-9._+-]),
 * and slicc-adapter.mjs refuses any run id outside /^[A-Za-z0-9._-]+$/ with `bad run id
 * tst-002-claude-sonnet-5-none+tst-r1-…` (Skill evals run 36722405889). The run id is an opaque
 * label (a per-run scratch dir on the leader, `run_id` in the record); record and trace PATHS
 * are built separately and keep the condition name. So this rewrites `+` to `-` in the run id
 * and nothing else.
 *
 * Idempotent and strict: exits 0 without a change when the adapter already accepts `+` or the
 * run id is already sanitized (fixed upstream), and exits 1 when the line it expects is not
 * there (a SLICC_REF bump changed the code: look again instead of patching blind).
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// biome-ignore lint/suspicious/noTemplateCurlyInString: the literal source text of run.mjs
export const RUN_ID_BEFORE = '-${safe(config.skills)}-r${r.repeat}-';
// biome-ignore lint/suspicious/noTemplateCurlyInString: the literal source text of run.mjs
export const RUN_ID_AFTER = "-${safe(config.skills).replaceAll('+', '-')}-r${r.repeat}-";
export const ADAPTER_CHECK = 'if (!/^[A-Za-z0-9._-]+$/.test(runId)) throw new Error(';

/** Returns `{ source, changed, reason }` for run.mjs's text given the adapter's text. */
export function patchRunId(runSource, adapterSource) {
  if (!adapterSource.includes(ADAPTER_CHECK))
    return { source: runSource, changed: false, reason: 'adapter no longer refuses + in run ids' };
  if (runSource.includes(RUN_ID_AFTER))
    return { source: runSource, changed: false, reason: 'run id already sanitized' };
  const hits = runSource.split(RUN_ID_BEFORE).length - 1;
  if (hits !== 1)
    throw new Error(`expected the run id line once in run.mjs, found it ${hits} times`);
  return {
    source: runSource.replace(RUN_ID_BEFORE, RUN_ID_AFTER),
    changed: true,
    reason: 'run id: + -> -',
  };
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  let code = 1;
  try {
    const root = process.argv[2];
    if (!root) throw new Error('usage: patch-runner.mjs <slicc checkout>');
    const runPath = join(root, 'packages/bench/scripts/run.mjs');
    const adapterPath = join(root, 'packages/bench/scripts/slicc-adapter.mjs');
    const got = patchRunId(readFileSync(runPath, 'utf8'), readFileSync(adapterPath, 'utf8'));
    if (got.changed) {
      writeFileSync(runPath, got.source);
      console.log(
        `::warning::patched the checked-out runner (${got.reason}): slicc refuses its own + skills conditions at this ref`
      );
    } else console.log(`runner not patched: ${got.reason}`);
    code = 0;
  } catch (err) {
    console.log(`::error::skill-evals patch-runner: ${err.message}`);
  }
  process.exit(code);
}

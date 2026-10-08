#!/usr/bin/env node
/**
 * audit — what each condition's agent could see of the skill under test, from the traces.
 *
 *   node tools/skill-evals/audit.mjs <merged out dir>
 *
 * For every trace (`traces/<benchmark>/<condition>/<model>/<task>-r<n>.json`, plaintext for a file
 * set), searches the agent's TRANSCRIPT only (the trace also holds the task and its rubric, which
 * the agent never saw) for: the skill's SKILL.md path, the runner's staging dir
 * `/workspace/bench-skills/`, the runner's stash of the leader's bundled skills
 * `/workspace/.bench-skills-builtin` (present in every condition, slicc-adapter.mjs:30), and an
 * eval set path (`evals/host`, `evals/slicc`, `tasks.json`). Prints a markdown table per
 * benchmark and condition. Informational: it never fails the job.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

function files(dir) {
  let out = [];
  let names;
  try {
    names = readdirSync(dir);
  } catch {
    return out;
  }
  for (const name of names) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out = out.concat(files(p));
    else if (name.endsWith('.json')) out.push(p);
  }
  return out;
}

export function auditTrace(trace) {
  const skill = String(trace?.record?.benchmark ?? '').replace(/^ecoverse-/, '');
  const text = JSON.stringify(trace?.result?.transcript ?? '');
  return {
    benchmark: trace?.record?.benchmark ?? '?',
    condition: trace?.record?.config?.skills ?? '?',
    skillMd: skill !== '' && text.includes(`skills/${skill}/SKILL.md`),
    benchSkills: text.includes('/workspace/bench-skills/'),
    builtinStash: text.includes('.bench-skills-builtin'),
    evalSet: /evals\/(host|slicc)|tasks\.json/.test(text),
  };
}

export function auditTable(rows) {
  const cells = new Map();
  for (const r of rows) {
    const key = `${r.benchmark}\t${r.condition}`;
    const c = cells.get(key) ?? {
      traces: 0,
      skillMd: 0,
      benchSkills: 0,
      builtinStash: 0,
      evalSet: 0,
    };
    c.traces += 1;
    c.skillMd += r.skillMd ? 1 : 0;
    c.benchSkills += r.benchSkills ? 1 : 0;
    c.builtinStash += r.builtinStash ? 1 : 0;
    c.evalSet += r.evalSet ? 1 : 0;
    cells.set(key, c);
  }
  const lines = [
    '| benchmark | condition | traces | names SKILL.md | names /workspace/bench-skills/ | names .bench-skills-builtin | names an eval set |',
    '|---|---|---|---|---|---|---|',
  ];
  for (const [key, c] of [...cells].sort()) {
    const [b, cond] = key.split('\t');
    lines.push(
      `| ${b} | \`${cond}\` | ${c.traces} | ${c.skillMd} | ${c.benchSkills} | ${c.builtinStash} | ${c.evalSet} |`
    );
  }
  return lines.join('\n');
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const out = process.argv[2] ?? '.';
  const rows = [];
  for (const f of files(join(out, 'traces'))) {
    try {
      rows.push(auditTrace(JSON.parse(readFileSync(f, 'utf8'))));
    } catch {
      rows.push({ benchmark: '?', condition: `unreadable ${f}` });
    }
  }
  console.log(auditTable(rows));
  process.exit(0);
}

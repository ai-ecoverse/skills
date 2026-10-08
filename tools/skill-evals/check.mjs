#!/usr/bin/env node
/**
 * check — after the merge, prove every planned run reached the judge.
 *
 *   node tools/skill-evals/check.mjs --plan plan.json --out <merged out dir>
 *
 * For each matrix entry of the plan (one skill, one condition), counts the records in
 * `<out>/records/**` with that benchmark (`ecoverse-<skill>`) and condition (`config.skills`), and
 * how many of them were judged (a numeric score and no error). Prints a markdown table; exits 1
 * when a cell has fewer judged runs than planned. It never looks at the scores themselves:
 * evals measure, they do not gate.
 *
 * `--stamp host` also adds `harness: "host"` to every record file (design §5: each record names
 * its harness, and the two harnesses' records are never merged). The runner ignores the field.
 */

import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

/** Add `harness` to every record under `dir`; returns how many files it rewrote. */
export function stampRecords(dir, harness) {
  let n = 0;
  let names;
  try {
    names = readdirSync(dir);
  } catch {
    return n;
  }
  for (const name of names) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) n += stampRecords(p, harness);
    else if (name.endsWith('.json')) {
      try {
        const record = JSON.parse(readFileSync(p, 'utf8'));
        if (record.harness === harness) continue;
        writeFileSync(p, `${JSON.stringify({ ...record, harness }, null, 2)}\n`);
        n += 1;
      } catch {
        // an unreadable record is reported by checkRecords
      }
    }
  }
  return n;
}

export function readRecords(dir) {
  const out = [];
  let names;
  try {
    names = readdirSync(dir);
  } catch {
    return out;
  }
  for (const name of names) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...readRecords(p));
    else if (name.endsWith('.json')) {
      try {
        out.push(JSON.parse(readFileSync(p, 'utf8')));
      } catch {
        out.push({ unreadable: p });
      }
    }
  }
  return out;
}

const judged = (r) => typeof r?.score === 'number' && !r.error;

export function checkRecords(plan, records) {
  const rows = [];
  for (const e of plan.matrix?.include ?? []) {
    const benchmark = `ecoverse-${e.skill}`;
    const mine = records.filter(
      (r) => r.benchmark === benchmark && r.config?.skills === e.condition
    );
    const ok = mine.filter(judged).length;
    rows.push({
      skill: e.skill,
      condition: e.condition,
      planned: e.runs,
      records: mine.length,
      judged: ok,
      errored: mine.filter((r) => r.error).length,
      pass: ok >= e.runs,
    });
  }
  const unreadable = records.filter((r) => r.unreadable).map((r) => r.unreadable);
  return { rows, unreadable, ok: rows.every((r) => r.pass) && unreadable.length === 0 };
}

export function table({ rows, unreadable }) {
  const lines = [
    '| skill | condition | planned | records | judged | errored |',
    '|---|---|---|---|---|---|',
    ...rows.map(
      (r) =>
        `| ${r.skill} | \`${r.condition}\` | ${r.planned} | ${r.records} | ${r.judged} | ${r.errored} |`
    ),
  ];
  for (const u of unreadable) lines.push('', `unreadable record: ${u}`);
  return lines.join('\n');
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  let code = 1;
  try {
    const { values } = parseArgs({
      args: process.argv.slice(2),
      options: { plan: { type: 'string' }, out: { type: 'string' }, stamp: { type: 'string' } },
    });
    if (!values.plan || !values.out) throw new Error('usage: check.mjs --plan <file> --out <dir>');
    const plan = JSON.parse(readFileSync(values.plan, 'utf8'));
    if (values.stamp) {
      if (!['host', 'slicc'].includes(values.stamp)) throw new Error('--stamp is host or slicc');
      stampRecords(join(values.out, 'records'), values.stamp);
    }
    const got = checkRecords(plan, readRecords(join(values.out, 'records')));
    console.log(table(got));
    for (const r of got.rows.filter((x) => !x.pass))
      console.log(
        `::error::${r.skill} ${r.condition}: ${r.judged} of ${r.planned} planned runs judged`
      );
    code = got.ok ? 0 : 1;
  } catch (err) {
    console.log(`::error::skill-evals check: ${err.message}`);
  }
  process.exit(code);
}

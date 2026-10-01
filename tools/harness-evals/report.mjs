#!/usr/bin/env node
/**
 * report — merge harness-eval records (records/*.json from every arm job) into report.json and
 * report.md: per arm × goal the pass count, and per arm the pass rate, median time, steps and
 * spend. A pass is the shared check (judge.mjs); the arms' own verdicts appear as "self".
 *
 *   node tools/harness-evals/report.mjs <dir with records/*.json, searched recursively> <out dir>
 */
import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export function readRecords(dir) {
  const walk = (d) =>
    readdirSync(d).flatMap((f) =>
      statSync(join(d, f)).isDirectory() ? walk(join(d, f)) : [join(d, f)]
    );
  return walk(dir)
    .filter((f) => /\/records\/[^/]+\.json$/.test(f))
    .map((f) => JSON.parse(readFileSync(f, 'utf8')));
}

const median = (xs) => {
  const s = xs.filter((x) => typeof x === 'number').sort((a, b) => a - b);
  return s.length ? s[Math.floor((s.length - 1) / 2)] : null;
};

export function summarize(records) {
  const arms = [...new Set(records.map((r) => r.arm))].sort();
  const goals = [...new Set(records.map((r) => r.goal))].sort();
  const cell = (arm, goal) => records.filter((r) => r.arm === arm && r.goal === goal);
  const rows = arms.map((arm) => {
    const rs = records.filter((r) => r.arm === arm);
    const costs = rs.map((r) => r.cost_usd).filter((c) => typeof c === 'number');
    return {
      arm,
      runs: rs.length,
      passed: rs.filter((r) => r.pass).length,
      self_passed: rs.filter((r) => r.self_ok).length,
      errors: rs.filter((r) => r.error).length,
      median_seconds: median(rs.map((r) => r.seconds)),
      median_steps: median(rs.map((r) => r.steps)),
      cost_usd: costs.length ? costs.reduce((a, b) => a + b, 0) : null,
      goals: Object.fromEntries(
        goals.map((g) => [
          g,
          { passed: cell(arm, g).filter((r) => r.pass).length, runs: cell(arm, g).length },
        ])
      ),
    };
  });
  return { arms, goals, rows };
}

export function markdown(summary) {
  const { goals, rows } = summary;
  const head = `| arm | passed | ${goals.join(' | ')} | self-reported | median s | median steps | spend | errors |`;
  const sep = `|${'---|'.repeat(goals.length + 7)}`;
  const lines = rows.map(
    (r) =>
      `| ${r.arm} | ${r.passed}/${r.runs} | ${goals.map((g) => `${r.goals[g].passed}/${r.goals[g].runs}`).join(' | ')} | ${r.self_passed} | ${r.median_seconds == null ? '–' : r.median_seconds.toFixed(0)} | ${r.median_steps ?? '–'} | ${r.cost_usd == null ? '–' : `$${r.cost_usd.toFixed(2)}`} | ${r.errors} |`
  );
  return `# Harness evals\n\nA pass is meep-meep's own success check applied to the final page of every arm; "self-reported" is the arm's own verdict (webrunner arms only).\n\n${head}\n${sep}\n${lines.join('\n')}\n`;
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  const [dir, outDir] = process.argv.slice(2);
  const summary = summarize(readRecords(dir));
  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, 'report.json'), `${JSON.stringify(summary, null, 2)}\n`);
  writeFileSync(join(outDir, 'report.md'), markdown(summary));
  process.stdout.write(markdown(summary));
}

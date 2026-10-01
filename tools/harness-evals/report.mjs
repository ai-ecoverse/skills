#!/usr/bin/env node
/**
 * report — merge harness-eval records (records/*.json from every arm job) into report.json and
 * report.md, one table per skill: per arm × goal the pass count, and per arm the pass rate,
 * median time, steps and spend. A pass is the skill adapter's `judge`, the same check for every arm; the arms' own verdicts appear as "self".
 *
 *   node tools/harness-evals/report.mjs <dir with records/*.json, searched recursively> <out dir>
 */
import {
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

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

/** Arm ids and goal ids are only unique within a skill, so every table is per skill. */
export function summarize(records) {
  const skills = [...new Set(records.map((r) => r.skill))].sort();
  return {
    skills: skills.map((skill) => {
      const own = records.filter((r) => r.skill === skill);
      const arms = [...new Set(own.map((r) => r.arm))].sort();
      const goals = [...new Set(own.map((r) => r.goal))].sort();
      const cell = (arm, goal) => own.filter((r) => r.arm === arm && r.goal === goal && !r.invalid);
      const rows = arms.map((arm) => {
        // Invalid runs (escalations.mjs) are counted, never scored.
        const all = own.filter((r) => r.arm === arm);
        const rs = all.filter((r) => !r.invalid);
        const costs = rs.map((r) => r.cost_usd).filter((c) => typeof c === 'number');
        return {
          arm,
          runs: rs.length,
          passed: rs.filter((r) => r.pass).length,
          self_passed: rs.filter((r) => r.self_ok).length,
          errors: rs.filter((r) => r.error).length,
          invalid: all.length - rs.length,
          escalations_allowed: all.reduce((n, r) => n + (r.escalations?.allowed ?? 0), 0),
          median_seconds: median(rs.map((r) => r.seconds)),
          median_steps: median(rs.map((r) => r.steps)),
          cost_usd: costs.length ? costs.reduce((x, y) => x + y, 0) : null,
          goals: Object.fromEntries(
            goals.map((g) => [
              g,
              { passed: cell(arm, g).filter((r) => r.pass).length, runs: cell(arm, g).length },
            ])
          ),
        };
      });
      return { skill, arms, goals, rows };
    }),
  };
}

function table({ skill, goals, rows }) {
  const head = `| arm | passed | ${goals.join(' | ')} | self-reported | median s | median steps | spend | errors | invalid |`;
  const sep = `|${'---|'.repeat(goals.length + 8)}`;
  const lines = rows.map(
    (r) =>
      `| ${r.arm} | ${r.passed}/${r.runs} | ${goals.map((g) => `${r.goals[g].passed}/${r.goals[g].runs}`).join(' | ')} | ${r.self_passed} | ${r.median_seconds == null ? '–' : r.median_seconds.toFixed(0)} | ${r.median_steps ?? '–'} | ${r.cost_usd == null ? '–' : `$${r.cost_usd.toFixed(2)}`} | ${r.errors} | ${r.invalid} |`
  );
  return `## ${skill}\n\n${head}\n${sep}\n${lines.join('\n')}\n`;
}

export function markdown(summary) {
  const body = summary.skills.length ? summary.skills.map(table).join('\n') : 'No records.\n';
  return `# Harness evals\n\nA pass is the skill adapter's \`judge\` applied to the final page of every arm; "self-reported" is the arm's own verdict (from the adapter's \`result\`, where it has one). An invalid run (a skill arm whose scoops had commands approved by the cone) is counted under "invalid" and left out of every other column.\n\n${body}`;
}

// realpath: argv[1] keeps symlinks (macOS /tmp), import.meta.url doesn't.
if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  const [dir, outDir] = process.argv.slice(2);
  const summary = summarize(readRecords(dir));
  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, 'report.json'), `${JSON.stringify(summary, null, 2)}\n`);
  writeFileSync(join(outDir, 'report.md'), markdown(summary));
  process.stdout.write(markdown(summary));
}

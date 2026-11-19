import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

export const TEMPLATE = fileURLToPath(new URL('../templates/llm-wiki.shtml', import.meta.url));
const SELF = fileURLToPath(import.meta.url);

export function rendererSource(html = fs.readFileSync(TEMPLATE, 'utf8')) {
  const start = html.indexOf('const md = (() => {');
  const end = html.indexOf('\n    })();\n', start);
  if (start < 0 || end < 0) throw new Error('no renderer block in the template');
  return html.slice(start, end + '\n    })();'.length);
}

export function render(cases, timeout = 10000) {
  const r = spawnSync('node', [SELF], {
    input: JSON.stringify(cases),
    encoding: 'utf8',
    timeout,
  });
  if (r.status !== 0)
    return { ok: false, status: r.status, signal: r.signal, stderr: r.stderr || '' };
  return { ok: true, out: JSON.parse(r.stdout) };
}

if (process.argv[1] === SELF) {
  const md = new Function(`${rendererSource()}\nreturn md;`)();
  const cases = JSON.parse(fs.readFileSync(0, 'utf8'));
  const out = cases.map(([fn, ...args]) => md[fn](...args));
  process.stdout.write(JSON.stringify(out));
}

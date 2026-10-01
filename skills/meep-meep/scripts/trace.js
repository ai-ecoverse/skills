// One run's record for the debug page: trace.jsonl (a start line, one line
// per OODA step, an end line) plus each step's raw snapshot and screenshot
// next to it. fs is passed in so tests can run without the realm.

const RUNS = '/tmp/meep/runs';
const INDEX = `${RUNS}/index.json`;
const MAX_TEXT = 4000;

function runId(now, label) {
  const stamp = new Date(now).toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const slug = String(label || 'run')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 24);
  return `${stamp}-${slug || 'run'}`;
}

/** Long command output is cut so one step cannot bloat the trace. */
function clip(text, max = MAX_TEXT) {
  const s = String(text == null ? '' : text);
  return s.length > max ? `${s.slice(0, max)}… (${s.length - max} more chars)` : s;
}

/**
 * Open a trace. Every write rewrites trace.jsonl whole: the VFS has no
 * append, and a run is a few dozen lines. A failed write never fails the run.
 */
async function openTrace(fs, opts) {
  const id = opts.id || runId(opts.now || Date.now(), opts.label);
  const dir = `${RUNS}/${id}`;
  const lines = [];
  const safe = async (fn) => {
    try {
      await fn();
    } catch {
      // The trace is for looking at a run, not part of it.
    }
  };
  await fs.mkdir(dir, { recursive: true });
  const flush = () =>
    safe(() =>
      fs.writeFile(`${dir}/trace.jsonl`, `${lines.map((l) => JSON.stringify(l)).join('\n')}\n`)
    );
  const index = async (entry) =>
    safe(async () => {
      let list = [];
      if (await fs.exists(INDEX)) {
        try {
          list = JSON.parse(await fs.readFile(INDEX));
        } catch {
          list = [];
        }
      }
      list = [entry, ...list.filter((item) => item.id !== id)].slice(0, 50);
      await fs.writeFile(INDEX, JSON.stringify(list, null, 2));
    });
  const trace = {
    id,
    dir,
    path: (name) => `${dir}/${name}`,
    async start(meta) {
      lines.push({ type: 'start', id, t: Date.now(), ...meta });
      await flush();
      await index({
        id,
        t: Date.now(),
        goal: meta.goal,
        url: meta.url,
        decider: meta.decider,
        ok: null,
      });
    },
    async step(record) {
      lines.push({ type: 'step', t: Date.now(), ...record });
      await flush();
    },
    async file(name, content) {
      await safe(() => fs.writeFile(`${dir}/${name}`, content));
      return name;
    },
    async end(summary) {
      lines.push({ type: 'end', t: Date.now(), ...summary });
      await flush();
      const start = lines[0] || {};
      await index({
        id,
        t: start.t,
        goal: start.goal,
        url: start.url,
        decider: start.decider,
        ok: summary.ok,
        reason: summary.reason,
        steps: summary.steps,
      });
    },
  };
  return trace;
}

module.exports = { RUNS, INDEX, runId, clip, openTrace };

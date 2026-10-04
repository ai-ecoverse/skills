// intent-arm — the eval arms that put a Sonnet scoop on one browser tool:
//   --tool intent          the scoop may run `intent` and nothing else; this
//                          process serves its requests (intent-core.js) and
//                          does the browser work, which the scoop's grant
//                          forbids it (a scoop's allowedCommands also binds
//                          the commands an allowed .jsh runs, probed 2026-10-02)
//   --tool playwright-cli  the control: the same scoop with raw playwright-cli
// Both run `agent --no-escalate`, so the grant is a hard limit. The result
// (--json) counts the tool calls, the characters each returned (context per
// step), the scoop's tokens and cost, and the intent calls' latency.

const browser = require('sliccy:browser');
const cli = require('sliccy:cli');
const fs = require('fs');
const exec = require('sliccy:exec');
const skill = require('sliccy:skill');
const page = require('./snapshot.js');
const { createIntent, DIR, CALLS, STATE } = require('./intent-core.js');
const { toolCalls, lastMessage, stats } = require('./transcript.js');
const { runId, checkUrl, prompt, printable } = require('./arm.js');

const ARM_DIR = '/tmp/intent-arm';
const MODEL_DEFAULT = 'claude-sonnet-5-5';
const TOOLS = ['intent', 'playwright-cli'];
// Shell loops and helper scripts that batch tool calls are fair play for
// every arm (Lars, 2026-10-03), so bash and sh are in too; whatever they
// run is still held to the scoop's grant.
const UTILITIES = ['grep', 'head', 'tail', 'sleep', 'sed', 'awk', 'cut', 'wc', 'sort', 'uniq', 'echo', 'cat', 'tr', 'jq', 'bash', 'sh'];

const HELP = `
intent-arm — run one goal with a Sonnet scoop that browses through one tool

USAGE
  intent-arm [--url URL] --goal TEXT|--goal-file PATH --tool intent|playwright-cli
                 [--model ID] [--time-limit S] [--json] [--private]
                 [--s1-model M | --s1-from DIR] [--require-gpu] [--cf-account ID]   intent's System 1
                 [--retrieve answer|budget|lexical] [--retrieve-budget CHARS]  intent's RETRIEVE variant

Without --url no page is open: the scoop opens the site the goal names
itself (a bench task), and the run id ends in -run.

--goal-file reads the goal from a file, keeping it off the command line.
--private prints the run id and numbers only: the answer, the final URL and
everything else drawn from the task or its pages stay in the run's files,
${ARM_DIR}/<run>/ (result.json, transcript.md, calls.jsonl, decisions/, …),
for a bench to read into its encrypted trace.

Prints the run's numbers; the files are in ${ARM_DIR}/<run>/.
`.trim();

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * The scoop's transcript: /tmp/agent-<name>-<UTC time it ended>.md. fs.stat
 * has no mtime in the realm, so the time comes from the name, and the
 * prompt inside confirms it is this run's.
 */
async function findTranscript(since, promptText) {
  const stamp = (n) => {
    const m = /-(\d{4}-\d\d-\d\dT\d\d)-(\d\d)-(\d\d)-(\d{3})Z\.md$/.exec(n);
    return m ? Date.parse(`${m[1]}:${m[2]}:${m[3]}.${m[4]}Z`) : 0;
  };
  const names = (await fs.readDir('/tmp'))
    .filter((n) => /^agent-.*\.md$/.test(n) && stamp(n) >= since - 2000)
    .sort((x, y) => stamp(y) - stamp(x));
  for (const name of names) {
    const text = String(await fs.readFile(`/tmp/${name}`));
    if (text.includes(promptText.slice(0, 200))) return text;
  }
  return '';
}

async function main() {
  const { flags } = process.argv.parseFlags();
  if (flags.help || flags.h) cli.help(HELP);
  const url = typeof flags.url === 'string' ? flags.url : '';
  // --goal-file: the task text read from the VFS, so it is not on the
  // command line a bench runner may log.
  let goal = typeof flags.goal === 'string' ? flags.goal : '';
  if (!goal && typeof flags['goal-file'] === 'string') {
    try {
      goal = String(await fs.readFile(flags['goal-file'])).trim();
    } catch {
      cli.die(`cannot read --goal-file ${flags['goal-file']}`, { prefix: 'intent-arm' });
    }
  }
  const tool = flags.tool;
  if (!goal || !TOOLS.includes(tool)) cli.die('usage: intent-arm [--url URL] --goal TEXT|--goal-file PATH --tool intent|playwright-cli', { prefix: 'intent-arm' });
  const badUrl = checkUrl(url);
  if (badUrl) cli.die(badUrl, { prefix: 'intent-arm' });
  const priv = Boolean(flags.private);
  const model = typeof flags.model === 'string' ? flags.model : MODEL_DEFAULT;
  const limitS = Math.max(30, Number.parseFloat(flags['time-limit']) || 900);
  const run = runId(url);
  const dir = `${ARM_DIR}/${run}`;
  await fs.mkdir(dir, { recursive: true });
  const started = Date.now();

  // A clean intent state: no tab or call log from an earlier run.
  let finished = false;
  let serving = null;
  let system1Info = null;
  if (tool === 'intent') {
    await fs.mkdir(DIR, { recursive: true });
    await fs.rm(STATE).catch(() => {});
    await fs.rm(CALLS).catch(() => {});
    const core = createIntent({ exec, fs, browser, skill, requireBundle: () => require('/shared/cache/kev/bundle.cjs') });
    const s1 = {
      ...(flags['cf-account'] ? { 'cf-account': flags['cf-account'] } : {}),
      ...(typeof flags['s1-model'] === 'string' ? { model: flags['s1-model'] } : {}),
      ...(typeof flags['s1-from'] === 'string' ? { from: flags['s1-from'] } : {}),
      ...(flags['require-gpu'] ? { 'require-gpu': true } : {}),
      // The training log: what System 1 saw and chose on every call (intent-core.js).
      'log-dir': `${dir}/decisions`,
      // The RETRIEVE variant this arm tries: answer (default), budget, lexical.
      ...(typeof flags.retrieve === 'string' ? { retrieve: flags.retrieve } : {}),
      ...(flags['retrieve-budget'] ? { 'retrieve-budget': Number(flags['retrieve-budget']) } : {}),
    };
    // System 1 loads before the agent starts: a missing bundle or, with
    // --require-gpu, a software WebGPU adapter ends the run here, at once.
    try {
      const loaded = await core.warm(s1);
      system1Info = { name: loaded.name, runtime: loaded.runtime || null, loadMs: loaded.loadMs ?? null };
    } catch (err) {
      if (err?.name === 'NodeExitError') throw err;
      const failed = { run, tool, ok: false, error: `System 1 did not load: ${String(err?.message || err)}` };
      await fs.writeFile(`${dir}/result.json`, JSON.stringify(failed, null, 2));
      if (flags.json) cli.out(printable(failed, { private: priv }));
      else console.error(`intent-arm: ${priv ? `System 1 did not load (${dir}/result.json)` : failed.error}`);
      process.exit(1);
    }
    serving = core.serve(s1, { stop: () => finished });
  }

  const cwd = `${dir}/scoop`;
  await fs.mkdir(cwd, { recursive: true });
  // Both arms get the same text utilities beside their browser tool: a
  // playwright-cli scoop without grep, head or sleep could not page through
  // a large snapshot and gave up on Wikipedia (2026-10-03).
  const allowed = [tool, ...UTILITIES].join(',');
  const job = exec.start(['agent', '--model', model, '--no-escalate', '--usage', cwd, allowed, prompt(url, goal, tool)]);
  // An open stdin keeps \`agent\` waiting before it starts (seen 2026-10-02).
  if (job.stdin && job.stdin.end) job.stdin.end();
  let timedOut = false;
  const timer = new Promise((resolve) =>
    setTimeout(() => {
      timedOut = true;
      resolve(null);
    }, limitS * 1000)
  );
  let done = await Promise.race([job.done, timer]);
  if (!done) {
    job.kill('SIGTERM');
    done = await Promise.race([job.done, sleep(10000).then(() => null)]);
  }
  finished = true;
  if (serving) await Promise.race([serving, sleep(5000)]);
  const seconds = (Date.now() - started) / 1000;

  const stdout = String((done && done.stdout) || '');
  const stderr = String((done && done.stderr) || '');
  let usage = null;
  const u = /agent-usage:\s*(\{.*\})/.exec(stderr);
  if (u) {
    try {
      usage = JSON.parse(u[1]);
    } catch {
      usage = null;
    }
  }
  const transcript = await findTranscript(started, prompt(url, goal, tool));
  if (transcript) await fs.writeFile(`${dir}/transcript.md`, transcript);
  const turns = Number((/- turns: (\d+)/.exec(transcript) || [])[1]) || null;
  // The answer in full: result.json keeps 500 characters of it, which cut a
  // bench's FINAL ANSWER off (BU Bench V2.1, 2026-10-04).
  await fs.writeFile(`${dir}/answer.txt`, lastMessage(transcript) || stdout.trim());
  const calls = toolCalls(transcript);
  // A call may chain several commands ("fill …; check …; click …"): count
  // the shell calls that use the tool, and the tool invocations in them.
  const word = `(^|[;&|\\s(])${tool.replace('-', '\\-')}\\s`;
  const browsing = calls.filter((c) => new RegExp(word).test(` ${c.command} `) && !/--help\b/.test(c.command));
  const invocations = browsing.reduce((n, c) => n + (` ${c.command} `.match(new RegExp(word, 'g')) || []).length, 0);

  // The intent calls as the server logged them: latency and outcome per call.
  let intentLog = [];
  if (tool === 'intent' && (await fs.exists(CALLS))) {
    intentLog = String(await fs.readFile(CALLS))
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l));
    await fs.writeFile(`${dir}/calls.jsonl`, `${intentLog.map((e) => JSON.stringify(e)).join('\n')}\n`);
  }
  const count = (xs, key) => xs.reduce((m, x) => ({ ...m, [x[key]]: (m[x[key]] || 0) + 1 }), {});

  // The final page: the intent server's tab, else the last tab the scoop named.
  let tab = null;
  if (tool === 'intent') {
    try {
      tab = JSON.parse(String(await fs.readFile(STATE))).tab || null;
    } catch {
      tab = null;
    }
  } else {
    // Tab ids are 32 hex digits, passed as --tab=<id> or through a variable.
    const named = [...calls.map((c) => c.command).join('\n').matchAll(/\b([0-9A-F]{32})\b/g)];
    tab = named.length ? named[named.length - 1][1] : null;
  }
  let finalUrl = null;
  let finalText = '';
  if (tab) {
    const snap = await exec.spawn(['playwright-cli', 'snapshot', `--tab=${tab}`]);
    if (snap.exitCode === 0) {
      const shot = page.parseSnapshot(snap.stdout);
      finalUrl = shot.url;
      finalText = page.pageTextLines(shot, null, 4000).join('\n');
      await fs.writeFile(`${dir}/final.snapshot.txt`, snap.stdout);
    }
    const shotPath = `${dir}/final.png`;
    await exec.spawn(['playwright-cli', 'screenshot', `--tab=${tab}`, `--filename=${shotPath}`]);
  }

  // What the bench judge reads for a goal with a rubric.
  // The scoop's transcript is written when it exits: a run stopped at the
  // time limit has none (a Paperclips run, 2026-10-03). Its intent calls are
  // still in the call log, so the judge reads those instead.
  const fromLog = intentLog.map((e) => `intent ${e.kind} "${String(e.intent).slice(0, 200)}" → ${e.outcome || `error: ${String(e.error || '').slice(0, 200)}`}`);
  const judge = {
    steps: calls.length ? calls.map((c) => `${c.command.slice(0, 300)} → ${c.result.replace(/\s+/g, ' ').slice(0, 500)}`) : fromLog,
    finalResult: [`The agent's answer: ${stdout.trim().slice(0, 2000) || '(none)'}`, `Final page (${finalUrl || 'unknown'}):`, finalText || '(none)'].join('\n'),
    screenshots: (await fs.exists(`${dir}/final.png`)) ? ['final.png'] : [],
  };
  await fs.writeFile(`${dir}/judge.json`, JSON.stringify(judge));

  const result = {
    run,
    tool,
    model,
    seconds: Math.round(seconds * 10) / 10,
    timedOut,
    exitCode: done ? done.exitCode : null,
    steps: browsing.length,
    // No transcript (stopped at the time limit): the intent calls, as logged.
    ...(calls.length ? {} : { stepsFromLog: intentLog.length }),
    invocations,
    // The caller's escape hatches: naming a ref after a "not sure", or the raw snapshot.
    refCalls: browsing.filter((c) => /--ref[= ]/.test(c.command)).length,
    fullCalls: browsing.filter((c) => /--full\b/.test(c.command)).length,
    toolCalls: calls.length,
    turns,
    usage,
    // Context per step: what each tool call put into the scoop's context.
    resultChars: stats(browsing.map((c) => c.chars)),
    inputTokensPerTurn: usage && turns ? Math.round((usage.input + usage.cacheRead + usage.cacheWrite) / turns) : null,
    intent:
      tool === 'intent'
        ? {
            calls: intentLog.length,
            ms: stats(intentLog.map((e) => e.ms || 0)),
            kinds: count(intentLog, 'kind'),
            outcomes: count(intentLog.map((e) => ({ ...e, outcome: e.outcome || 'error' })), 'outcome'),
            system1Calls: intentLog.filter((e) => e.s1).length,
          }
        : null,
    finalUrl,
    tab,
    system1: system1Info,
    answer: stdout.trim().slice(0, 500),
  };
  await fs.writeFile(`${dir}/result.json`, JSON.stringify(result, null, 2));
  if (flags.json) cli.out(printable(result, { private: priv }));
  else {
    console.log(`${tool}: ${result.steps} steps in ${result.seconds} s${timedOut ? ' (time limit)' : ''}, $${usage ? usage.cost.toFixed(3) : '?'}`);
    console.log(`  context per step: ${result.resultChars ? `${result.resultChars.mean} chars mean, ${result.resultChars.max} max` : 'n/a'}`);
    console.log(`  files: ${dir}`);
  }
  // A scoop killed at the time limit can leave timers behind.
  process.exit(0);
}

try {
  await main();
} catch (err) {
  if (err?.name === 'NodeExitError') throw err;
  const message = String(err?.message || err);
  // --private: an error can quote the task or a page, so it stays on the leader.
  if (process.argv.includes('--private')) {
    await fs.mkdir(ARM_DIR, { recursive: true }).catch(() => {});
    await fs.writeFile(`${ARM_DIR}/last-error.txt`, message).catch(() => {});
    cli.die(`failed; the error is in ${ARM_DIR}/last-error.txt`, { prefix: 'intent-arm' });
  }
  cli.die(message, { prefix: 'intent-arm' });
}

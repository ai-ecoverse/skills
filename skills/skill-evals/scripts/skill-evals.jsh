  // skill-evals.jsh — run a skill's evals/slicc/ task set inside SLICC: one `agent` per task run,
  // a separate `agent` judges it; report, dip, sprinkle, Hugging Face upload (records + report only).
  const fs = require('fs');
  const exec = require('sliccy:exec');
  const cli = require('sliccy:cli');
  const H = await import('./harness.js');
  const F = await import('./evals-format.js');

  const HELP = `
skill-evals — run a skill's evals/slicc/tasks.json inside SLICC (harness: slicc)

USAGE
  skill-evals validate <skill|path>                 validate the set (harness slicc)
  skill-evals plan <skill|path> [--repeats N] [--tasks id,id] [--model M] [--thinking L]
                   [--judge-model M] [--judge-thinking L] [--conditions without,with]
                                                    freeze the set + skill, write plan.json
  skill-evals preflight <run-id> <without|with>     make the condition true and prove it
  skill-evals run-one <run-id> <n> [--force]        run plan run n (ONE bash call, serial)
  skill-evals judge <run-id> <n>                    judge run n with a separate agent
  skill-evals status <run-id>                       runs and the next command
  skill-evals report <run-id>                       report.json + report.md
  skill-evals present <run-id> --dip [--print] | --sprinkle
  skill-evals publish <run-id> --hf [owner/name] [--dry-run]
  skill-evals cleanup <run-id>                      remove the staged skill copy

<skill|path>: an installed skill name, a skill directory, or its evals/slicc/tasks.json.

FLAGS
  --root DIR      run dirs (default /tmp/skill-evals)
  --private DIR   transcripts and judge evidence, never shared (default $HOME/skill-evals)
  --row NAME      cost row of the invoking unit (default $USER)
  --json          print the result object

Run dir /tmp/skill-evals/<run-id>/: plan.json, state.json, preflight-*.json, records/<n>.json,
report.json, report.md, report.dip.shtml, .agents/skills/<skill>/ (with only).
`.trim();

  const parsed = process.argv.parseFlags();
  const sub = parsed.subcommand || '';
  const pos = parsed.positional.slice(1);
  const flags = parsed.flags;
  const ROOT = String(flags.root || '/tmp/skill-evals').replace(/\/$/, '');
  const PRIVATE_ROOT = String(flags.private || `${process.env.HOME || '/tmp'}/skill-evals`).replace(
    /\/$/,
    ''
  );
  const ROW = String(flags.row || process.env.USER || '');

  const die = (msg) => cli.die(msg, { prefix: 'skill-evals' });
  const q = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;
  const say = (obj, line) => (flags.json ? cli.out(obj) : console.log(line));

  async function sh(cmd, cwd) {
    const full = cwd ? `cd ${q(cwd)} && ${cmd}` : cmd;
    return exec(full);
  }
  const shArgv = (argv, cwd) => sh(argv.map(q).join(' '), cwd);

  async function readJson(p) {
    return JSON.parse(await fs.readFile(p));
  }
  async function writeJson(p, v) {
    await fs.mkdir(p.slice(0, p.lastIndexOf('/')), { recursive: true });
    await fs.writeFile(p, `${JSON.stringify(v, null, 2)}\n`);
  }
  async function isDir(p) {
    try {
      return (await fs.stat(p)).isDirectory;
    } catch {
      return false;
    }
  }

  /** Every file below dir, as relative paths. */
  async function walk(dir, rel = '') {
    const out = [];
    for (const name of await fs.readDir(rel ? `${dir}/${rel}` : dir)) {
      const r = rel ? `${rel}/${name}` : name;
      if (await isDir(`${dir}/${r}`)) out.push(...(await walk(dir, r)));
      else out.push(r);
    }
    return out;
  }
  async function copyTree(src, dst, rels) {
    for (const r of rels) {
      const to = `${dst}/${r}`;
      await fs.mkdir(to.slice(0, to.lastIndexOf('/')), { recursive: true });
      await fs.writeFileBinary(to, await fs.readFileBinary(`${src}/${r}`));
    }
  }
  async function rmTree(p) {
    if (!(await fs.exists(p))) return;
    const r = await shArgv(['rm', '-rf', p]);
    if (r.exitCode !== 0) die(`could not remove ${p}: ${r.stderr.trim()}`);
  }

  /** <skill|path> → { skillDir, name, setPath }. */
  function resolveSkill(arg) {
    if (!arg) die('name a skill, a skill directory, or its evals/slicc/tasks.json');
    let skillDir;
    if (arg.endsWith('.json')) skillDir = arg.replace(/\/evals\/slicc\/[^/]+\.json$/, '');
    else if (arg.includes('/')) skillDir = arg.replace(/\/$/, '');
    else skillDir = `/workspace/skills/${arg}`;
    const name = skillDir.slice(skillDir.lastIndexOf('/') + 1);
    if (!H.isSafeName(name)) die(`not a skill directory: ${arg}`);
    return { skillDir, name, setPath: `${skillDir}/evals/slicc/tasks.json` };
  }

  async function loadSet(setPath, name) {
    if (!(await fs.exists(setPath))) die(`no slicc eval set at ${setPath}`);
    let set;
    try {
      set = await readJson(setPath);
    } catch (e) {
      die(`${setPath} is not JSON: ${e.message}`);
    }
    const v = F.validateSet(set, { harness: 'slicc', skill: name });
    const base = setPath.slice(0, setPath.lastIndexOf('/'));
    for (const t of set.tasks ?? [])
      for (const f of t.slicc?.files ?? [])
        if (typeof f.from === 'string' && !(await fs.exists(`${base}/${f.from}`)))
          v.errors.push(`${t.id}: fixture ${f.from} does not exist`);
    v.ok = v.errors.length === 0;
    return { set, validation: v };
  }

  function runIdArg() {
    const id = pos[0];
    if (!H.isSafeName(id ?? '')) die('usage: skill-evals <command> <run-id> ...');
    return id;
  }
  async function loadPlan(id) {
    const p = `${ROOT}/${id}/plan.json`;
    if (!(await fs.exists(p))) die(`no plan at ${p}; run skill-evals plan first`);
    return readJson(p);
  }
  async function loadState(plan) {
    const p = `${plan.run_dir}/state.json`;
    return (await fs.exists(p)) ? readJson(p) : { condition: null };
  }

  async function costNow() {
    const r = await exec('cost --json');
    if (r.exitCode !== 0) die(`cost --json failed: ${r.stderr.trim()}`);
    const row = H.costRow(JSON.parse(r.stdout), ROW);
    if (!row) die(`no cost row named ${ROW}; pass --row <the invoking scoop's name>`);
    return row;
  }
  async function tmpTranscripts() {
    return new Set((await fs.readDir('/tmp')).filter((n) => /^agent-.*\.md$/.test(n)));
  }

  /** One blocking agent call with its own row delta and wall time. */
  async function timedAgent(argv, cwd) {
    const before = await costNow();
    const t0 = Date.now();
    const r = await shArgv(argv, cwd);
    const ms = Date.now() - t0;
    const after = await costNow();
    return {
      rc: r.exitCode,
      stdout: r.stdout,
      stderr: r.stderr,
      ms,
      delta: H.costDelta(before, after),
    };
  }

  // ── validate ──────────────────────────────────────────────────────────
  async function cmdValidate() {
    const { name, setPath } = resolveSkill(pos[0]);
    const { set, validation } = await loadSet(setPath, name);
    if (flags.json) cli.out({ set: setPath, ...validation });
    else if (validation.ok)
      console.log(`  ok  ${setPath}: ${set.tasks.length} tasks, ${set.benchmark}`);
    else for (const e of validation.errors) console.log(`  error  ${e}`);
    if (!validation.ok) process.exit(1);
  }

  // ── plan ──────────────────────────────────────────────────────────────
  async function cmdPlan() {
    const { skillDir, name, setPath } = resolveSkill(pos[0]);
    const { set, validation } = await loadSet(setPath, name);
    if (!validation.ok) die(`invalid set:\n  ${validation.errors.join('\n  ')}`);
    if (!(await fs.exists(`${skillDir}/SKILL.md`))) die(`no SKILL.md in ${skillDir}`);
    const now = Date.now();
    const runId = H.makeRunId(name, now, Math.floor(Math.random() * 65536));
    const list = (v) =>
      v
        ? String(v)
            .split(',')
            .map((s) => s.trim())
            .filter(Boolean)
        : null;
    const repeats = flags.repeats === undefined ? 1 : Number(flags.repeats);
    let plan;
    try {
      plan = H.buildPlan({
        set,
        skill: name,
        runId,
        created: new Date(now).toISOString(),
        root: ROOT,
        privateDir: PRIVATE_ROOT,
        installed: await fs.exists(`/workspace/skills/${name}/SKILL.md`),
        repeats,
        taskIds: list(flags.tasks),
        conditions: list(flags.conditions) ?? H.CONDITIONS,
        model: flags.model ? String(flags.model) : undefined,
        thinking: flags.thinking ? String(flags.thinking) : undefined,
        judgeModel: flags['judge-model'] ? String(flags['judge-model']) : undefined,
        judgeThinking: flags['judge-thinking'] ? String(flags['judge-thinking']) : undefined,
      });
    } catch (e) {
      die(e.message);
    }
    if (/^\/(tmp|shared|workspace)\//.test(`${plan.private_dir}/`))
      die(`--private ${PRIVATE_ROOT} is readable by task agents; keep transcripts elsewhere`);
    // Freeze the set and the skill (without evals/) so later edits cannot change this run.
    const setDir = setPath.slice(0, setPath.lastIndexOf('/'));
    await copyTree(setDir, `${plan.private_dir}/set`, await walk(setDir));
    await copyTree(skillDir, `${plan.private_dir}/skill`, H.stageable(await walk(skillDir)));
    plan.source = { skill_dir: skillDir, set: setPath };
    await writeJson(`${plan.run_dir}/plan.json`, plan);
    await writeJson(`${plan.run_dir}/state.json`, { condition: null });
    if (flags.json) return cli.out(plan);
    console.log(`\n  run ${plan.run_id}: ${plan.runs.length} runs, plan ${plan.run_dir}/plan.json`);
    console.log(`  harness scoop: ${JSON.stringify(plan.harness_scoop)}`);
    for (const a of plan.asks.before) console.log(`  ask before (${a.task_id}): ${a.ask}`);
    for (const a of plan.asks.after) console.log(`  ask after (${a.task_id}): ${a.ask}`);
    for (const c of plan.cone) console.log(`  cone: ${c}`);
    for (const r of plan.runs) console.log(`  ${r.n}. ${r.task_id} ${r.condition} r${r.repeat}`);
  }

  // ── preflight ─────────────────────────────────────────────────────────
  async function cmdPreflight() {
    const id = runIdArg();
    const condition = pos[1];
    if (!H.CONDITIONS.includes(condition))
      die('usage: skill-evals preflight <run-id> <without|with>');
    const plan = await loadPlan(id);
    const native = `/workspace/skills/${plan.skill}`;
    const installed = await fs.exists(`${native}/SKILL.md`);
    const stageRoot = `${plan.run_dir}/.agents`;
    let staged = null;
    if (condition === 'without') {
      if (installed)
        die(
          `${native}/ is installed, and every scoop lists an installed skill. Only the cone can ` +
            `move it out of /workspace/skills for the without runs (and back afterwards).`
        );
      await rmTree(stageRoot);
    } else if (installed) {
      if (await fs.exists(`${native}/evals`))
        die(
          `${native}/evals/ exists: a with agent could read the rubrics. The cone must remove it.`
        );
      staged = `${native}/SKILL.md`;
    } else {
      await rmTree(stageRoot);
      const src = `${plan.private_dir}/skill`;
      await copyTree(src, plan.stage_dir, H.stageable(await walk(src)));
      staged = `${plan.stage_dir}/SKILL.md`;
    }
    // Stale stages of other runs would be listed too.
    const others = [];
    for (const run of await fs.readDir(ROOT))
      if (run !== id && (await fs.exists(`${ROOT}/${run}/.agents/skills/${plan.skill}/SKILL.md`)))
        others.push(`${ROOT}/${run}/.agents/skills/${plan.skill}/`);
    if (others.length)
      die(`other staged copies are visible to agents; run cleanup on them: ${others.join(', ')}`);
    const uuid = crypto.randomUUID();
    const cwd = `${plan.run_dir}/probe`;
    await fs.mkdir(cwd, { recursive: true });
    const schemaB64 = Buffer.from(JSON.stringify(H.probeSchema())).toString('base64');
    const call = await timedAgent(
      H.agentArgv({
        cwd,
        commands: 'echo',
        prompt: H.probePrompt(uuid, plan.skill),
        model: plan.config.judge_model,
        thinking: 'off',
        timeoutSeconds: 180,
        schemaB64,
        transcript: false,
      }),
      cwd
    );
    let probe = null;
    try {
      probe = call.rc === 0 ? JSON.parse(call.stdout.trim()) : null;
    } catch {}
    const v = H.preflightVerdict(condition, probe, staged);
    const out = {
      condition,
      ok: v.ok,
      reason: v.reason,
      at: new Date().toISOString(),
      staged,
      probe,
      probe_rc: call.rc,
      probe_stderr: call.stderr.trim().slice(0, 300),
      ms: call.ms,
      cost: call.delta.cost,
      turns: call.delta.turns,
      block_scalar: probe?.description ? /^[|>][-+0-9]*$/.test(probe.description.trim()) : null,
    };
    await writeJson(`${plan.run_dir}/preflight-${condition}.json`, out);
    await writeJson(`${plan.run_dir}/state.json`, {
      condition: v.ok ? condition : null,
      at: out.at,
    });
    say(
      out,
      `  preflight ${condition}: ${v.ok ? 'ok' : 'FAILED'} (${v.reason}); probe $${out.cost}, ${out.ms} ms`
    );
    if (!v.ok) process.exit(1);
  }

  async function assertCondition(plan, condition) {
    const state = await loadState(plan);
    if (state.condition !== condition)
      die(
        `the current condition is ${state.condition ?? 'none'}; run preflight ${plan.run_id} ${condition} first`
      );
    const stagedNow = await fs.exists(`${plan.stage_dir}/SKILL.md`);
    const installed = await fs.exists(`/workspace/skills/${plan.skill}/SKILL.md`);
    if (condition === 'without' && (stagedNow || installed))
      die('the skill became visible since preflight without; re-run preflight');
    if (condition === 'with' && !stagedNow && !installed)
      die('the staged skill disappeared since preflight with; re-run preflight');
  }

  async function steps(list, cwd) {
    const log = [];
    for (const s of list ?? []) {
      const cmd = s.run ?? s.check;
      if (!cmd) continue;
      const r = await sh(cmd, cwd);
      log.push({
        kind: s.run ? 'run' : 'check',
        cmd,
        rc: r.exitCode,
        stderr: r.stderr.slice(0, 300),
      });
      if (r.exitCode !== 0) return { ok: false, log };
    }
    return { ok: true, log };
  }

  // ── run-one ───────────────────────────────────────────────────────────
  async function cmdRunOne() {
    const id = runIdArg();
    const n = Number(pos[1]);
    const plan = await loadPlan(id);
    const run = plan.runs.find((r) => r.n === n);
    if (!run) die(`no run ${pos[1]} in ${id} (1..${plan.runs.length})`);
    const recPath = `${plan.run_dir}/records/${n}.json`;
    if ((await fs.exists(recPath)) && !flags.force)
      die(`run ${n} is already recorded; pass --force to redo it`);
    await assertCondition(plan, run.condition);
    const setDir = `${plan.private_dir}/set`;
    const set = await readJson(`${setDir}/tasks.json`);
    const task = set.tasks.find((t) => t.id === run.task_id);
    const meta = plan.tasks.find((t) => t.id === run.task_id);
    const priv = `${plan.private_dir}/runs/${n}`;
    const cwd = meta.cwd ?? `${plan.run_dir}/work/${n}/`;
    const uuid = crypto.randomUUID();
    const startedAt = new Date().toISOString();
    // Setup: stage fixtures (never over an existing file), then run/check steps.
    let setupError = null;
    const setupLog = [];
    for (const f of task.slicc?.files ?? []) {
      if (await fs.exists(f.to)) {
        setupError = `${f.to} already exists (a previous run's teardown did not remove it)`;
        break;
      }
    }
    if (!setupError) {
      await fs.mkdir(cwd, { recursive: true });
      for (const f of task.slicc?.files ?? []) {
        await fs.mkdir(f.to.slice(0, f.to.lastIndexOf('/')), { recursive: true });
        await fs.writeFileBinary(f.to, await fs.readFileBinary(`${setDir}/${f.from}`));
      }
      const s = await steps(task.setup, cwd);
      setupLog.push(...s.log);
      if (!s.ok) setupError = 'a setup step failed';
    }
    let call = { rc: null, stdout: '', stderr: '', ms: null, delta: null };
    let transcript = null;
    if (!setupError) {
      const before = await tmpTranscripts();
      call = await timedAgent(
        H.agentArgv({
          cwd,
          prompt: H.taskPrompt(uuid, task),
          model: plan.config.model,
          thinking: plan.config.thinking,
          timeoutSeconds: meta.timeout_seconds,
        }),
        cwd
      );
      const fresh = [...(await tmpTranscripts())].filter((x) => !before.has(x));
      const cands = [];
      for (const name of fresh) cands.push({ name, text: await fs.readFile(`/tmp/${name}`) });
      const hit = H.findTranscript(cands, uuid);
      if (hit) {
        await fs.mkdir(priv, { recursive: true });
        await fs.writeFile(`${priv}/transcript.md`, hit.text);
        await fs.rm(`/tmp/${hit.name}`); // later task agents can read /tmp
        transcript = { ...H.parseTranscript(hit.text), file: hit.name };
      }
    }
    const teardown = await steps(task.teardown, plan.run_dir);
    const record = H.buildRecord({
      plan,
      run,
      uuid,
      rc: call.rc,
      ms: call.ms,
      delta: call.delta,
      transcript,
      startedAt,
      setupError,
    });
    record.teardown_ok = teardown.ok;
    await writeJson(`${priv}/run.json`, {
      uuid,
      cwd,
      setup_error: setupError,
      setup: setupLog,
      teardown: teardown.log,
      rc: call.rc,
      stdout: call.stdout,
      stderr: call.stderr,
      transcript_file: transcript?.file ?? null,
    });
    await writeJson(recPath, record);
    say(
      record,
      `  run ${n} ${run.task_id} ${run.condition} r${run.repeat}: rc=${call.rc} ` +
        `${record.metrics.duration ?? '-'} s $${record.metrics.cost ?? '-'} turns ${record.metrics.turns ?? '-'}` +
        `/${record.metrics.transcript_turns ?? '-'} (${record.attribution})` +
        `${record.error ? ` ERROR ${record.error_stage}: ${setupError ?? record.error}` : ''}` +
        `${teardown.ok ? '' : ' TEARDOWN FAILED'}`
    );
    if (record.error_stage === 'setup' || !teardown.ok) process.exit(1);
  }

  // ── judge ─────────────────────────────────────────────────────────────
  async function cmdJudge() {
    const id = runIdArg();
    const n = Number(pos[1]);
    const plan = await loadPlan(id);
    const recPath = `${plan.run_dir}/records/${n}.json`;
    if (!(await fs.exists(recPath))) die(`run ${n} has no record; run-one it first`);
    let record = await readJson(recPath);
    if (record.error && record.error_stage !== 'judge')
      die(`run ${n} failed at ${record.error_stage}; there is nothing to judge`);
    const priv = `${plan.private_dir}/runs/${n}`;
    if (!(await fs.exists(`${priv}/transcript.md`))) die(`run ${n} has no transcript to judge`);
    const set = await readJson(`${plan.private_dir}/set/tasks.json`);
    const task = set.tasks.find((t) => t.id === record.task_id);
    const runInfo = await readJson(`${priv}/run.json`);
    const prompt = H.judgePrompt({
      task,
      transcript: await fs.readFile(`${priv}/transcript.md`),
      finalAnswer: runInfo.stdout,
    });
    const schemaB64 = Buffer.from(
      JSON.stringify(H.verdictSchema(Object.keys(task.weights)))
    ).toString('base64');
    const cwd = `${plan.run_dir}/judge`;
    await fs.mkdir(cwd, { recursive: true });
    const attempts = [];
    let verdict = null;
    for (let i = 1; i <= 2 && !verdict; i++) {
      const call = await timedAgent(
        H.agentArgv({
          cwd,
          commands: 'echo',
          prompt,
          model: plan.config.judge_model,
          thinking: plan.config.judge_thinking,
          timeoutSeconds: 300,
          schemaB64,
          transcript: false,
        }),
        cwd
      );
      const p =
        call.rc === 0
          ? H.parseVerdict(call.stdout, task.weights)
          : {
              ok: false,
              parse: 'none',
              errors: [`rc ${call.rc}: ${call.stderr.trim().slice(0, 200)}`],
            };
      attempts.push({
        attempt: i,
        rc: call.rc,
        ms: call.ms,
        cost: call.delta.cost,
        turns: call.delta.turns,
        parse: p.parse,
        errors: p.errors ?? [],
      });
      await fs.writeFile(`${priv}/judge-${i}.out`, call.stdout);
      if (p.ok) verdict = p;
    }
    const judgeMeta = {
      model: plan.config.judge_model,
      thinking: plan.config.judge_thinking,
      attempts: attempts.length,
      cost: Math.round(attempts.reduce((a, x) => a + (x.cost ?? 0), 0) * 1e6) / 1e6,
      ms: attempts.reduce((a, x) => a + (x.ms ?? 0), 0),
      parse: verdict?.parse ?? 'none',
    };
    const base = { ...record };
    if (base.error_stage === 'judge') {
      delete base.error;
      delete base.error_stage;
    }
    record = verdict
      ? H.applyVerdict(base, verdict.value, task.weights, judgeMeta)
      : H.judgeFailed(base, judgeMeta);
    await writeJson(`${priv}/judge.json`, {
      attempts,
      findings: verdict?.value?.findings ?? null,
      reward_hacking_suspected: verdict?.value?.reward_hacking_suspected ?? null,
    });
    await writeJson(recPath, record);
    say(
      record,
      verdict
        ? `  judge ${n}: score ${record.score} ${record.outcome} ${JSON.stringify(record.statuses)}; judge $${judgeMeta.cost}`
        : `  judge ${n}: JUDGE ERROR after ${attempts.length} attempts (${attempts.map((a) => a.errors.join('; ')).join(' | ')})`
    );
    if (!verdict) process.exit(1);
  }

  async function loadRecords(plan) {
    const dir = `${plan.run_dir}/records`;
    if (!(await fs.exists(dir))) return [];
    const out = [];
    for (const f of (await fs.readDir(dir)).filter((x) => /^\d+\.json$/.test(x)))
      out.push(await readJson(`${dir}/${f}`));
    return out.sort((a, b) => a.n - b.n);
  }

  // ── status ────────────────────────────────────────────────────────────
  async function cmdStatus() {
    const plan = await loadPlan(runIdArg());
    const recs = new Map((await loadRecords(plan)).map((r) => [r.n, r]));
    const state = await loadState(plan);
    const rows = plan.runs.map((r) => {
      const rec = recs.get(r.n);
      const st = !rec
        ? 'pending'
        : rec.error
          ? `error:${rec.error_stage}`
          : rec.score == null
            ? 'unjudged'
            : `judged ${rec.score}`;
      return { ...r, state: st };
    });
    const next = rows.find(
      (r) => r.state === 'pending' || r.state === 'unjudged' || r.state === 'error:judge'
    );
    const nextCmd = !next
      ? `skill-evals report ${plan.run_id}`
      : next.condition !== state.condition && next.state === 'pending'
        ? `skill-evals preflight ${plan.run_id} ${next.condition}`
        : next.state === 'pending'
          ? `skill-evals run-one ${plan.run_id} ${next.n}`
          : `skill-evals judge ${plan.run_id} ${next.n}`;
    if (flags.json) return cli.out({ condition: state.condition, runs: rows, next: nextCmd });
    console.log(`\n  ${plan.run_id}  condition now: ${state.condition ?? 'none'}`);
    for (const r of rows)
      console.log(`  ${r.n}. ${r.task_id} ${r.condition} r${r.repeat}  ${r.state}`);
    console.log(`  next: ${nextCmd}`);
  }

  // ── report ────────────────────────────────────────────────────────────
  async function cmdReport() {
    const plan = await loadPlan(runIdArg());
    const records = await loadRecords(plan);
    const preflights = [];
    for (const c of plan.conditions) {
      const p = `${plan.run_dir}/preflight-${c}.json`;
      if (await fs.exists(p)) preflights.push(await readJson(p));
    }
    const md = `${plan.private_dir}/skill/SKILL.md`;
    const blockScalar = (await fs.exists(md)) && H.descriptionIsBlockScalar(await fs.readFile(md));
    const report = H.aggregate(plan, records, { preflights, blockScalar });
    await writeJson(`${plan.run_dir}/report.json`, report);
    const text = H.reportMarkdown(report);
    await fs.writeFile(`${plan.run_dir}/report.md`, text);
    if (flags.json) return cli.out(report);
    console.log(text);
    console.log(`  wrote ${plan.run_dir}/report.json and report.md`);
  }

  // ── present ───────────────────────────────────────────────────────────
  async function cmdPresent() {
    const plan = await loadPlan(runIdArg());
    const rp = `${plan.run_dir}/report.json`;
    if (!(await fs.exists(rp))) die(`no report yet; run skill-evals report ${plan.run_id}`);
    const report = await readJson(rp);
    if (flags.dip) {
      const out = `${plan.run_dir}/report.dip.shtml`;
      const html = H.renderDip(report);
      await fs.writeFile(out, html);
      if (flags.print) console.log(html);
      else
        console.log(`  dip written to ${out}; the cone inlines its content as a \`\`\`shtml block`);
    } else if (flags.sprinkle) {
      const dir = '/shared/sprinkles/skill-evals';
      const asset = `${__dirname}/../assets/skill-evals.shtml`;
      if (!(await fs.exists(asset))) die(`missing ${asset}`);
      await fs.mkdir(`${dir}/reports`, { recursive: true });
      await fs.writeFile(`${dir}/skill-evals.shtml`, await fs.readFile(asset));
      await writeJson(`${dir}/reports/${plan.run_id}.json`, report);
      const ip = `${dir}/reports/index.json`;
      const index = (await fs.exists(ip)) ? await readJson(ip) : { runs: [] };
      index.runs = [plan.run_id, ...index.runs.filter((r) => r !== plan.run_id)];
      await writeJson(ip, index);
      console.log(
        `  sprinkle files in ${dir}; the scoop named skill-evals runs: sprinkle open skill-evals (or sprinkle reload skill-evals)`
      );
    } else die('usage: skill-evals present <run-id> --dip [--print] | --sprinkle');
  }

  // ── publish ───────────────────────────────────────────────────────────
  async function cmdPublish() {
    const plan = await loadPlan(runIdArg());
    const repo = typeof flags.hf === 'string' ? flags.hf : 'ai-ecoverse/skill-evals';
    if (!flags.hf) die('usage: skill-evals publish <run-id> --hf [owner/name] [--dry-run]');
    if (!/^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/.test(repo)) die(`not a dataset id: ${repo}`);
    if (repo === 'ai-ecoverse/slicc-bench')
      die('never publish skill evals to ai-ecoverse/slicc-bench');
    if (!(await fs.exists(`${plan.run_dir}/report.json`)))
      die(`no report yet; run skill-evals report ${plan.run_id}`);
    const listing = [];
    for (const rel of await walk(plan.run_dir)) {
      if (rel.startsWith('.agents/')) continue;
      const pick = rel === 'report.json' || rel === 'report.md' || /^records\/\d+\.json$/.test(rel);
      listing.push({ rel, text: pick ? await fs.readFile(`${plan.run_dir}/${rel}`) : null });
    }
    const { files, skipped } = H.publishFiles(plan.run_id, listing);
    if (flags['dry-run']) {
      if (flags.json)
        return cli.out({
          repo,
          files: files.map((f) => ({ path: f.path, bytes: f.content.length })),
          skipped,
        });
      console.log(`\n  dry run: would upload ${files.length} files to datasets/${repo}`);
      for (const f of files) console.log(`  + ${f.path} (${f.content.length} B)`);
      for (const s of skipped) console.log(`  - ${s} (stays local)`);
      return;
    }
    const token = process.env.HF_TOKEN;
    if (!token)
      die(
        'no HF_TOKEN; ask the human for a Hugging Face write token via request_secret (name HF_TOKEN, domain huggingface.co)'
      );
    const auth = { Authorization: `Bearer ${token}` };
    const [org, name] = repo.split('/');
    const create = await fetch('https://huggingface.co/api/repos/create', {
      method: 'POST',
      headers: { ...auth, 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'dataset', name, organization: org, private: false }),
    });
    if (!create.ok && create.status !== 409) die(`creating ${repo} failed: HTTP ${create.status}`);
    const body = H.hubCommitLines(`skill-evals ${plan.run_id}`, files, (s) =>
      Buffer.from(s, 'utf8').toString('base64')
    );
    const commit = await fetch(`https://huggingface.co/api/datasets/${repo}/commit/main`, {
      method: 'POST',
      headers: { ...auth, 'Content-Type': 'application/x-ndjson' },
      body,
    });
    if (!commit.ok)
      die(`upload failed: HTTP ${commit.status} ${(await commit.text()).slice(0, 200)}`);
    console.log(
      `  uploaded ${files.length} files to https://huggingface.co/datasets/${repo}/tree/main/runs/${plan.run_id}`
    );
  }

  // ── cleanup ───────────────────────────────────────────────────────────
  async function cmdCleanup() {
    const plan = await loadPlan(runIdArg());
    await rmTree(`${plan.run_dir}/.agents`);
    await writeJson(`${plan.run_dir}/state.json`, {
      condition: null,
      at: new Date().toISOString(),
    });
    console.log(`  removed ${plan.run_dir}/.agents; no staged copy of ${plan.skill} is left`);
  }

  async function main() {
    if (flags.help || flags.h || !sub || sub === 'help') cli.help(HELP);
    const table = {
      validate: cmdValidate,
      plan: cmdPlan,
      preflight: cmdPreflight,
      'run-one': cmdRunOne,
      judge: cmdJudge,
      status: cmdStatus,
      report: cmdReport,
      present: cmdPresent,
      publish: cmdPublish,
      cleanup: cmdCleanup,
    };
    const fn = table[sub];
    if (!fn) die(`unknown command: ${sub}\nRun 'skill-evals --help' for usage.`);
    try {
      await fn();
    } catch (err) {
      if (err?.name === 'NodeExitError') throw err;
      die(err?.message ?? String(err));
    }
  }
  await main();

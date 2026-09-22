// cua-s1 — form decisions from the cua-s1-forms model.
// elements and commands are offline. plan installs the package, bundles it,
// stages onnxruntime-web, downloads the 3.3 MB graph with hf, then re-execs
// once so require() can see the bundle.

const cli = require('sliccy:cli');
const fs = require('fs');
const exec = require('sliccy:exec');
const host = require('./host.js');
const elements = require('./elements.js');
const commands = require('./commands.js');

const BUNDLE = '/shared/cache/cua-s1/bundle.cjs';
const READY = 'CUA_HOST_READY';
const DEST = '/workspace/models/ai-ecoverse/cua-s1.js';
const PREFIX = 'cua-s1-forms';

const HELP = `
cua-s1 — form decisions from the cua-s1-forms model

USAGE
  cua-s1 elements --snapshot file
  cua-s1 plan [--snapshot file | --elements file] [--document file]
  cua-s1 commands --plan file --tab <id>

  elements              Map a playwright-cli snapshot to Edit / CheckBox / Button JSON
                        --snapshot file|-
  plan                  Score the form. Prints the plan; does not touch the page
                        --snapshot file|-     snapshot text (title + fields)
                        --elements file|-     JSON from \`cua-s1 elements\` instead
                        --document file|-     Label: value lines (default: stdin when piped)
                        --title text          overrides the snapshot's Page Title
                        --min-confidence 0.5  drop weaker decisions (default 0.5)
                        --allow-submit        keep one Submit click (off unless you pass this)
                        --from path           weight directory (default: hf download, 3.3 MB)
                        --json                print the plan as JSON for \`commands\`
  commands              Print playwright-cli lines for the plan's actions
                        --plan file|-
                        --tab <targetId>

Run playwright-cli snapshot first. Selects and radios are left out.
The first plan needs onnxruntime-web, installed with ipk on that first run.
`.trim();

async function loadOrt() {
  const dirs = [
    '/shared/lib/node_modules/onnxruntime-web/dist',
    '/workspace/node_modules/onnxruntime-web/dist',
  ];
  let last;
  for (const dir of dirs) {
    const file = `${dir}/ort.wasm.bundle.min.mjs`;
    if (!(await fs.exists(file))) continue;
    try {
      const loaded = await host.nativeImport(host.previewUrl(file));
      const ort = loaded.InferenceSession ? loaded : loaded.default;
      if (!ort || !ort.InferenceSession) throw new Error('ort bundle has no InferenceSession');
      host.configureOrt(ort, dir);
      return ort;
    } catch (err) {
      if (err && err.name === 'NodeExitError') throw err;
      last = err;
    }
  }
  throw last || new Error('onnxruntime-web wasm bundle is missing. Run ipk add -g onnxruntime-web.');
}

function loadApi() {
  const bundled = require('/shared/cache/cua-s1/bundle.cjs');
  const root = bundled.loadCuaS1 ? bundled : bundled.default || {};
  if (typeof root.loadCuaS1 !== 'function') throw new Error('cua-s1 bundle has no loadCuaS1 export');
  return root;
}

async function readArg(spec) {
  if (spec == null || spec === '-') {
    return process.stdin.read();
  }
  return fs.readFile(host.resolvePath(spec));
}

async function prepareRuntime() {
  const rebuilt = await host.ensureBundle(exec, fs, {
    entry: process.argv[1].replace(/[^/]+$/, 'cua-entry.mjs'),
    outfile: BUNDLE,
    packages: [{ spec: '@ai-ecoverse/cua-s1.js@0.1.1', name: '@ai-ecoverse/cua-s1.js' }],
  });
  const ortReady =
    (await fs.exists('/shared/lib/node_modules/onnxruntime-web/dist/ort.wasm.bundle.min.mjs')) ||
    (await fs.exists('/workspace/node_modules/onnxruntime-web/dist/ort.wasm.bundle.min.mjs'));
  let installedOrt = false;
  if (!ortReady) {
    await host.ensurePackage(exec, fs, 'onnxruntime-web@1.30.0', 'onnxruntime-web');
    installedOrt = true;
  }
  if (rebuilt || installedOrt) {
    if (process.env[READY] === '1') {
      cli.die('installed the cua-s1 bundle but this process cannot require it yet. Run the command again.', {
        prefix: 'cua-s1',
      });
    }
    await host.reexec(exec, READY);
  }
}

async function downloadWeights() {
  const base = `${DEST}/${PREFIX}`;
  const manifestPath = `${base}/manifest.json`;
  if (!(await fs.exists(manifestPath))) {
    await host.hfDownload(exec, 'ai-ecoverse/cua-s1.js', [`${PREFIX}/manifest.json`], DEST);
  }
  const manifest = JSON.parse(await fs.readFile(manifestPath));
  if (!manifest.model) throw new Error('cua-s1 manifest has no model file');
  await host.hfDownload(exec, 'ai-ecoverse/cua-s1.js', [`${PREFIX}/${manifest.model}`], DEST);
  return base;
}

function confidenceOf(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 1) {
    throw new Error('--min-confidence must be between 0 and 1');
  }
  return parsed;
}

async function formFromFlags(flags) {
  if (flags.snapshot && flags.elements) {
    throw new Error('pass --snapshot or --elements, not both');
  }
  if (flags.snapshot) {
    const text = await readArg(flags.snapshot);
    if (text == null) throw new Error('--snapshot is required');
    const form = elements.elementsFromSnapshot(String(text));
    return { title: flags.title || form.title, elements: form.elements };
  }
  if (!flags.elements) throw new Error('pass --snapshot or --elements');
  const parsed = JSON.parse(await readArg(flags.elements));
  return {
    title: flags.title || parsed.title || '',
    elements: parsed.elements || [],
  };
}

async function cmdElements(flags) {
  if (!flags.snapshot) cli.die('--snapshot is required', { prefix: 'cua-s1' });
  const text = await readArg(flags.snapshot);
  if (text == null) cli.die('--snapshot is required', { prefix: 'cua-s1' });
  const form = elements.elementsFromSnapshot(String(text));
  process.stdout.write(`${JSON.stringify(form, null, 2)}\n`);
}

async function cmdPlan(flags) {
  await prepareRuntime();
  const loaded = await formFromFlags(flags);
  if (loaded.elements.length === 0) {
    cli.die('the snapshot has no text fields, checkboxes, or buttons', { prefix: 'cua-s1' });
  }
  const document = await readArg(flags.document);
  if (document == null) cli.die('give the document with --document, or pipe it', { prefix: 'cua-s1' });
  const minConfidence =
    flags['min-confidence'] != null ? confidenceOf(flags['min-confidence']) : 0.5;
  const allowSubmit = flags['allow-submit'] === true;
  const base = flags.from ? host.resolvePath(flags.from) : await downloadWeights();
  console.error(
    `cua-s1: runtime wasm${host.hasWebGpu() ? '' : ' (navigator.gpu is not required)'}`
  );
  const ortLoaded = await loadOrt();
  const url = host.previewUrl(base.endsWith('/') ? base : `${base}/`);
  const api = loadApi();
  const model = await api.loadCuaS1(url, { ort: ortLoaded });
  const entities = api.extractEntities(String(document));
  const result = await model.plan(loaded.title, loaded.elements, entities, {
    minConfidence,
    allowSubmit,
  });
  const plan = {
    title: loaded.title,
    minConfidence,
    allowSubmit,
    entities,
    decisions: (result.decisions || []).map(commands.flattenDecision),
    actions: (result.actions || []).map(commands.flattenDecision),
  };
  process.stdout.write(flags.json ? `${JSON.stringify(plan, null, 2)}\n` : commands.formatPlan(plan));
}

async function cmdCommands(flags) {
  if (!flags.plan) cli.die('--plan is required', { prefix: 'cua-s1' });
  if (!flags.tab) cli.die('--tab is required', { prefix: 'cua-s1' });
  const plan = commands.parsePrintedPlan(String(await readArg(flags.plan)));
  const lines = commands.planToPlaywrightLines(plan, String(flags.tab));
  process.stdout.write(lines.length ? `${lines.join('\n')}\n` : '');
}

async function main() {
  const parsed = host.normalizeFlags(process.argv.parseFlags(), [
    'json',
    'allow-submit',
    'help',
    'h',
  ]);
  const flags = parsed.flags;
  const sub = parsed.subcommand || '';
  if (flags.help || flags.h || !sub || sub === 'help') {
    cli.help(HELP);
    return;
  }
  try {
    if (sub === 'elements') await cmdElements(flags);
    else if (sub === 'plan') await cmdPlan(flags);
    else if (sub === 'commands') await cmdCommands(flags);
    else cli.die(`unknown command: ${sub}\nRun 'cua-s1 --help' for usage.`, { prefix: 'cua-s1' });
  } catch (err) {
    if (err && err.name === 'NodeExitError') throw err;
    cli.die(err.message || String(err), { prefix: 'cua-s1' });
  }
}

await main();

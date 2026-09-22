// kev — typed decisions from a local Kev model.
// First ask installs @ai-ecoverse/kev.js, bundles it with esbuild, stages
// onnxruntime-web, and downloads one q8f32 variant with hf. A bundle written
// in this process is invisible to require(), so that first ask re-execs once.

const cli = require('sliccy:cli');
const fs = require('fs');
const exec = require('sliccy:exec');
const host = require('./host.js');
const questions = require('./questions.js');

const BUNDLE = '/shared/cache/kev/bundle.cjs';
const READY = 'KEV_HOST_READY';
const DEST = '/workspace/models/ai-ecoverse/kev.js';
const MODELS = { '0.8b': 'kev-0.8b', '4b': 'kev-4b', '9b': 'kev-9b' };

const HELP = `
kev — typed decisions from a local Kev model

USAGE
  kev ask [name:type:instruction ...] [options]

  ask                  Score questions against a piece of text
                       "name:noul:Is this about billing?"
                       "name:choice:What tone?::calm|frustrated|angry"
                       "name:score:How urgent?::can wait|this week|today"
                       --state file|-     text to judge (default: stdin when piped)
                       --questions file   System One questions JSON, instead of positionals
                       --model 0.8b|4b|9b default 0.8b (4b is 4.7 GB, 9b is 8.8 GB)
                       --from path        weight directory (default: hf download of q8f32)
                       --date-facts       append day counts between absolute dates
                       --json             print the System One response

A question with spaces in the instruction is one quoted argument.
The first ask downloads the weights (~800 MB for 0.8b q8f32) and needs
onnxruntime-web, installed with ipk on that first run.
Nothing in the answer is free text: each question picks one of the options you gave it.
`.trim();

async function loadOrt(kind) {
  const fileName = kind === 'webgpu' ? 'ort.webgpu.bundle.min.mjs' : 'ort.wasm.bundle.min.mjs';
  const dirs = [
    '/shared/lib/node_modules/onnxruntime-web/dist',
    '/workspace/node_modules/onnxruntime-web/dist',
  ];
  let last;
  for (const dir of dirs) {
    const file = `${dir}/${fileName}`;
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
  throw last || new Error(`onnxruntime-web ${fileName} is missing. Run ipk add -g onnxruntime-web.`);
}

function loadKev() {
  const bundled = require('/shared/cache/kev/bundle.cjs');
  const fn = bundled.loadKev || (bundled.default && bundled.default.loadKev);
  if (typeof fn !== 'function') throw new Error('kev bundle has no loadKev export');
  return fn;
}

async function readArg(spec) {
  if (spec == null || spec === '-') {
    const data = process.stdin.read();
    return data;
  }
  return fs.readFile(host.resolvePath(spec));
}

async function prepareRuntime() {
  const rebuilt = await host.ensureBundle(exec, fs, {
    entry: process.argv[1].replace(/[^/]+$/, 'entry.mjs'),
    outfile: BUNDLE,
    packages: [{ spec: '@ai-ecoverse/kev.js@0.2.0', name: '@ai-ecoverse/kev.js' }],
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
      cli.die('installed the kev bundle but this process cannot require it yet. Run kev ask again.', {
        prefix: 'kev',
      });
    }
    await host.reexec(exec, READY);
  }
}

async function ensureWeights(model, from) {
  if (from) return host.resolvePath(from);
  const prefix = MODELS[model];
  if (!prefix) throw new Error('--model must be 0.8b, 4b, or 9b');
  const base = `${DEST}/${prefix}`;
  const manifestPath = `${base}/manifest.json`;
  if (!(await fs.exists(manifestPath))) {
    await host.hfDownload(exec, 'ai-ecoverse/kev.js', [`${prefix}/manifest.json`], DEST);
  }
  const manifest = JSON.parse(await fs.readFile(manifestPath));
  const variant = manifest.variants && manifest.variants.q8f32;
  if (!variant) throw new Error(`${prefix} manifest has no q8f32 variant`);
  const rels = [
    manifest.files.tokenizer,
    manifest.files.tokenizer_config,
    manifest.files.head,
    variant.model,
    ...(variant.data || []),
  ];
  await host.hfDownload(
    exec,
    'ai-ecoverse/kev.js',
    rels.map((rel) => `${prefix}/${rel}`),
    DEST
  );
  return base;
}

async function openModel(base, dateFacts, providers) {
  const kind = providers[0] === 'webgpu' ? 'webgpu' : 'wasm';
  console.error(`kev: runtime ${kind}${host.hasWebGpu() ? '' : ' (navigator.gpu absent in this worker)'}`);
  const ort = await loadOrt(kind);
  const url = host.previewUrl(base.endsWith('/') ? base : `${base}/`);
  return loadKev()(url, {
    ort,
    variant: 'q8f32',
    executionProviders: providers,
    dateFacts,
  });
}

async function cmdAsk(flags, positionals) {
  if (flags.questions && positionals.length > 0) {
    cli.die('pass questions as --questions or as positionals, not both', { prefix: 'kev' });
  }
  const modelName = flags.model || '0.8b';
  if (!MODELS[modelName]) cli.die('--model must be 0.8b, 4b, or 9b', { prefix: 'kev' });
  await prepareRuntime();
  const parsedQuestions = flags.questions
    ? questions.parseQuestionsJson(await readArg(flags.questions))
    : questions.parseQuestionPositionals(positionals);
  if (Object.keys(parsedQuestions).length === 0) {
    cli.die('give at least one question (see kev ask --help)', { prefix: 'kev' });
  }
  const stateText = await readArg(flags.state);
  if (stateText == null || String(stateText).trim() === '') {
    cli.die('give the text to judge with --state, or pipe it', { prefix: 'kev' });
  }
  const base = await ensureWeights(modelName, flags.from || null);
  const dateFacts = flags['date-facts'] === true;
  const providers = host.hasWebGpu() ? ['webgpu', 'wasm'] : ['wasm'];
  let model;
  try {
    model = await openModel(base, dateFacts, providers);
  } catch (err) {
    if (err && err.name === 'NodeExitError') throw err;
    if (providers[0] !== 'webgpu') throw err;
    console.error(`kev: webgpu failed (${err.message}); retrying on wasm`);
    model = await openModel(base, dateFacts, ['wasm']);
  }
  const response = await model.systemOne(
    { state: questions.parseStateText(String(stateText)), questions: parsedQuestions },
    { dateFacts }
  );
  if (flags.json) {
    process.stdout.write(`${JSON.stringify(response, null, 2)}\n`);
    return;
  }
  process.stdout.write(questions.formatAnswers(response.answers));
}

async function main() {
  const parsed = process.argv.parseFlags();
  const flags = parsed.flags;
  const sub = parsed.subcommand || '';
  if (flags.help || flags.h || !sub || sub === 'help') {
    cli.help(HELP);
    return;
  }
  try {
    if (sub === 'ask') await cmdAsk(flags, parsed.positional.slice(1));
    else cli.die(`unknown command: ${sub}\nRun 'kev --help' for usage.`, { prefix: 'kev' });
  } catch (err) {
    if (err && err.name === 'NodeExitError') throw err;
    cli.die(err.message || String(err), { prefix: 'kev' });
  }
}

await main();

// kev — typed decisions from a local Kev model.
// First ask installs @ai-ecoverse/kev.js, bundles it with esbuild, stages
// onnxruntime-web, and downloads one q8f32 variant with hf. A bundle written
// in this process is invisible to require(), so that first ask re-execs once.

const cli = require('sliccy:cli');
const fs = require('fs');
const exec = require('sliccy:exec');
const host = require('./host.js');
const questions = require('./questions.js');
const runtime = require('./kev-runtime.js');

const READY = 'KEV_HOST_READY';

const HELP = `
kev — typed decisions from a local Kev model

USAGE
  kev ask [name:type:instruction ...] [options]
  kev prepare

  prepare              Install the kev bundle and onnxruntime-web, then exit

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

async function readArg(spec) {
  if (spec == null || spec === '-') {
    const data = process.stdin.read();
    return data;
  }
  return fs.readFile(host.resolvePath(spec));
}

async function prepareRuntime() {
  const rebuilt = await host.ensureBundle(exec, fs, {
    entry: process.argv[1].replace(/[^/]+$/, 'kev-entry.mjs'),
    outfile: runtime.BUNDLE,
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

async function cmdAsk(flags, positionals) {
  if (flags.questions && positionals.length > 0) {
    cli.die('pass questions as --questions or as positionals, not both', { prefix: 'kev' });
  }
  const modelName = flags.model || '0.8b';
  if (!runtime.MODELS[modelName]) cli.die('--model must be 0.8b, 4b, or 9b', { prefix: 'kev' });
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
  const dateFacts = flags['date-facts'] === true;
  const model = await runtime.openModel(fs, exec, {
    model: modelName,
    from: flags.from || null,
    dateFacts,
    log: (line) => console.error(line),
    requireBundle: () => require('/shared/cache/kev/bundle.cjs'),
  });
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
  const parsed = host.normalizeFlags(process.argv.parseFlags(), [
    'json',
    'date-facts',
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
    if (sub === 'ask') await cmdAsk(flags, parsed.positional.slice(1));
    else if (sub === 'prepare') {
      await prepareRuntime();
      console.error('kev: runtime ready');
    }
    else cli.die(`unknown command: ${sub}\nRun 'kev --help' for usage.`, { prefix: 'kev' });
  } catch (err) {
    if (err && err.name === 'NodeExitError') throw err;
    cli.die(err.message || String(err), { prefix: 'kev' });
  }
}

await main();

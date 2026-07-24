// hear-11.jsh — ElevenLabs Scribe (speech-to-text) replacement for `hear`.
// Mirrors the file path of `hear`:  hear-11 [-i file] [-l lang] <file>
//
//   hear-11 <file>                 transcribe an audio/video file
//   hear-11 -i <file> -l en        with a language hint
//   hear-11 <file> --diarize       label speakers
//   hear-11 <file> --json          full JSON (words, timestamps, speakers)
//   hear-11 <file> --words         word-level timestamps (compact)
//
// NOTE: unlike the built-in `hear`, this does NOT capture the microphone —
// ElevenLabs STT works on a file. Record/produce a file first (or use the
// built-in `hear` for live mic input), then transcribe it here.
//
// Single-dash value flags (-i -l -m) are hand-parsed (parseFlags drops them).

const cli = require('sliccy:cli');
const fs  = require('fs');
const L   = require('./elevenlib.jsh');

const HELP = `hear-11 — transcribe audio with ElevenLabs Scribe (file-based)

  hear-11 <file>                 transcribe (prints text)
  hear-11 -i <file>              same (\`hear\`-style flag)
  hear-11 <file> -l <lang>       language hint (ISO 639, e.g. en, de)
  hear-11 <file> --diarize [--num-speakers n]   label speakers
  hear-11 <file> --words         word-level timestamps
  hear-11 <file> --json          full JSON response
  hear-11 <file> -m <model>      model id (default scribe_v1)
  --key <k>   override API key

Does NOT record the mic — give it an audio/video file. For live mic capture
use the built-in \`hear\`, then transcribe the recording here.`;

function parse(argv) {
  const valueFlags = { '-i': 'file', '--file': 'file', '-l': 'lang', '--lang': 'lang',
    '-m': 'model', '--model': 'model', '--num-speakers': 'numSpeakers', '--key': 'key' };
  const boolFlags = { '--diarize': 'diarize', '--words': 'words', '--json': 'json', '-h': 'help', '--help': 'help' };
  const opts = {}; const rest = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (Object.prototype.hasOwnProperty.call(valueFlags, a)) { opts[valueFlags[a]] = argv[++i]; }
    else if (a.startsWith('--') && a.includes('=')) { const [k, ...v] = a.slice(2).split('='); opts[k] = v.join('='); }
    else if (Object.prototype.hasOwnProperty.call(boolFlags, a)) { opts[boolFlags[a]] = true; }
    else rest.push(a);
  }
  return { opts, file: opts.file || rest[0] };
}

async function main() {
  const { opts, file } = parse(process.argv.slice(2));
  if (opts.help) return cli.help(HELP);
  if (!file) return cli.die('no input file.\n\n' + HELP);
  if (!(await fs.exists(file))) return cli.die(`file not found: ${file}`);

  const key = await L.getKey(opts.key);
  const j = await L.stt(key, {
    file, modelId: opts.model, languageCode: opts.lang,
    diarize: Boolean(opts.diarize), numSpeakers: opts.numSpeakers,
  });

  if (opts.json) return cli.out(j);

  if (opts.words) {
    const lines = (j.words || [])
      .filter((w) => w.type === 'word')
      .map((w) => `[${(w.start ?? 0).toFixed(2)}-${(w.end ?? 0).toFixed(2)}]${w.speaker_id ? ' ' + w.speaker_id : ''} ${w.text}`);
    return cli.out(lines.join('\n'));
  }

  if (opts.diarize && (j.words || []).some((w) => w.speaker_id)) {
    // group consecutive words by speaker
    const out = []; let cur = null;
    for (const w of j.words) {
      if (w.type !== 'word' && w.type !== 'spacing') continue;
      const sp = w.speaker_id || 'speaker';
      if (!cur || cur.sp !== sp) { cur = { sp, text: '' }; out.push(cur); }
      cur.text += (w.type === 'spacing' ? ' ' : w.text);
    }
    return cli.out(out.map((s) => `${s.sp}: ${s.text.trim()}`).join('\n'));
  }

  return cli.out(j.text || '');
}

await main().catch((e) => cli.die(e.message + (e.status ? ` (HTTP ${e.status})` : ''), { prefix: 'hear-11' }));

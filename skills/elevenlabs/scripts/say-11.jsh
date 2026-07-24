// say-11.jsh — ElevenLabs-backed replacement for the built-in `say`.
// Mirrors:  say [-v voice] [-r rate] [-l lang] [-o file] [--list] <text>
//
// By default it synthesizes the text and plays it aloud (via afplay). With -o
// it writes the audio to a file instead. -v accepts a voice name (partial,
// case-insensitive) or a raw voice_id. Output is MP3 (ElevenLabs' native
// format) regardless of the -o extension.
//
// Single-dash value flags (-v -r -l -o -m) are hand-parsed here because the
// runtime's parseFlags() treats single-dash flags as booleans and would drop
// their values.

const cli = require('sliccy:cli');
const fmt = require('sliccy:fmt');
const fs  = require('fs');
const L   = require('./elevenlib.jsh');

const HELP = `say-11 — speak text with ElevenLabs (drop-in for \`say\`)

  say-11 [-v voice] [-r rate] [-l lang] [-o file] [-m model] <text>
  say-11 --list | --voices        list available voices
  say-11 --play <text>            (default) speak aloud

  -v  voice name (partial match) or voice_id
  -r  playback rate 0.25–4 (applied on playback via afplay)
  -l  language hint (ElevenLabs multilingual models auto-detect; optional)
  -o  write audio (MP3) to file instead of playing
  -m  model id (default eleven_multilingual_v2)
  --key <k>   override API key

Auth: --key | ELEVENLABS_API_KEY | \`eleven auth <key>\`.`;

// Manual argv parse: value flags take the next token; bare/long flags are bools.
function parse(argv) {
  const valueFlags = { '-v': 'voice', '--voice': 'voice', '-r': 'rate', '--rate': 'rate',
    '-l': 'lang', '--lang': 'lang', '-o': 'out', '--out': 'out', '-m': 'model', '--model': 'model',
    '--key': 'key', '--stability': 'stability', '--similarity': 'similarity', '--style': 'style' };
  const boolFlags = { '--list': 'list', '--voices': 'list', '--play': 'play', '-h': 'help', '--help': 'help' };
  const opts = {}; const rest = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (Object.prototype.hasOwnProperty.call(valueFlags, a)) { opts[valueFlags[a]] = argv[++i]; }
    else if (a.startsWith('--') && a.includes('=')) { const [k, ...v] = a.slice(2).split('='); opts[k] = v.join('='); }
    else if (Object.prototype.hasOwnProperty.call(boolFlags, a)) { opts[boolFlags[a]] = true; }
    else rest.push(a);
  }
  return { opts, text: rest.join(' ') };
}

async function main() {
  const { opts, text } = parse(process.argv.slice(2));
  if (opts.help) return cli.help(HELP);

  const key = await L.getKey(opts.key);

  if (opts.list) {
    const voices = await L.listVoices(key);
    const rows = [['voice_id', 'name', 'category']];
    for (const v of voices) rows.push([v.voice_id, fmt.trunc(v.name || '', 44), `[elevenlabs] ${v.category || ''}`]);
    return cli.out(fmt.table(rows));
  }

  if (!text) return cli.die('no text to speak.\n\n' + HELP);

  const voiceId = await L.resolveVoice(key, opts.voice);
  const cfg = await L.loadConfig();
  const voiceSettings = { ...(cfg.voiceSettings || {}) };
  if (opts.stability != null) voiceSettings.stability = Number(opts.stability);
  if (opts.similarity != null) voiceSettings.similarity_boost = Number(opts.similarity);
  if (opts.style != null) voiceSettings.style = Number(opts.style);
  const buf = await L.tts(key, { text, voiceId, modelId: opts.model || cfg.defaultModel, voiceSettings });

  if (opts.out) {
    await fs.writeFileBinary(opts.out, buf);
    return cli.out(`Wrote ${buf.length} bytes (MP3) to ${opts.out}`);
  }

  const tmp = `/tmp/say-11-${Date.now()}.mp3`;
  await fs.writeFileBinary(tmp, buf);
  const rate = opts.rate != null ? Number(opts.rate) : undefined;
  await L.play(tmp, { rate: Number.isFinite(rate) ? rate : undefined });
  // stay quiet on success, like `say` (no stdout); comment for the agent:
  process.stderr.write(`spoke ${buf.length} bytes via ElevenLabs\n`);
}

await main().catch((e) => cli.die(e.message + (e.status ? ` (HTTP ${e.status})` : ''), { prefix: 'say-11' }));

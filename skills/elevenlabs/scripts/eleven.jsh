// eleven.jsh — raw ElevenLabs API client + convenience subcommands.
//
//   eleven auth <key>                 store API key in skill config
//   eleven auth --show                show masked stored key
//   eleven config                     show effective config (voice/model)
//   eleven config --voice <id|name> --model <id>   set defaults
//   eleven user                       GET /user (needs user_read scope)
//   eleven voices [--search <q>] [--json]
//   eleven models [--json]
//   eleven tts <text> [--voice v] [--model m] [--out f] [--format fmt]
//   eleven stt <file> [--model m] [--lang xx] [--diarize] [--json]
//   eleven api <METHOD> <path> [--data '<json>'] [--query k=v ...] [--raw]
//
// Auth priority: --key | ELEVENLABS_API_KEY | skill config.

const cli = require('sliccy:cli');
const fmt = require('sliccy:fmt');
const fs  = require('fs');
const L   = require('./elevenlib.jsh');

function str(v) { return typeof v === 'string' ? v : undefined; }
const HELP = `eleven — ElevenLabs API

  eleven auth <key> | --show
  eleven config [--voice <id|name>] [--model <id>]
  eleven user
  eleven voices [--search <q>] [--json]
  eleven models [--json]
  eleven tts <text> [--voice v] [--model m] [--out file] [--format fmt] [--play]
  eleven stt <file> [--model m] [--lang xx] [--diarize] [--num-speakers n] [--json]
  eleven api <METHOD> <path> [--data '<json>'] [--query k=v]

Auth: --key <k> | ELEVENLABS_API_KEY | \`eleven auth <key>\` (stored in skill config).`;

async function main() {
  const { positional, flags } = process.argv.parseFlags();
  const [cmd] = positional;

  if (!cmd || flags.help || flags.h) return cli.help(HELP);

  // auth doesn't need an existing key
  if (cmd === 'auth') {
    if (flags.show) {
      const cfg = await L.loadConfig();
      if (!cfg.apiKey) return cli.out('No key stored.');
      const k = cfg.apiKey;
      return cli.out(`Stored key: ${k.slice(0, 6)}…${k.slice(-4)}`);
    }
    const key = str(flags.key) || positional[1];
    if (!key) return cli.die('usage: eleven auth <key>  (or: eleven auth --show)');
    await L.saveConfig({ apiKey: key });
    return cli.out('API key saved to skill config.');
  }

  if (cmd === 'config') {
    const updates = {};
    if (str(flags.voice)) updates.defaultVoice = await L.resolveVoice(await L.getKey(str(flags.key)), str(flags.voice));
    if (str(flags.model)) updates.defaultModel = str(flags.model);
    // Optional per-user voice settings (stored in git-ignored .config, not the skill).
    const cur = await L.loadConfig();
    const vs = { ...(cur.voiceSettings || {}) };
    if (str(flags.stability) != null) vs.stability = Number(flags.stability);
    if (str(flags.similarity) != null) vs.similarity_boost = Number(flags.similarity);
    if (str(flags.style) != null) vs.style = Number(flags.style);
    if (flags['clear-settings']) { updates.voiceSettings = undefined; }
    else if (Object.keys(vs).length && (str(flags.stability) != null || str(flags.similarity) != null || str(flags.style) != null)) {
      updates.voiceSettings = vs;
    }
    if (Object.keys(updates).length) await L.saveConfig(updates);
    const cfg = await L.loadConfig();
    return cli.out({
      defaultVoice: cfg.defaultVoice || L.DEFAULT_VOICE,
      defaultModel: cfg.defaultModel || L.DEFAULT_MODEL,
      voiceSettings: cfg.voiceSettings || null,
      keyStored: Boolean(cfg.apiKey),
    });
  }

  const key = await L.getKey(str(flags.key));

  switch (cmd) {
    case 'user': {
      const j = await L.api(key, 'GET', '/user');
      return cli.out(j);
    }
    case 'voices': {
      let voices = await L.listVoices(key);
      const q = str(flags.search);
      if (q) voices = voices.filter((v) => v.name?.toLowerCase().includes(q.toLowerCase()));
      if (flags.json) return cli.out(voices);
      const rows = [['voice_id', 'name', 'category']];
      for (const v of voices) rows.push([v.voice_id, fmt.trunc(v.name || '', 40), v.category || '']);
      return cli.out(fmt.table(rows));
    }
    case 'models': {
      const j = await L.api(key, 'GET', '/models');
      if (flags.json) return cli.out(j);
      const rows = [['model_id', 'name', 'tts', 'langs']];
      for (const m of j) rows.push([m.model_id, fmt.trunc(m.name || '', 34), m.can_do_text_to_speech ? 'y' : '-', String((m.languages || []).length)]);
      return cli.out(fmt.table(rows));
    }
    case 'tts': {
      const text = positional.slice(1).join(' ') || str(flags.text);
      if (!text) return cli.die('usage: eleven tts <text> [--voice v] [--out file]');
      const voiceId = await L.resolveVoice(key, str(flags.voice));
      const cfg = await L.loadConfig();
      const buf = await L.tts(key, { text, voiceId, modelId: str(flags.model) || cfg.defaultModel, outputFormat: str(flags.format), voiceSettings: cfg.voiceSettings, languageCode: str(flags.lang) || str(flags.l) });
      const out = str(flags.out) || str(flags.o);
      if (out) { await fs.writeFileBinary(out, buf); return cli.out(`Wrote ${buf.length} bytes to ${out}`); }
      // no --out: write temp and (optionally) play
      const tmp = `/tmp/eleven-tts-${Date.now()}.mp3`;
      await fs.writeFileBinary(tmp, buf);
      if (flags.play) { await L.play(tmp); return cli.out(`Played (${buf.length} bytes).`); }
      return cli.out(`Wrote ${buf.length} bytes to ${tmp}  (add --play to hear it, or use say-11)`);
    }
    case 'stt': {
      const file = positional[1] || str(flags.file) || str(flags.i);
      if (!file) return cli.die('usage: eleven stt <file> [--lang xx] [--diarize] [--json]');
      const j = await L.stt(key, {
        file, modelId: str(flags.model),
        languageCode: str(flags.lang) || str(flags.l),
        diarize: Boolean(flags.diarize),
        numSpeakers: str(flags['num-speakers']),
      });
      if (flags.json) return cli.out(j);
      return cli.out(j.text || '');
    }
    case 'api': {
      const method = (positional[1] || 'GET').toUpperCase();
      const path = positional[2];
      if (!path) return cli.die('usage: eleven api <METHOD> <path> [--data \'<json>\'] [--query k=v]');
      let body;
      const data = str(flags.data);
      if (data) { try { body = JSON.parse(data); } catch { body = data; } }
      const query = {};
      if (str(flags.query)) { const [k, ...r] = str(flags.query).split('='); query[k] = r.join('='); }
      const j = await L.api(key, method, path, { body, query });
      // Binary responses (e.g. audio from text-to-speech) come back as raw bytes —
      // write them to a file instead of printing corrupted text.
      if (j && j.__binary) {
        const ext = /mpeg|mp3/.test(j.contentType) ? 'mp3' : /wav/.test(j.contentType) ? 'wav' : /json/.test(j.contentType) ? 'json' : 'bin';
        const out = str(flags.out) || str(flags.o) || `/tmp/eleven-api-${Date.now()}.${ext}`;
        await fs.writeFileBinary(out, j.buffer);
        return cli.out(`Wrote ${j.buffer.length} bytes (${j.contentType}) to ${out}`);
      }
      return cli.out(j);
    }
    default:
      return cli.die(`unknown command: ${cmd}\n\n${HELP}`);
  }
}

await main().catch((e) => cli.die(e.message + (e.status ? ` (HTTP ${e.status})` : ''), { prefix: 'eleven' }));

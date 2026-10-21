import test, { is, ok } from 'tst';
import { runHelp } from './help.js';

const cases = [
  ['scripts/eleven.jsh', ['--help'], 'eleven — ElevenLabs API'],
  ['scripts/eleven.jsh', ['tts', '-h'], 'eleven — ElevenLabs API'],
  [
    'scripts/hear-11.jsh',
    ['--help'],
    'hear-11 — transcribe audio with ElevenLabs Scribe (file-based)',
  ],
  ['scripts/hear-11.jsh', ['-h'], 'hear-11 — transcribe audio with ElevenLabs Scribe (file-based)'],
  ['scripts/say-11.jsh', ['--help'], 'say-11 — speak text with ElevenLabs (drop-in for `say`)'],
  ['scripts/say-11.jsh', ['-h'], 'say-11 — speak text with ElevenLabs (drop-in for `say`)'],
];

for (const [script, words, usage] of cases) {
  test(`${script} ${words.join(' ')} prints usage and exits 0`, async () => {
    const r = await runHelp(script, words);
    is(r.exitCode, 0);
    ok(r.stdout.includes(usage), 'usage on stdout');
    is(r.stderr, '');
  });
}

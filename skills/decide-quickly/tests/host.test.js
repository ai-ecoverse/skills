import test, { is } from 'tst';
import * as hostMod from '../scripts/host.js';

const host = hostMod.default || hostMod;

test('a pinned spec matches only that version', () => {
  is(host.versionOfSpec('@ai-ecoverse/kev.js@0.2.0'), '0.2.0');
  is(host.versionOfSpec('onnxruntime-web@1.30.0'), '1.30.0');
  is(host.versionOfSpec('@ai-ecoverse/kev.js'), null);
  is(host.packageSatisfies('0.2.0', '@ai-ecoverse/kev.js@0.2.0'), true);
  is(host.packageSatisfies('0.1.0', '@ai-ecoverse/kev.js@0.2.0'), false);
  is(host.packageSatisfies('9.9.9', '@ai-ecoverse/kev.js'), true);
});

test('a boolean flag gives a swallowed question back', () => {
  const parsed = host.normalizeFlags(
    {
      flags: { json: 'billing:noul:Is this billing?', 'date-facts': 'true' },
      positional: ['ask'],
    },
    ['json', 'date-facts', 'help', 'h']
  );
  is(parsed.flags.json, true);
  is(parsed.flags['date-facts'], true);
  is(parsed.positional, ['ask', 'billing:noul:Is this billing?']);
});

test('allow-submit does not keep the following path', () => {
  const parsed = host.normalizeFlags(
    {
      flags: { 'allow-submit': '/tmp/form.txt', json: 'false' },
      positional: ['plan'],
    },
    ['json', 'allow-submit', 'help', 'h']
  );
  is(parsed.flags['allow-submit'], true);
  is(parsed.flags.json, false);
  is(parsed.positional, ['plan', '/tmp/form.txt']);
});

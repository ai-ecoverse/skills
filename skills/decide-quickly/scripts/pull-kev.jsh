// Resume a kev weight download through the shell `hf` command.
// Files already at the manifest size are skipped. Short files are fetched again.

const cli = require('sliccy:cli');
const fs = require('fs');
const exec = require('sliccy:exec');
const host = require('./host.js');

const DEST = '/workspace/models/ai-ecoverse/kev.js';
const MODEL = 'kev-9b';
const BATCH = 12;

function say(line) {
  process.stderr.write(`${line}\n`);
}

const manifest = JSON.parse(await fs.readFile(`${DEST}/${MODEL}/manifest.json`));
const variant = manifest.variants && manifest.variants.q8f32;
if (!variant) cli.die('manifest has no q8f32 variant', { prefix: 'pull-kev' });
const sizes = variant.sizes || {};
const rels = [
  manifest.files.tokenizer,
  manifest.files.tokenizer_config,
  manifest.files.head,
  variant.model,
  ...(variant.data || []),
];

let missing = 0;
let short = 0;
for (const rel of rels) {
  const path = `${DEST}/${MODEL}/${rel}`;
  let size = -1;
  try {
    size = (await fs.stat(path)).size;
  } catch {
    missing += 1;
    continue;
  }
  const want = sizes[rel];
  if (typeof want === 'number' && want > 0 && size !== want) {
    short += 1;
    say(`short ${rel} ${size} != ${want}`);
  }
}
say(`pull-kev: ${rels.length} files, ${missing} missing, ${short} short`);

for (let i = 0; i < rels.length; i += BATCH) {
  const batch = rels.slice(i, i + BATCH).map((rel) => `${MODEL}/${rel}`);
  say(`pull-kev: hf ${i + 1}-${i + batch.length} of ${rels.length}`);
  await host.hfDownload(exec, 'ai-ecoverse/kev.js', batch, DEST);
}
say('pull-kev: done');

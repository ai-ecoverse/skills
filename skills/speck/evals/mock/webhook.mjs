#!/usr/bin/env node
// Mock `webhook` CLI. State dir comes from SPECK_MOCK_STATE.
import { readFileSync, writeFileSync, existsSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';

const STATE = process.env.SPECK_MOCK_STATE;
const whFile = join(STATE, 'webhooks.json');
const calls = join(STATE, 'calls.jsonl');
const args = process.argv.slice(2);
const sub = args[0];

const load = () => (existsSync(whFile) ? JSON.parse(readFileSync(whFile, 'utf8')) : []);
const save = (w) => writeFileSync(whFile, JSON.stringify(w, null, 2));
const record = (o) => appendFileSync(calls, JSON.stringify({ cmd: 'webhook', ...o, ts: Date.now() }) + '\n');

if (sub === 'list') {
  const hooks = load();
  record({ sub: 'list', count: hooks.length });
  // Format: "<name>   <url>" per line (matches speck.jsh's list regex).
  console.log(hooks.map((h) => `${h.name}   ${h.url}`).join('\n'));
  process.exit(0);
}

if (sub === 'create') {
  const nameIdx = args.indexOf('--name');
  const scoopIdx = args.indexOf('--scoop');
  const name = nameIdx !== -1 ? args[nameIdx + 1] : 'unnamed';
  const scoop = scoopIdx !== -1 ? args[scoopIdx + 1] : '';
  const hooks = load();
  const url = `https://mock.local/webhook/${name}`;
  if (!hooks.find((h) => h.name === name)) hooks.push({ name, url, scoop });
  save(hooks);
  record({ sub: 'create', name, scoop });
  console.log(`Created webhook '${name}' -> scoop '${scoop}'`);
  console.log(`URL: ${url}`);
  process.exit(0);
}

console.error(`mock webhook: unknown subcommand '${sub}'`);
process.exit(1);

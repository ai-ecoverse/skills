#!/usr/bin/env node
// Mock `scoop` CLI — stands in for scoop_scoop()/feed_scoop() platform calls.
//   scoop create <name> [--writable <path> ...]
//   scoop feed <name> <instructions text>
import { readFileSync, writeFileSync, existsSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';

const STATE = process.env.SPECK_MOCK_STATE;
const scoopsFile = join(STATE, 'scoops.json');
const calls = join(STATE, 'calls.jsonl');
const args = process.argv.slice(2);
const sub = args[0];

const load = () => (existsSync(scoopsFile) ? JSON.parse(readFileSync(scoopsFile, 'utf8')) : {});
const save = (s) => writeFileSync(scoopsFile, JSON.stringify(s, null, 2));
const record = (o) => appendFileSync(calls, JSON.stringify({ cmd: 'scoop', ...o, ts: Date.now() }) + '\n');

if (sub === 'create') {
  const name = args[1];
  const writable = [];
  for (let i = 2; i < args.length; i++) {
    if (args[i] === '--writable' && args[i + 1]) writable.push(args[++i]);
  }
  const scoops = load();
  scoops[name] = { name, writablePaths: writable, instructions: scoops[name]?.instructions || '' };
  save(scoops);
  record({ sub: 'create', name, writablePaths: writable });
  console.log(`scoop '${name}' created (writable: ${writable.join(', ') || 'none'})`);
  process.exit(0);
}

if (sub === 'feed') {
  const name = args[1];
  const instructions = args.slice(2).join(' ');
  const scoops = load();
  scoops[name] = scoops[name] || { name, writablePaths: [], instructions: '' };
  scoops[name].instructions += (scoops[name].instructions ? '\n' : '') + instructions;
  save(scoops);
  record({ sub: 'feed', name, instructions });
  console.log(`fed scoop '${name}' (${instructions.length} chars)`);
  process.exit(0);
}

console.error(`mock scoop: unknown subcommand '${sub}'`);
process.exit(1);

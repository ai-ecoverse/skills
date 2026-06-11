#!/usr/bin/env node
// Mock `chat` CLI — records progress messages the cone sends to the user.
//   chat send <message>
import { appendFileSync } from 'node:fs';
import { join } from 'node:path';

const STATE = process.env.SPECK_MOCK_STATE;
const calls = join(STATE, 'calls.jsonl');
const args = process.argv.slice(2);

if (args[0] === 'send') {
  const msg = args.slice(1).join(' ');
  appendFileSync(calls, JSON.stringify({ cmd: 'chat', sub: 'send', msg, ts: Date.now() }) + '\n');
  console.log(`(chat) ${msg}`);
  process.exit(0);
}

console.error(`mock chat: unknown subcommand '${args[0]}'`);
process.exit(1);

#!/usr/bin/env node
// Mock `sprinkle` CLI — a rail-panel primitive. It "succeeds" so the eval
// fairly tests whether the skill steers the agent AWAY from using it
// (the skill documents that a sprinkle was tried and removed), rather than
// the agent simply being unable to.
//   sprinkle create <name> [...]
import { appendFileSync } from 'node:fs';
import { join } from 'node:path';

const STATE = process.env.SPECK_MOCK_STATE;
const calls = join(STATE, 'calls.jsonl');
const args = process.argv.slice(2);

appendFileSync(calls, JSON.stringify({ cmd: 'sprinkle', args, ts: Date.now() }) + '\n');
console.log(`sprinkle '${args[1] || ''}' created`);
process.exit(0);

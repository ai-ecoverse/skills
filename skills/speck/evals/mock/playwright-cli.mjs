#!/usr/bin/env node
// Mock `playwright-cli`. Simulates eval/goto against a "tab" without a browser.
// Inspects the injected script to classify it (inject / collect / remove) and
// returns the same strings the real speck.jsh expects, tracking per-tab state.
import { readFileSync, writeFileSync, existsSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';

const STATE = process.env.SPECK_MOCK_STATE;
const tabsFile = join(STATE, 'tabs.json');
const calls = join(STATE, 'calls.jsonl');
const args = process.argv.slice(2);
const sub = args[0];

const load = () => (existsSync(tabsFile) ? JSON.parse(readFileSync(tabsFile, 'utf8')) : {});
const save = (t) => writeFileSync(tabsFile, JSON.stringify(t, null, 2));
const record = (o) => appendFileSync(calls, JSON.stringify({ cmd: 'playwright-cli', ...o, ts: Date.now() }) + '\n');

const tabIdx = args.indexOf('--tab');
const tabId = tabIdx !== -1 ? args[tabIdx + 1] : 'unknown';

if (sub === 'goto') {
  const url = args[1];
  const tabs = load();
  // Navigating/reloading drops any injected overlay (mirrors real behavior).
  if (tabs[tabId]) tabs[tabId].injected = false;
  save(tabs);
  record({ sub: 'goto', tabId, url });
  console.log(`navigated tab ${tabId} -> ${url}`);
  process.exit(0);
}

if (sub === 'eval') {
  const script = args[1] || '';
  const tabs = load();
  tabs[tabId] = tabs[tabId] || { injected: false, annotations: [] };

  // Classify by unambiguous markers. Order matters: the inject script DEFINES
  // window.__speckCleanup, so check its return-string first; only the remove
  // script CALLS it / returns 'speck removed'.
  let kind;
  if (script.includes('speck injected (lick-enabled)')) kind = 'inject';
  else if (script.includes('JSON.stringify(window.__speckElementInstructions')) kind = 'collect';
  else if (script.includes('__speckCleanup')) kind = 'remove';
  else kind = 'inject';

  // The inject script embeds `var FILE_PATH="..."`; capture it so we can verify
  // the agent actually passed --file (empty string means a bare inject).
  let filePath = null;
  const m = script.match(/var FILE_PATH=("(?:[^"\\]|\\.)*")/);
  if (m) { try { filePath = JSON.parse(m[1]); } catch {} }

  record({ sub: 'eval', tabId, kind, filePath });

  if (kind === 'remove') {
    if (tabs[tabId].injected) {
      tabs[tabId].injected = false;
      save(tabs);
      console.log('speck removed');
    } else {
      console.log('speck not found on this page');
    }
    process.exit(0);
  }

  if (kind === 'collect') {
    console.log(JSON.stringify(tabs[tabId].annotations || []));
    process.exit(0);
  }

  // inject
  if (tabs[tabId].injected) {
    console.log('already injected');
  } else {
    tabs[tabId].injected = true;
    save(tabs);
    console.log('speck injected (lick-enabled)');
  }
  process.exit(0);
}

console.error(`mock playwright-cli: unknown subcommand '${sub}'`);
process.exit(1);

import fs from 'node:fs';
import path from 'node:path';
import test, { is, ok } from 'tst';

const ROOT = process.cwd();
const SKILL = fs.readFileSync(path.join(ROOT, 'SKILL.md'), 'utf8');
const TOOLS = ['mcp__bb__search', 'mcp__bb__read', 'mcp__bb__run'];
const ALIASES = [
  'host',
  'hosts',
  'machines',
  'env',
  'envs',
  'environments',
  'threads',
  'projects',
  'providers',
];

function frontmatter(text) {
  const match = /^---\n([\s\S]*?)\n---\n/.exec(text);
  if (!match) return null;
  const fields = {};
  let key = null;
  for (const line of match[1].split('\n')) {
    const field = /^([A-Za-z-]+):\s*(.*)$/.exec(line);
    if (field) {
      key = field[1];
      fields[key] = field[2] === '|' || field[2] === '>' ? '' : field[2];
    } else if (key && /^\s+\S/.test(line)) {
      fields[key] = `${fields[key]} ${line.trim()}`.trim();
    }
  }
  return fields;
}

function filesUnder(dir) {
  const out = [];
  for (const name of fs.readdirSync(dir)) {
    const full = path.join(dir, name);
    if (fs.statSync(full).isDirectory()) out.push(...filesUnder(full));
    else out.push(path.relative(ROOT, full));
  }
  return out;
}

function snippets(text) {
  return [...text.matchAll(/```js\n([\s\S]*?)```/g)].map((m) => m[1]);
}

const meta = frontmatter(SKILL);

test('frontmatter names the skill and wires no missing script', () => {
  ok(meta, 'SKILL.md has no frontmatter');
  is(meta.name, 'bb');
  if (meta.script !== undefined)
    ok(fs.existsSync(path.join(ROOT, meta.script)), `script ${meta.script} is missing`);
  if (meta.command !== undefined) ok(meta.script !== undefined, 'command: without script:');
  is(
    filesUnder(ROOT).filter((f) => f.endsWith('.jsh')),
    []
  );
});

test('the description routes on bb and names the MCP server and its tools', () => {
  ok(meta.description.length <= 1024, `description is ${meta.description.length} chars`);
  ok(meta.description.includes('`bb` MCP server'));
  for (const tool of TOOLS) ok(meta.description.includes(tool), `description lacks ${tool}`);
  for (const trigger of ['getbb.app', 'thr_', 'proj_', 'worktree'])
    ok(meta.description.includes(trigger), trigger);
});

test('SKILL.md documents exactly the three bb MCP tools', () => {
  const named = [...new Set(SKILL.match(/mcp__bb__[a-z_]+/g))].sort();
  is(named, [...TOOLS].sort());
  for (const tool of TOOLS) ok(SKILL.includes(`\`${tool}({ `), `${tool} has no call shape`);
});

test('snippets call bb with argv arrays and canonical command names', () => {
  const blocks = snippets(SKILL);
  ok(blocks.length >= 4, `found ${blocks.length} snippets`);
  const calls = blocks.flatMap((b) =>
    [...b.matchAll(/bb\.(json|cli)\(\[\s*'([a-z-]+)'/g)].map((m) => m[2])
  );
  ok(calls.length >= 4, `found ${calls.length} bb calls`);
  is(
    calls.filter((word) => ALIASES.includes(word)),
    []
  );
  ok(
    !/bb\.(json|cli)\(\s*['"`]/.test(blocks.join('\n')),
    'a bb call passes a string instead of argv'
  );
});

test('the 25 s limit, the wait slice and the prompt check stay documented', () => {
  ok(SKILL.includes('25 s'));
  ok(/'thread', 'wait', id, '--timeout', '15s'/.test(SKILL));
  const spawn = snippets(SKILL).find((b) => b.includes("'thread', 'spawn'"));
  ok(spawn, 'no spawn snippet');
  ok(spawn.includes("'--new-environment', 'worktree'"));
  ok(/'--prompt-file', '-'\], \{ stdin: prompt \}/.test(spawn));
  ok(
    snippets(SKILL).some(
      (b) => b.includes("'thread', 'log'") && b.includes('client/turn/requested')
    )
  );
  ok(SKILL.includes('Missing input text'));
  ok(SKILL.includes('--message-file -'));
  ok(/Never delete threads, projects or environments/.test(SKILL));
});

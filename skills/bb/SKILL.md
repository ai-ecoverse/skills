---
name: bb
description: |
  Drive bb, the agentic IDE at getbb.app (get-bb/bb), from SLICC through the
  `bb` MCP server and its three codemode tools: mcp__bb__search,
  mcp__bb__read and mcp__bb__run. Use it whenever the user mentions bb,
  "my bb", getbb.app or `<handle>.getbb.app`, a bb thread id (`thr_…`) or
  project id (`proj_…`). Also use it when they ask to list bb projects or
  threads, spawn a coding agent in a new worktree, pick a provider, model or
  reasoning level, or send a follow-up to a running agent or steer it. It
  also covers waiting for a thread to finish, reading its log or final output,
  finding the worktree a thread works in, and checking that a spawned thread
  received its whole prompt.
allowed-tools: bash
---

# bb: drive bb through its MCP server

bb runs coding agents (threads) in projects (repositories), each on an environment (a checkout or a worktree) on the user's machines. SLICC reaches bb through the MCP server named `bb` in Settings > MCP servers (`/etc/slicc/agent/mcp.json` on SLICC 7). Its address is the remote URL that `bb mcp status` prints on the bb machine, `https://<handle>.getbb.app/mcp`, and bb asks the user to approve access. If the tools are missing, ask the user to add the server. There is no `bb` shell command in SLICC.

| Tool | What it does |
| --- | --- |
| `mcp__bb__search({ query })` | Finds bb CLI commands for a task, with usage, options and a `readOnly` flag |
| `mcp__bb__read({ code })` | Runs a JS snippet that may call only read-only bb commands |
| `mcp__bb__run({ code })` | Runs a snippet that may call any command, including ones that start agents or change settings |

A snippet calls the bb CLI with an argv array, so values need no shell quoting, and `return`s a JSON value:

```js
const projects = await bb.json(['project', 'list']);
return projects.map((p) => ({ id: p.id, name: p.name }));
```

- `bb.json(argv, { stdin })` adds `--json` and throws bb's error message on a non-zero exit. `bb.cli(argv, { stdin })` returns `{ exitCode, stdout, stderr, json }` and never throws on an exit code.
- `read` accepts canonical command names only. Use `machine list`, not `host list`, and `environment`, not `env`. Anything else is refused and has to go through `run`.
- Put several steps in one snippet and return only the fields you need. Unsure of a flag? Call `bb.cli([...path, '--help'])` or use `search`.

## 25 seconds per snippet

A snippet is stopped after 25 s, so wait in short slices and call again:

```js
const w = await bb.cli(['thread', 'wait', id, '--timeout', '15s', '--json']);
return w.exitCode === 0 ? 'idle' : w.exitCode === 2 ? 'still running' : w.stderr;
```

## read versus run

`run` does real work. `thread spawn` and `thread tell` start agent turns that spend the user's provider tokens, and `thread stop` interrupts one. Confirm the target, provider and prompt with the user before such a call, unless they asked for exactly that. Never delete threads, projects or environments, even though `run` would allow it. Leave that to the user.

## Spawn an agent in a worktree

1. With `read`, find the project and a model. Ids come from `project list`, providers from `provider list`, and model ids from `provider models <provider> --project <id>`. Each model lists its `supportedReasoningEfforts`. An example is provider `pi` with model `amazon-bedrock/global.anthropic.claude-opus-5-5`.
2. With `run`, spawn the thread and pass the prompt on stdin:

   ```js
   const t = await bb.json(['thread', 'spawn', '--project', projectId, '--new-environment', 'worktree',
     '--provider', 'pi', '--model', model, '--reasoning-level', 'high', '--title', title,
     '--prompt-file', '-'], { stdin: prompt });
   return t.id;
   ```

3. With `read`, check that the prompt arrived. Its length should match `prompt.length`:

   ```js
   const events = await bb.json(['thread', 'log', id, '--limit', '5']);
   const first = events.find((e) => e.type === 'client/turn/requested');
   return first.data.input.map((i) => (i.text ?? '').length);
   ```

   A thread spawned from SLICC once got an empty first turn and failed with `Missing input text`. The bb CLI accepts `--prompt ""` (exit 0), while `--prompt-file -` refuses empty stdin (measured 2026-11-09, bb 0.49.0). If the length is 0, deliver the prompt with `thread tell <id> --message-file -` and the prompt on stdin.
4. `thread show <id>` returns `{ thread, environment }`. `environment.path` is the worktree on the bb machine, not a path in SLICC's filesystem.

## Follow up

- `thread tell <id> <text>` steers by default and interrupts the current turn. Add `--mode queue` to deliver the message after it instead. Pass long text with `--message-file -` on stdin.
- `thread output <id>` returns the final answer. `thread log <id>` lists the raw events, paged with `--after-seq <seq>`.
- An agent can stall while opening a pull request if `gh` asks for a GitHub device code. Read `thread output`. Once the branch is pushed, open the PR yourself or tell the user.

# intent serve, the eval arms and intent-arm

## intent serve

`intent serve` keeps System 1 loaded and takes requests from `/tmp/intent/q`. An `intent` call finds it by its heartbeat (`/tmp/intent/serve.json`, written every 2 s and trusted for 8 s) and waits for the answer in `/tmp/intent/a`. `--local` makes a call do the work itself.

**This deliberately widens what an intent-only agent can do.** A scoop allowed only `intent` may not run playwright-cli: a scoop's grant also binds the commands an allowed `.jsh` runs. The server runs outside the scoop and drives the browser for it. A request is therefore checked field by field (`scripts/intent.js` `cleanRequest`):

- intent fields only: intent, kind, ref, tab, sure, candidates, dryRun, full, timeout, json, model, or a playwright-cli argv with its intent;
- refs and tabs by pattern, numbers by range, unknown fields refused;
- an argv must start with a playwright-cli command;
- every file it names (`--filename`, `--output`, `--path`, in either `--flag=x` or `--flag x` form, and the files of upload, eval-file, state-save and state-load) must be under `/tmp/`, `/shared/` or `/scoops/`, where a scoop may already go;
- never a shell string or a URL to fetch.

Run a server only while such a scoop works, as the eval arm does. `jshd` units have no browser in slicc, so the server runs in a shell, not as a jshd unit.

## Eval arms (`evals/harness`)

`evals/harness` runs the goals in `goals.json` (a default suite of forms and searches, and browser games) through `tools/harness-evals` with Sonnet 5.5 arms:

- `intent-agent`: a scoop that may run `intent` (not playwright-cli), served by `intent-arm`. It also gets text utilities (grep, sed, bash, …): shell loops and helper scripts that batch intent calls are fair play, while reading or changing a game's code or saved state is not.
- `intent-budget`: the same, with `--retrieve budget` (the top texts by System 1 up to 1,200 characters, in page order).
- `playwright-agent`: the cone with raw playwright-cli, the reference.

The intent arms run side by side, one GPU leader each. `playwright-scoop` (the same scoop with raw playwright-cli) and `intent-lexical` (`--retrieve lexical`: the top texts by words alone) are held.

## intent-arm

`intent-arm` (`scripts/intent-arm.jsh`, so it installs with the skill; a leader gets no `evals/` folder) runs one goal with a Sonnet scoop that browses through one tool, and records:

- the tool calls and the characters each put into context;
- the scoop's tokens and cost (`agent --usage`);
- each intent call's latency, split by phase (snapshot, page evals, screenshot, System 1, action, settling), and outcome.

Its files are in `/tmp/intent-arm/<run>/`: result.json, transcript.md, calls.jsonl, answer.txt, judge.json, the final snapshot and screenshot, and `decisions/` (what System 1 saw and chose on every call, redacted and capped, as training data).

For a benchmark whose tasks name their site in words, `intent-arm` runs without `--url`: no page is open, the scoop opens the site itself, and the run id ends in `-run`.

- `--goal-file PATH` keeps the task off the command line.
- `--private` prints only the run id and the numbers; the files hold task text and page content, and an error goes to `/tmp/intent-arm/last-error.txt`.
- `answer.txt` holds the scoop's last message in full (result.json keeps 500 characters of it).
- `--toolset full` gives the scoop every command the shell lists except `playwright-cli`, `playwright` and `puppeteer`. Their commands go through `intent <command> … --intent "<what and why>"`, and the prompt says so up front.
- Scripts that drive the browser around the tool (`sliccy:browser`, `require('playwright')`) are not blocked but counted in result.json (`bypass`, with `bypassFiles`), as are bare browser commands the grant refused (`barePlaywright`).
- `--thinking <level>` passes the scoop's reasoning level to `agent`.

The BU Bench V2.1 runs in the README used `intent-arm --tool intent --toolset full --retrieve budget` with kev-4b-vision.

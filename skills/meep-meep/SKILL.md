---
name: meep-meep
description: >
  Browser automation one typed action at a time with `webrunner`, a Jev-style
  loop whose only model call is one choice over concrete actions. Use to
  automate a website or carry out a goal in a browser tab: navigate a site,
  search it, fill and submit a form, pick an autocomplete suggestion or a
  date, click through to a result, or run the link, search, and Google
  Flights demos. The local `kev` model (decide-quickly) decides on device for
  free; `--decider agent` asks slicc's `agent` command instead, which also
  handles goals about position such as "the top story". The model never
  writes a selector, a coordinate, or JavaScript: it picks one ref that
  playwright-cli snapshot printed.
allowed-tools: bash
---

# meep-meep

`webrunner` opens a page and repeats: snapshot, decide, act, snapshot again.

```bash
kev pull --model 9b        # once: 8.8 GB of kev-9b weights, with slicc's hf
webrunner run --url https://httpbin.org/forms/post --goal 'Enter "Ada Lovelace" as the customer name, then press Submit order.' --expect-url httpbin.org/post
webrunner demo flights --decider agent --model claude-haiku-4-5 --json
```

It prints the step count, the time, and the final address. `--json` prints `ok`, `reason`, `steps`, `seconds`, `loadSeconds`, `decideSeconds`, and `url`. A failed run exits 1, also with `--json`.

## One step

1. `playwright-cli snapshot` lists the page's fields and clickable controls with their refs.
2. The runner builds one menu: `type "<value>" into <field>`, the 16 best-ranked clicks, and `wait`. Clicks in a search form or dialog, new ones (a suggestion list), and ones sharing words with the goal rank first. The menu never exceeds kev's 255 options.
3. The decider picks one entry. It sees the goal, the actions taken, and the offered controls with their values.
4. The runner clicks the ref. For a type action it then selects the field's text and types keystrokes, which opens suggestion lists that `fill` would not.

## Choosing a decider

| Goal (2026-09-23, two runs each) | kev-9b | agent, Haiku 4.5 | agent + playwright-cli alone, Haiku 4.5 |
| --- | --- | --- | --- |
| Google Flights with dates (9 steps) | 70 s, $0 | 49 s, $0.08 | 193 s, $0.22 |
| httpbin order form (4 steps) | 27 s, $0 | 23 s, $0.03 | 36 s, $0.06 |
| Wikipedia search (2 steps) | 19 s, $0 | 15 s, $0.02 | 50 s, $0.13 |
| Hacker News top story's comments | fails | 26 s, $0.01 | 38 s, $0.18 |

- **`--decider kev`** (default): free, and the page stays on the device. It loads in about 4 s per run, and each step takes 1–6 s. It only types values the goal spells out: each `"quoted string"` and each capitalised name (`Berlin`). Quote dates: `Type "Sep 30" into Departure`. It fails at goals about position, because each control carries only its own label.
- **`--decider agent`**: each step is one `agent` call. The scoop may run no command and must answer with a menu id and, for a type action, the text. `--model` takes any id from `models` (default `claude-haiku-4-5`). A step takes 3–7 s. Its spend shows in `cost`.

## When it stops

- **Passed:** the `--expect` text is on the page and the address contains `--expect-url`. With either flag set, `done` is not offered.
- **Without a check:** `done` passes only when the decider, asked again on a new snapshot, agrees the goal is finished.
- **Stuck:** three actions in a row left the page unchanged, or `--max-steps` (default 8) ran out.

## When a run fails

1. Read `/tmp/meep/webrunner.log` for the chosen actions. The shell shows output only when the command exits, so this log is also how you follow a long run.
2. Open `/tmp/meep/step-<n>.txt` for the first wrong step. It holds the exact state and menu the decider saw.
3. If the right control is not on the menu, name it in the goal with the words its label uses. If kev had no value to type, quote the value.
4. If the menu was right but the choice was wrong, retry with `--decider agent`.
5. Run again. Check that the log now shows the step, and that the `--expect` or `--expect-url` check passes.

## Setup and page quirks

- `--decider kev` needs `kev pull --model 9b` once. If it is interrupted, run it again: `hf` skips finished files. Progress goes to `/tmp/kev/pull.log`. Without the weights, `webrunner` stops before opening a tab and prints this command. `--from <dir>` uses weights you already have. The first kev run installs its runtime (`kev prepare`) and restarts once.
- `--decider agent` needs the provider the `agent` command uses. It downloads nothing.
- A Google consent wall is dismissed with its `Reject all` ref before the loop starts.
- Google Flights opens a date picker instead of searching when no dates are set, so name both dates in the goal.
- On slicc builds before ai-ecoverse/slicc#3417, a ref whose label has extra spaces (`"Where from? "`) has no node. The runner then focuses the control by its trimmed name and types.

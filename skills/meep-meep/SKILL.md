---
name: meep-meep
description: >
  Browser automation one typed action at a time with `webrunner`, an OODA
  loop (observe, orient, decide, act) whose only model call is one choice
  over concrete actions. Use to automate a website or carry out a goal in a
  browser tab: navigate a site, search it, fill and submit a form, pick an
  autocomplete suggestion or a date, scroll to and click through to a
  result, or run the link, search, and Google Flights demos. The local `kev`
  model (decide-quickly) decides on device for free; `--decider agent` asks
  slicc's `agent` command instead; `--decider hybrid` lets kev decide and
  hands the steps it shrugs at to the agent. `webrunner debug` shows every
  step of a run (screenshot, what changed, the menu, the probabilities, the
  commands) to find where a run went wrong. Best on long, many-step goals;
  for goals about position such as "the top story", let an agent drive
  playwright-cli itself. The model never writes a selector, a coordinate,
  or JavaScript: it picks one ref that playwright-cli snapshot printed.
allowed-tools: bash
---

# meep-meep

`webrunner` opens a page and runs an OODA loop until the goal is checked, the run stalls, or the step cap is reached.

```bash
kev pull --model 9b        # once: 8.8 GB of kev-9b weights, with slicc's hf
webrunner run --url https://httpbin.org/forms/post --goal 'Enter "Ada Lovelace" as the customer name, then press Submit order.' --expect-url httpbin.org/post
webrunner demo flights --decider hybrid --json
webrunner debug            # the step-by-step page for the latest run
```

It prints the step count, the time, the final address, and the `webrunner debug <run>` line. `--json` prints `ok`, `reason`, `steps`, `seconds`, `loadSeconds`, `decideSeconds`, `url`, and `run`. A failed run exits 1, also with `--json`.

## One cycle

1. **Observe.** `playwright-cli snapshot --boxes` lists the page's fields and controls with their refs and on-screen boxes. The runner also reads the viewport and takes a screenshot (`--shots off` skips it). This observation is also the feedback on the last action.
2. **Orient.** The runner compares the observation with the last one and builds one menu:
   - Controls outside the viewport are left out, unless the goal names them; `SCROLL_DOWN` and `SCROLL_UP` reach the rest. `--viewport off` offers every control.
   - Each field gets `type "<value>" into <field>`. Clicks are ranked and the best 16 are kept: a click in a search form or dialog, a new one (a suggestion list), or one that shares words with the goal comes first. `wait` is always offered. The menu never exceeds kev's 255 options.
   - The state the decider reads holds the goal, the actions taken, what the last action changed, and the offered controls. A new control is marked `(new)`. A field that no longer shows what was typed into it is listed under `Not as typed`.
3. **Decide.** The decider picks one entry. A Google consent wall, or a menu with nothing but `wait`, is answered without asking it.
4. **Act.** The runner clicks the ref. For a type action it then selects the field's text and types keystrokes, which opens suggestion lists that `fill` would not. A scroll is a mouse wheel over the middle of the viewport.

## Choosing a decider

| Goal (2026-09-23, median of 2–3 runs) | kev-9b | agent, Haiku 4.5 | agent + playwright-cli alone, Haiku 4.5 |
| --- | --- | --- | --- |
| Google Flights with dates (9 steps) | 69 s, $0 | 51 s, $0.08 | 104 s, $0.25 |
| httpbin order form (4 steps) | 27 s, $0 | 24 s, $0.03 | 26 s, $0.04 |
| Wikipedia search (2 steps) | 19 s, $0 | 16 s, $0.02 | 32 s, $0.06 |
| Hacker News top story's comments | fails 2 of 2 | fails 1 of 3 | 22 s, $0.05 |

webrunner pays off on long goals: on Flights it took half the time of an agent driving playwright-cli itself, at a third of the cost. On goals of a few steps, a bare agent is about as fast.

- **`--decider kev`** (default): free, and the page stays on the device. It loads in about 4 to 9 s per run, and each step takes 2 to 6 s, more on a long menu. It only types values the goal spells out: each `"quoted string"` and each capitalised name (`Berlin`). Quote dates: `Type "Sep 30" into Departure`. It fails at goals about position, because each control carries only its own label: every "N comments" link looks the same.
- **`--decider agent`**: each step is one `agent` call. The scoop may run no command and must answer with a menu id and, for a type action, the text. `--model` takes any id from `models` (default `claude-haiku-4-5`). A step takes 3 to 7 s. Its spend shows in `cost`. It sees the same labels as kev, so it can also miss goals about position.
- **`--decider hybrid`**: kev decides each step (System 1). When it shrugs, the agent decides the step (System 2), told kev's top choices. Kev shrugs when it picks `SHRUG`, when it picks a field the goal has no text for, or when its top choice is below `--shrug` (default 0.5) and less than 3 times the runner-up. `--model` picks the kev size and `--agent-model` the agent. Only the steps kev is unsure of cost money.

## When it stops

- **Passed:** every `--expect` text is on the page and the address contains every `--expect-url`. Both flags may repeat. A number at the end of an expected text must not run on, so `Oct 1` does not match `Oct 15`. With either flag set, `done` is not offered.
- **Without a check:** `done` passes only when the next observation confirms the goal is finished. With `hybrid`, an unsure kev verdict goes to the agent.
- **Stuck:** three actions in a row left the page unchanged (a scroll counts as a change), or `--max-steps` (default 8) ran out.

## When a run fails

1. Run `webrunner debug` (or `webrunner debug <run>` from the failure message). It opens a page with one entry per cycle:
   - **Observe:** the screenshot with the offered, chosen, and new controls outlined.
   - **What changed:** the controls that appeared, disappeared, or changed value since the last cycle.
   - **Orient:** the exact state and menu the decider saw, and every control that was left out with the reason.
   - **Decide:** the probabilities of every option, kev's choice when it shrugged, and the agent's prompt and answer.
   - **Act:** every `playwright-cli` command with its output.
2. Find the first wrong step. The page refreshes while a run is in progress. The files are in `/tmp/meep/runs/<run>/`: `trace.jsonl`, and a snapshot and screenshot per step. `/tmp/meep/webrunner.log` has the one-line-per-step log.
3. If the right control is not on the menu, name it in the goal with the words its label uses. If it was left out as off-screen, name it, or check that the menu offered a scroll. If kev had no value to type, quote the value.
4. If the menu was right but the choice was wrong, retry with `--decider hybrid` or `--decider agent`.
5. If the run passed but the page is wrong, the check was too weak: add an `--expect` for each value the goal sets.
6. Run again, and check in `webrunner debug` that the step now goes right.

## Setup and page quirks

- `--decider kev` needs `kev pull --model 9b` once. If it is interrupted, run it again: `hf` skips finished files. Progress goes to `/tmp/kev/pull.log`. Without the weights, `webrunner` stops before opening a tab and prints this command. `--from <dir>` uses weights you already have. The first kev run installs its runtime (`kev prepare`) and restarts once.
- `--decider agent` needs the provider the `agent` command uses. It downloads nothing. `hybrid` needs both.
- A Google consent wall is dismissed with its `Reject all` ref, without asking the decider.
- A Google Flights date typed into Return while the date picker is open is not committed until a date is clicked. The `Not as typed` lines show when the picker moved a date.
- Google Flights opens a date picker instead of searching when no dates are set, so name both dates in the goal.
- On slicc builds before ai-ecoverse/slicc#3417, a ref whose label has extra spaces (`"Where from? "`) has no node. The runner then focuses the control by its trimmed name and types.

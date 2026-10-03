---
name: intent
description: >
  Drive a browser tab one stated intent at a time with `intent`, a
  playwright-cli overlay that returns a small result instead of a page
  snapshot. Each call says what you want in words — open a URL, click the
  Search button, fill the name field with "Ada Lovelace", select "Medium"
  from the size dropdown, check the terms box, press Enter, scroll down,
  close the cookie banner, what is the total price, is the cart empty, wait
  until the results load — and a local decision model (kev) finds the
  control or the text and acts or answers. Use instead of playwright-cli
  snapshots when page context is expensive: filling forms, searching a
  site, reading a value off a page, checking a result, clicking through
  results, playing a browser game step by step. When it is not sure it does
  nothing and lists the candidates with refs, so you can say more or name a
  ref. `--full` prints the snapshot when you really need it.
allowed-tools: bash
---

# intent

`intent` turns one sentence into one browser step and answers in a few lines. You decide what to do next; `intent` only finds the control or the text your sentence means.

```bash
intent prepare                                   # once: the kev runtime
intent pull --model 4b-vision                    # once: 5.4 GB of weights (resumes)
intent --intent "open https://httpbin.org/forms/post"
intent --intent 'fill the customer name with "Ada Lovelace"'
intent --intent "choose the Medium pizza size"
intent --intent "press the Submit order button"
intent --intent "what customer name did the server receive?"
```

A call without `--tab` uses the tab of the last call. Opening a URL without a tab opens one.

## Kinds of intent

The kind is read from the words. `--kind` overrides it.

| Kind | Say | Returns |
| --- | --- | --- |
| NAVIGATE | `open <url>`, `go back`, `reload` | the address, title, and a page gist: headings, fields, buttons with refs |
| ACT | `click …`, `type "x" into …`, `select "x" from …`, `check …`, `press Enter`, `scroll down`, `close the banner` | `✓` what was done and what changed: address, field values, checked states, new controls with refs |
| RETRIEVE | `what is …?`, `read the error message` | the text that answers it (cut around your words), its ref and heading; when no single text is sure, the closest few in page order |
| RETRIEVE (list) | `list the links about drugs`, `list the rows that mention calories`, `list the buttons` | up to 20 matching links, buttons, fields or text rows with refs, in page order; matched by words, no model |
| VERIFY | `is the cart empty?`, `verify the order was placed` | `yes` or `no` with p, and the evidence text |
| WAIT_FOR | `wait until the results load` | when it held (`--timeout S`, default 15) |

Quote text to type and options to select: `type "Sep 30" into Departure`. Unquoted works for the usual phrasings ("fill the name field with Ada Lovelace", "set quantity to 3").

When System 1 is not sure of an ACT, nothing happens. The answer starts with `?` and lists the candidates, each with its ref and probability. Say more (the label or the row: "the comments link of the second story"), or pass `--ref e41` from the list. `--candidates N` lists without acting, and `--dry-run` says which control an ACT would use. A ref from `--full` or a list stays usable after the page re-renders: it is found again by role, label and order.

## Writing intents

An intent that names its control acts at once; a vague one comes back as `?` with candidates, which costs a second call. On the first hosted round, most of the unsure answers were intents like "fill the customer name field" or "click Stop" that the model had right but not surely; naming the label exactly and the row for repeated controls avoids most of them.

- Name the control by the words on it, quoted when it has several: `click "Buy and Eat"`, not "buy the food".
- Say which one when a label repeats: its row or neighbour (`the "BUY" button in the Cocaine row`) or its place (`the first result`, `the top story's comments link`).
- One action per call; text to type in quotes: `type "Ada Lovelace" into the customer name field`.
- On a `?` answer, pass the right ref (`--ref e41`) instead of rewording.
- To find one control among many, `list the links about drugs`; to read several values, `list the rows that mention calories`; for one value, ask a question.
- A ref from an earlier result keeps working after the page changes.

## How it decides

1. **Classify** the intent by its words.
2. **Filter.** Every control (or text segment) on the page is ranked by the intent's words: idf-weighted overlap with labels and row context, a bonus for a whole label, ordinals ("the first", "the top story" pick the 1st of a series like "165 comments", "21 comments", …), and a penalty for header and footer chrome. Typing ranks only fields. Text is cut into segments: the largest row, paragraph or list item under 400 characters, so "Born | April 28, 1906" stays together. Checked, selected and expanded states come from an in-page scan, because the snapshot does not print them (ai-ecoverse/slicc#3766).
3. **Choose.** The top 24 controls (16 texts) go to System 1 as one choice question with a NONE option. A -vision bundle also sees the screenshot, each candidate boxed and labelled with its ref. VERIFY and WAIT_FOR ask a yes/no question over the top 6 segments.
4. **Act or answer** when the top choice reaches the model's threshold (`--sure` overrides it); otherwise return the candidates.

Enter is pressed in the page: slicc's `press Enter` sends no key code, so forms do not submit (ai-ecoverse/slicc#3765).

## System 1

`--model` picks it. The local kev bundles are the default; Clef runs on Cloudflare Workers AI and needs the `CLOUDFLARE_API_TOKEN` secret (domain api.cloudflare.com) and `--cf-account <id>` once (remembered).

Measured 2026-10-02/03 on 400 Mind2Web test_website steps (median 129 controls a page), each with two intents written by Sonnet 5.5: one from a caller that saw the control's label ("informed"), one from a caller that never saw the page ("blind"). RETRIEVE and VERIFY: 88 questions and 86 claims (half false) on 11 live pages. Latency is per System 1 call on this Mac's GPU, shared with other work.

| System 1 (`--model`) | ACT: right control, blind / informed | in top 3 | acts on (wrong actions) | RETRIEVE: right text / in top 3 | VERIFY | s per call |
| --- | --- | --- | --- | --- | --- | --- |
| `4b-vision` (default, 5.4 GB) | 84.9% / 92.3% (184 intents) | 95.1% | 79% (4.3%) at 0.6 | 86.4% / 92.0% | 93.0% | 2.9 |
| `0.8b-vision` (1 GB) | 69.0% / 83.5% | 94.3% | 49% (2.8%) at 0.4 | 63.6% / 76.1% | 77.9% | 0.7 |
| `--from …/kev-0.8b-vision-wr1` (a webrunner fine-tune, not published) | 80.0% / 88.5% | 95.0% | 74.5% (5.0%) at 0.7 | 67.0% / 83.0% | 75.6% | 0.7 |
| `clef` (Workers AI) | 81.5% / 91.5% | 94.3% | 74.5% (3.3%) at 0.7 | 87.5% / 92.0% | 97.7% | 0.7 |

How the stages were chosen:
- **The words alone** rank the right control first for 81% of informed intents but only 54% of blind ones. For blind intents it is in the top 24 95% of the time, so the model gets 24.
- **A 10-wise tournament over every control** (kev-0.6b-browser-use's method) was no better than the shortlist: kev-0.8b scored 65% vs 64%, and Clef 86.7% vs 86.1%. It was 3 to 9 times slower, and Workers AI rejected the largest pages.
- **kev gets webrunner's wording:** the intent as a goal, the shortlist as a Controls list, the options as `click …`/`type into …`. With it, 4b-vision scores 88.6%; with a plain "which control does the intent mean" it scores 83.2%.
- **kev's NONE does not veto:** the best other choice decides.
- **Thresholds per bundle:** each is set where wrong actions stay at or under 5%. 4b-vision was 0.7 until the first hosted smoke round left obvious picks unsure at 0.63–0.69 (2026-10-03). It is now 0.6; the caller sees every result and can recover from a wrong one.

`--from <dir>` loads any kev bundle directory, such as a fine-tune (`--from /mnt/kev-models/kev-0.8b-vision-wr1`). A missing model stops with the command that gets it; nothing falls back to a guess.

Each call loads the model again. For many calls in a row, keep it loaded: run `intent serve` where it may stay, and `intent` hands its requests to it.

## intent serve

`intent serve` keeps System 1 loaded and takes requests from `/tmp/intent/q`. An `intent` call finds it by its heartbeat (`/tmp/intent/serve.json`) and waits for the answer in `/tmp/intent/a`.

**This deliberately widens what an intent-only agent can do.** A scoop allowed only `intent` may not run playwright-cli: a scoop's grant also binds the commands an allowed `.jsh` runs. The server runs outside the scoop and drives the browser for it. A request is therefore intent fields only (intent, kind, ref, tab, sure, candidates, dry-run, full, timeout, json, model). Each field is checked strictly: refs and tabs by pattern, numbers by range, unknown fields refused. A request is never an argv, a URL to fetch, or a shell string. Run a server only while such a scoop works, as the eval arm does.

`jshd` units have no browser in slicc, so the server runs in a shell, not as a jshd unit.

## Evals

`evals/harness` runs the goals in goals.json (the default suite and the games, first written for meep-meep) through tools/harness-evals with Sonnet 5.5 arms:
- `intent-agent`: a scoop that may run `intent` (not playwright-cli), served by `intent-arm`, with RETRIEVE as described above. It also gets text utilities (grep, sed, bash, …): shell loops and helper scripts that batch intent calls are fair play, while reading or changing a game's code or saved state is not;
- `intent-budget`: the same, with `--retrieve budget` (the top texts by System 1 up to 1,200 characters, in page order);
- `intent-lexical`: the same, with `--retrieve lexical` (the top texts by words alone, no model);
- `playwright-agent`: the cone with raw playwright-cli, the reference.

The intent variants run side by side, one GPU leader each. `playwright-scoop` (the same scoop with raw playwright-cli) was the control of the first smoke rounds and is held.

`intent-arm` (scripts/intent-arm.jsh, so it installs with the skill; a leader gets no evals/ folder) records the tool calls, the characters each call put into context, the scoop's tokens and cost (`agent --usage`), and each intent call's latency. Its files are in `/tmp/intent-arm/<run>/`.

The snapshot parser, page scan and kev loader grew out of meep-meep's webrunner and decide-quickly's kev runtime (#423, closed without merging); the copies here are the code.

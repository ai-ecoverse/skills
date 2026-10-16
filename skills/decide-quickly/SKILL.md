---
name: decide-quickly
description: >
  Classify, categorize, label, triage, score, and rate short text such as
  support tickets, emails, chat messages, or page text with the local `kev ask`
  model, and plan how to fill an accessibility-snapshotted web form from an
  intake document with `cua-s1` (fill, check, click, or skip per field). Use
  when classifying or labelling text, triaging a ticket, rating urgency or
  tone, answering a yes or no question about a text, or mapping a document's
  `Label: value` lines onto form fields. Not a general browser automation
  tool: neither command clicks or submits on its own; it prints a judgment or
  playwright-cli lines that the caller reviews and runs.
allowed-tools: bash
---

# decide-quickly

Two commands. `kev` classifies and rates text. `cua-s1` plans a web form fill. Neither one clicks until you run the lines it prints.

## When to use which

- Classify, score, or rate text (billing or not, which tone, how urgent): `kev ask`.
- Fill a web form from a document: snapshot, `cua-s1 plan`, read the plan, then `cua-s1 commands`.

A shell builtin named `kev` or `cua-s1` wins over these scripts. While that builtin exists, run the file:

```bash
node /workspace/skills/decide-quickly/scripts/kev.jsh ask --help
node /workspace/skills/decide-quickly/scripts/cua-s1.jsh --help
```

## Bundle layout

- [scripts/kev.jsh](scripts/kev.jsh) runs `kev`.
- [scripts/cua-s1.jsh](scripts/cua-s1.jsh) runs `cua-s1`.
- [scripts/host.js](scripts/host.js) installs packages, bundles, and downloads weights.
- [scripts/questions.js](scripts/questions.js) parses question shorthand.
- [scripts/elements.js](scripts/elements.js) turns a snapshot into fields.
- [scripts/commands.js](scripts/commands.js) turns a plan into `playwright-cli` lines.
- [scripts/kev-entry.mjs](scripts/kev-entry.mjs) is the esbuild entry for Kev.
- [scripts/cua-entry.mjs](scripts/cua-entry.mjs) is the esbuild entry for cua-s1.
- [references/setup.md](references/setup.md) lists package pins, model sizes, and weight recovery.

## First run

The first `kev ask` or `cua-s1 plan` installs its pinned packages, bundles them with esbuild, downloads weights with `hf download`, and runs again so the bundle can be loaded. Pins, sizes, and stale-weight recovery: [references/setup.md](references/setup.md).

`--json`, `--date-facts`, and `--allow-submit` are booleans. A question or path written after one of them stays an argument.

## kev ask

One forward pass scores every question. The answer is always one of the options you supplied. WebGPU is used when the worker has it. A failed WebGPU session is retried on WASM.

Quote a question that contains spaces.

```bash
computer text | kev ask \
  "billing:noul:Is this about billing?" \
  "tone:choice:What tone?::calm|frustrated|angry" \
  "urgency:score:How urgent?::can wait|this week|today"
```

```bash
kev ask --json --state ticket.txt --questions questions.json
```

`questions.json` maps a name to a question:

```json
{
  "billing": { "type": "noul", "instructions": "Is this about billing?" },
  "tone": { "type": "choice", "instructions": "What tone?", "criteria": { "calm": "polite, no complaint", "angry": "insults or threats" } },
  "urgency": { "type": "score", "instructions": "How urgent?", "criteria": ["can wait", "this week", "today"] }
}
```

Choice `criteria` maps each option to what it means. Score `criteria` lists the options low to high.

Stdout is the name, the answer, and a probability, separated by tabs. For a score question the answer is the most likely option, and the number is a confidence measured around that same option. `--json` prints the System One response. `--date-facts` adds day counts between absolute dates.

`--model 0.8b` (default), `4b`, or `9b` picks the size. Weights land in `/workspace/models/ai-ecoverse/kev.js/kev-<size>`. `--from` uses a directory you already have and skips the download. A long state that fails with a `RangeError` naming a limit means stale weights: see [references/setup.md](references/setup.md).

## cua-s1 plan

The form model runs on WASM. For each field it chooses fill, check, click, or skip. It does not invent text.

```bash
playwright-cli snapshot --tab=E9A3F --filename=/tmp/form.txt
cua-s1 plan --snapshot /tmp/form.txt --document /tmp/intake.txt --json > /tmp/plan.json
```

`elements` lists the Edit, CheckBox, and Button fields. Links, radios, and selects are left out.

```bash
cua-s1 elements --snapshot /tmp/form.txt
```

The document is one `Label: value` pair per line, such as `Tel: (503) 555-0142`. `--title` overrides the page title. `--min-confidence` defaults to 0.5. Weights default to `/workspace/models/ai-ecoverse/cua-s1.js/cua-s1-forms`. `--from` skips the download.

`computer text` can feed `kev`. It cannot feed `cua-s1`. Use `playwright-cli snapshot` for a tab.

## Check the plan, then apply it

Do this before any line from `commands` is run. `--allow-submit` is the only way a click is kept, and it is off unless you pass it.

1. Plan without `--allow-submit`.
2. Read `/tmp/plan.json`. Each fill must name a field from the snapshot and a value from the document. Each check must name a checkbox you meant to tick.
3. If a row is wrong, fix the document line or raise `--min-confidence`. Plan again. Read the new plan. Repeat until the fills and checks match the document.
4. Run `cua-s1 commands --plan /tmp/plan.json --tab E9A3F`. It only prints `playwright-cli fill` and `playwright-cli check`. Run those lines yourself.
5. Snapshot again. If the page does not show what you applied, fix the document and go back to step 1. Old refs are dead after the page changes.
6. Pass `--allow-submit` only after step 5 looks right, and only when a button labelled Submit or Submit Form should be clicked. Plan again, read the plan, then run the printed click. Snapshot once more. If the click did not land, stop and plan again. Do not click twice on a stale ref.

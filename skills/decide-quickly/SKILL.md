---
name: decide-quickly
description: >
  On-device decisions with two shell commands. `kev ask` scores yes/no,
  multiple-choice, and rating questions against a piece of text (is this
  billing, which tone, how urgent). `cua-s1 plan` reads a playwright-cli
  snapshot and a document's Label: value lines and chooses fill, check,
  click, or skip. Use for a typed judgment or a form plan. The cone still
  applies the result. The first run installs the model package, bundles it
  with esbuild, stages onnxruntime-web, and downloads weights with hf.
allowed-tools: bash
---

# decide-quickly — two commands, one install path

Both commands live in this skill. `scripts/kev.jsh` is `kev`. `scripts/cua-s1.jsh` is `cua-s1`. A builtin of the same name wins at dispatch, so while slicc still registers its own `kev` or `cua-s1`, run the script by path:

```bash
node /workspace/skills/decide-quickly/scripts/kev.jsh ask --help
node /workspace/skills/decide-quickly/scripts/cua-s1.jsh --help
```

The first `kev ask` or `cua-s1 plan` installs what that command needs, then runs itself again so `require()` can see the bundle it just wrote.

- `ipk add -g @ai-ecoverse/kev.js@0.2.0` or `@ai-ecoverse/cua-s1.js@0.1.1`
- `ipk add -g esbuild-wasm` at the version the `esbuild` command asks for, then `esbuild --bundle`
- `ipk add -g onnxruntime-web@1.30.0`
- `hf download` of the weights (kev q8f32, or the 3.3 MB cua-s1 graph)

An already installed package is reused only when `package.json` `version` matches that pin. A different version is installed again.

`--json`, `--date-facts`, and `--allow-submit` are booleans. A question or path written after one of them stays an argument.

## kev ask

One forward pass scores every question. An answer is always one of the options you supplied. WebGPU is used when this worker has `navigator.gpu`. A failed WebGPU session is retried on WASM.

A question with spaces in the instruction is one quoted argument.

```bash
computer text | kev ask \
  "billing:noul:Is this about billing?" \
  "tone:choice:What tone?::calm|frustrated|angry" \
  "urgency:score:How urgent?::can wait|this week|today"
```

```bash
kev ask --json --state ticket.txt --questions questions.json
```

`questions.json` is a System One map: `{ "billing": { "type": "noul", "instructions": "..." } }`. Choice `criteria` is an object. Score `criteria` is an array of strings, low to high.

Stdout is `name`, the answer, and a probability, tab-separated. `--json` prints the System One response. `--date-facts` appends day counts between absolute dates in the state.

| Model | Variant | Approx size |
| --- | --- | --- |
| `--model 0.8b` (default) | q8f32 | 800 MB |
| `--model 4b` | q8f32 | 4.7 GB |
| `--model 9b` | q8f32 | 8.8 GB |

Weights land in `/workspace/models/ai-ecoverse/kev.js/kev-<size>`. `--from` points at a directory you already have and skips `hf`.

Kev does not click. Apply the judgment yourself.

## cua-s1 plan

The form model has 706k parameters and a 3.3 MB graph. It runs on WASM. For each field it picks fill, check, click, or skip. It does not type new text, and it does not submit unless you pass `--allow-submit`.

```bash
playwright-cli snapshot --tab=E9A3F --filename=/tmp/form.txt
cua-s1 plan --snapshot /tmp/form.txt --document /tmp/intake.txt --json > /tmp/plan.json
cua-s1 commands --plan /tmp/plan.json --tab E9A3F
```

Read the plan before you run the lines. `commands` prints `playwright-cli fill`, `check`, and `click`. It does not run them. Refs die when the page changes.

`elements` turns the snapshot into the Edit, CheckBox, and Button list. Links, radios, and selects are left out.

```bash
cua-s1 elements --snapshot /tmp/form.txt
```

Decisions under `--min-confidence` (default 0.5) are dropped. A click survives only with `--allow-submit`, and only on a button labelled exactly Submit or Submit Form.

The document is one `Label: value` pair per line (`Tel: (503) 555-0142`). `--title` overrides the snapshot's Page Title. Weights default to `/workspace/models/ai-ecoverse/cua-s1.js/cua-s1-forms`. `--from` skips the download.

`computer text` can feed `kev`. It does not feed `cua-s1` a field list. Use `playwright-cli snapshot` for a tab.

## Offline pieces

Question shorthand is `scripts/questions.js`. Snapshot parsing is `scripts/elements.js`. The playwright lines are `scripts/commands.js`. The install, bundle, and weight helper is `scripts/host.js`, shared by both commands. `tests/*.test.js` covers the parsers, the version pin, and boolean-flag recovery.

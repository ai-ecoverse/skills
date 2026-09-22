---
name: cua-s1
description: >
  Fill a form from a document using the on-device cua-s1-forms model.
  Snapshot with playwright-cli, plan with `cua-s1`, then apply the printed
  playwright-cli lines. The model chooses fill, check, click, or skip. It
  does not type new text and it does not submit unless you allow it. The
  first plan installs @ai-ecoverse/cua-s1.js, bundles it with esbuild, stages
  onnxruntime-web, and downloads the 3.3 MB graph with hf.
allowed-tools: bash
---

# cua-s1 — form decisions

`cua-s1` runs Cua's form model (706k parameters, a 3.3 MB graph) on the CPU. For each field it reads the field and the document's `Label: value` lines and picks one action: fill from one of those values, tick, click, or leave it alone.

The command is `scripts/cua-s1.jsh`. Once the shell has no builtin of the same name, that file is the `cua-s1` command. A builtin wins at dispatch, so while slicc still registers its own `cua-s1`, run the script by path:

```bash
node /workspace/skills/cua-s1/scripts/cua-s1.jsh --help
```

`elements` and `commands` are offline. The first `plan` installs what the forward pass needs:

- `ipk add -g @ai-ecoverse/cua-s1.js@0.1.1`
- `ipk add -g esbuild-wasm` and `esbuild --bundle` into `/shared/cache/cua-s1/bundle.cjs`
- `ipk add -g onnxruntime-web@1.30.0`
- `hf download` of `manifest.json` and the ONNX graph (about 3.3 MB)

That first process then runs the command again so `require()` can see the bundle.

## Look, plan, then apply

```bash
playwright-cli snapshot --tab=E9A3F --filename=/tmp/form.txt
cua-s1 plan --snapshot /tmp/form.txt --document /tmp/intake.txt --json > /tmp/plan.json
cua-s1 commands --plan /tmp/plan.json --tab E9A3F
```

Read the plan before you run the lines. `commands` prints `playwright-cli fill`, `check`, and `click`. It does not run them. After they run, snapshot again. Refs die when the page changes.

`elements` turns the snapshot into the Edit, CheckBox, and Button list. Links, radios, and selects are left out. That is the set the model was trained on.

```bash
cua-s1 elements --snapshot /tmp/form.txt
```

## Confidence and submit

Decisions under `--min-confidence` (default 0.5) are dropped. A click survives only when you pass `--allow-submit`, and only on a button labelled exactly Submit or Submit Form. Leave that flag off until the plan's fills look right.

The document is one `Label: value` pair per line (`Tel: (503) 555-0142`). Other lines are ignored. `--title` overrides the snapshot's Page Title.

A screen with no accessibility tree is not this command's input. Use `playwright-cli snapshot` for a tab. `computer text` can feed `kev` a judgment. It does not feed cua-s1 a field list.

Weights default to `/workspace/models/ai-ecoverse/cua-s1.js/cua-s1-forms`. `--from` points at a directory from `hf download` and skips the download.

The graph runs on WASM. `navigator.gpu` is not required.

## Offline pieces

Snapshot parsing lives in `scripts/elements.js`. Plan printing and the playwright lines live in `scripts/commands.js`. `skills/cua-s1/tests/offline.test.js` covers both.

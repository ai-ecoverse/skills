---
name: kev
description: >
  Score yes/no, multiple-choice, and rating questions against a piece of text
  with the on-device Kev model (`kev ask`). Use when a judgment is typed and
  small: is this billing, which tone, how urgent. The cone still decides what
  to do with the probabilities. The first ask installs @ai-ecoverse/kev.js,
  bundles it with esbuild, stages onnxruntime-web, and downloads the q8f32
  weights with hf.
allowed-tools: bash
---

# kev — typed decisions, no free text

`kev` runs a Kev decision model in the browser (WebGPU when this worker has `navigator.gpu`, WASM otherwise). One forward pass scores every question. An answer is always one of the options you supplied.

The command is `scripts/kev.jsh`. Once the shell has no builtin of the same name, that file is the `kev` command. A builtin wins at dispatch, so while slicc still registers its own `kev`, run the script by path:

```bash
node /workspace/skills/kev/scripts/kev.jsh ask --help
```

The first `ask` does the install itself:

- `ipk add -g @ai-ecoverse/kev.js@0.2.0` (pulls `@huggingface/tokenizers`)
- `ipk add -g esbuild-wasm` and `esbuild --bundle` into `/shared/cache/kev/bundle.cjs`
- `ipk add -g onnxruntime-web@1.30.0`
- `hf download` of the q8f32 files for the chosen size

That first process then runs the command again so `require()` can see the bundle. Later asks reuse the bundle and skip weights that are already on disk.

## Ask

Pipe the text, or pass `--state`. A question with spaces in the instruction is one quoted argument.

```bash
computer text | kev ask \
  "billing:noul:Is this about billing?" \
  "tone:choice:What tone?::calm|frustrated|angry" \
  "urgency:score:How urgent?::can wait|this week|today"
```

```bash
kev ask --state ticket.txt --questions questions.json --json
```

`questions.json` is a System One map: `{ "billing": { "type": "noul", "instructions": "..." } }`. Choice `criteria` is an object. Score `criteria` is an array of strings, low to high.

Stdout is `name`, the answer, and a probability, tab-separated. `--json` prints the System One response (`answers`, `latency_ms`). `--date-facts` appends day counts between absolute dates in the state.

A page the agent can already see is fair state: `playwright-cli snapshot` text, `computer text`, or a file. Kev does not click. Apply the judgment yourself.

## Weights and the runtime

| Model | Files | Approx size |
| --- | --- | --- |
| `--model 0.8b` (default) | q8f32 only | 800 MB |
| `--model 4b` | q8f32 only | 4.7 GB |
| `--model 9b` | q8f32 only | 8.8 GB |

Weights land in `/workspace/models/ai-ecoverse/kev.js/kev-<size>`. `--from` points at a directory you already downloaded and skips `hf`.

stderr prints `runtime webgpu` or `runtime wasm`. WASM is the path when this worker has no `navigator.gpu`. A WebGPU session that fails is retried on WASM.

## Offline pieces

Question shorthand, JSON questions, state parsing, and answer formatting live in `scripts/questions.js` and do not load the model. `skills/kev/tests/questions.test.js` covers them.

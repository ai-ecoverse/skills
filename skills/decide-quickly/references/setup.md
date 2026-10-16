# decide-quickly setup

## What the first run installs

The first `kev ask` or `cua-s1 plan` installs its packages, bundles them, downloads weights, and runs again so the bundle can be loaded.

- Kev: `ipk add -g @ai-ecoverse/kev.js@0.6.0`
- cua-s1: `ipk add -g @ai-ecoverse/cua-s1.js@0.1.1`
- Both: `esbuild-wasm`, then `esbuild --bundle`, then `ipk add -g onnxruntime-web@1.30.0`
- Weights: `hf download` (Kev q8f32, or the 3.3 MB cua-s1 graph). The download flag is read from `hf download --help`: `--to` for SLICC's builtin `hf`, `--local-dir` for huggingface_hub's.

A package already on disk is reused only when its version matches that pin.

## Kev model sizes

| Model | Variant | Approx size |
| --- | --- | --- |
| `--model 0.8b` (default) | q8f32 | 800 MB |
| `--model 4b` | q8f32 | 4.7 GB |
| `--model 9b` | q8f32 | 8.8 GB |

Weights land in `/workspace/models/ai-ecoverse/kev.js/kev-<size>`. `--from` uses a directory you already have and skips the download.

## Long states and stale weights

Kev reads up to 65,536 tokens of state and truncates the rest. `kev ask` never re-downloads a `manifest.json` it already has. Weights fetched before the kev.js 0.6.0 bundles were published cover only 8,192 positions, so a long state fails with a `RangeError` that names the limit. Delete that `kev-<size>` directory to fetch the current bundle.

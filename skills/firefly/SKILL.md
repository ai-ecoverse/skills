---
name: firefly
description: |
  Generate images from text prompts using the Adobe Firefly Services API.
  Use when the user wants to generate an image with Adobe Firefly, do text-to-image
  with Firefly, "create an image with Firefly", "generate an image of...",
  "make a picture of...", "firefly generate", or any Adobe image generation /
  Firefly image request. Triggers on phrases like "Adobe Firefly", "generate image",
  "text to image", "create an image", "firefly generate", "Adobe image generation",
  "make an AI image", "render an image from this prompt", and requests to produce
  photorealistic or artistic images via Adobe's generative image API. Supports
  multiple variations, custom sizes, seeds, content class (photo/art), negative
  prompts, model selection (Firefly Image 3 / Image 4 / Image 4 Ultra / custom
  trained models), and downloading the generated PNGs locally.
allowed-tools: bash
---

# firefly — Adobe Firefly Services image generation

Generate images from text prompts via the Adobe Firefly Services API
(`v3/images/generate-async`). Generation is asynchronous: the CLI submits a job,
polls the returned status URL, then prints the output image URLs (and can download
the PNGs).

## One-time setup

Firefly uses **Adobe IMS server-to-server** auth (`client_credentials`). You need
an IMS client id + client secret provisioned for Firefly Services. Store them once:

```bash
firefly login --client-id <IMS_CLIENT_ID> --client-secret <IMS_CLIENT_SECRET> --org-id <ORG_ID>
```

Or load them from a JSON file (`{client_id, client_secret, org_id?, scopes?}`):

```bash
firefly login --from /workspace/firefly-creds.json
```

`login` verifies the credentials by exchanging an IMS token immediately. The
credentials and the cached bearer token are stored in the skill config; the token
lives ~24h and is refreshed automatically. The secret and token are never printed.

## Commands

### `firefly generate <prompt>`

| Flag | Description |
|------|-------------|
| `--size <WxH>` | Image size, e.g. `1024x1024` (default). Accepts `1024x1024` or `1024*1024`. |
| `--n <1..4>` | Number of variations (default 1, clamped to 1–4). |
| `--seed <int>` | Seed — repeatable, one per variation (`--seed 123 --seed 456`). |
| `--content-class <c>` | `photo` or `art`. |
| `--negative <text>` | Negative prompt. |
| `--model <v>` | Model: `image3`, `image4_standard`, `image4_ultra`, or `image4_custom`. Omit for the server default (`image4_standard`). |
| `--custom-model <assetId>` | Custom model assetId (from `firefly models`). Implies `--model image4_custom`. |
| `--download [dir]` | Download outputs to `dir` (default `/workspace`) as `firefly-<jobid>-<i>.png`. |
| `--json` | Output the raw job result and exit. |

Common sizes: `1024x1024`, `2048x2048`, `1792x1024`, `1024x1792`, `1344x768`, `768x1344`.

```bash
firefly generate "a red panda astronaut floating in space, photorealistic" --size 1024x1024 --n 1
firefly generate "neon city skyline at night" --n 2 --content-class art --download /shared
firefly generate "a tiny robot watering a plant, isometric" --model image4_ultra --download /shared
firefly generate "portrait in my brand style" --custom-model <assetId> --download /shared
firefly generate "a calm forest" --json | jq -r '.result.outputs[0].image.url'
```

### `firefly models`

List the org's trained **custom models** (used with `--custom-model`). Each entry
shows the display name, its `id:<assetId>` (pass that to `--custom-model`), the
training mode (`style`/`subject`), and published state.

```bash
firefly models
firefly models --json | jq -r '.customModels[].assetId'
```

### `firefly status <statusUrl>`

Poll an existing job by its **full status URL** (the one `generate` printed/returned).
The status host is region-specific and cannot be reconstructed from a bare job id,
so pass the whole URL.

```bash
firefly status "https://firefly-epo853211.adobe.io/v3/status/urn:ff:jobs:..." --download /shared
```

## Models

Model selection is done via the **`x-model-version` request header** (not a body
field — body model fields are silently ignored). Valid values:

| Value | Model |
|-------|-------|
| `image3` | Firefly Image 3 |
| `image4_standard` | Firefly Image 4 (server default — same as omitting `--model`) |
| `image4_ultra` | Firefly Image 4 Ultra |
| `image4_custom` | A custom trained model — **requires** `--custom-model <assetId>` |

For `image4_custom`, list the org's trained models with `firefly models` and pass
one of the returned ids via `--custom-model <assetId>` (which auto-sets
`--model image4_custom`).

**Partner models are NOT available through this API.** Runway, Luma, OpenAI
(gpt-image), Google (Imagen/Veo), etc. live in the Firefly app / Creative
Production layer, not the Firefly Services generate API — any other model value
returns HTTP 404. Only the four values above are accepted.

## Notes

- **Auth:** Adobe IMS server-to-server (`client_credentials`); access token ~24h,
  cached in skill config and auto-refreshed.
- **Expiring URLs:** output image URLs are pre-signed S3 links that expire in
  **~1 hour** — pass `--download` to keep the PNGs.
- Every command supports `--json` for the raw API response and exits non-zero on
  failure.

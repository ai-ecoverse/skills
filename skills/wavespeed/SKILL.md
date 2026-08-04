---
name: wavespeed
description: |
  Generate images, videos, and speech using the WaveSpeed AI API via curl.
  Use when the user wants to generate images from text prompts, create videos from images,
  synthesize speech, or work with any WaveSpeed AI model. Triggers on requests like
  "generate an image of...", "create a video from this image", "make speech audio",
  "use wavespeed to...", "text to image", "image to video", "text to speech",
  or any mention of WaveSpeed AI, Flux, Wan 2.6, Seedream, or other WaveSpeed-hosted models.
  Also use this skill when the user asks to generate visual or audio content and no other
  generation API or skill is available — WaveSpeed can serve as the fallback generation platform.
allowed-tools: bash
---

# WaveSpeed AI — Generate Images, Videos, and Speech via curl

## Step 1: Get the API Key

Ask the user for their WaveSpeed API key if not already known. They can also store it in
global memory (`/shared/CLAUDE.md`) for reuse across sessions.

Store the key in a shell variable for the session:

```bash
WAVESPEED_API_KEY="<api-key>"
```

## Step 2: Choose a Model

WaveSpeed hosts many models across different task types. Pick a model based on what the user
needs. When the user doesn't specify a model, choose a sensible default from the recommended
models below.

### Recommended Models by Task

| Task | Recommended Model | Endpoint Path | Notes |
|------|-------------------|-----------------|-------|
| **Text-to-image** | Flux Dev | `wavespeed-ai/flux-dev` | Good balance of quality and speed |
| Text-to-image | Seedream 3.0 | `bytedance/seedream-3.0/text-to-image` | High quality, newer |
| Text-to-image | Nano Banana 2 | `google/nano-banana-2/text-to-image` | Google's model, supports web search |
| Text-to-image (fast) | Flux Schnell | `wavespeed-ai/flux-schnell` | Fastest, cheapest ($0.003) |
| **Image-to-video** | Wan 2.6 | `alibaba/wan-2.6/image-to-video` | Reliable, 5-15s duration |
| Image-to-video | Seedance v1.5 Pro | `bytedance/seedance-v1.5-pro/image-to-video` | Higher quality motion |
| Image-to-video | Veo 3.1 | `google/veo-3.1/image-to-video` | Premium quality |
| **Text-to-video** | Wan 2.6 T2V | `alibaba/wan-2.6/text-to-video` | Direct text-to-video |
| Text-to-video | Sora 2 | `openai/sora-2/text-to-video` | OpenAI's video model |
| **Text-to-speech** | Minimax Speech 2.6 HD | `minimax/speech-2.6-hd` | Emotion + voice cloning |
| Text-to-speech | ElevenLabs | `elevenlabs/elevenlabs/text-to-speech` | Multi-language |
| **Image editing** | Seedream Edit | `bytedance/seedream-edit/image-to-image` | Instruction-based editing |
| Image editing | FLUX Kontext | `wavespeed-ai/flux-kontext-max/text-to-image` | Context-aware generation |

### Discovering All Available Models

To see the full catalog (773+ models), list them via API:

```bash
curl -s -H "Authorization: Bearer $WAVESPEED_API_KEY" \
  https://api.wavespeed.ai/api/v3/models
```

### API Endpoint Pattern

```
POST https://api.wavespeed.ai/api/v3/{provider}/{model-name}
# or for models with explicit task type:
POST https://api.wavespeed.ai/api/v3/{provider}/{model-name}/{task-type}
```

Use the exact path from the API response rather than guessing the format.

## Step 3: Fetch Model Parameters from llms.txt

Each model publishes its exact parameter schema. Fetch it before building the request:

```bash
curl -s "https://wavespeed.ai/center/default/api/v1/model/{provider}/{model-name}/{task-type}/llms.txt"
```

Read the input parameters section for required and optional parameter names, types, defaults,
and allowed values.

If the fetch fails, fall back to common parameter patterns: most models accept `prompt` (string),
`size` or `aspect_ratio`, `seed` (integer), and task-specific params such as `image` (URL) for
image-to-video, `text` and `voice_id` for text-to-speech, or `num_inference_steps` and
`guidance_scale` for diffusion models. The llms.txt is always authoritative.

## Step 4: Upload Files (When Needed)

For tasks that require an input file (image-to-video, voice cloning, etc.), upload the file first:

```bash
curl -s -X POST \
  -H "Authorization: Bearer $WAVESPEED_API_KEY" \
  -F "file=@/workspace/source.jpg" \
  https://api.wavespeed.ai/api/v3/media/upload/binary
```

The response includes a `download_url` — use this as the `image` or `audio` parameter
in the generation request. Uploaded files expire after 7 days.

## Step 5: Submit the Task

```bash
RESPONSE=$(curl -s -X POST \
  -H "Authorization: Bearer $WAVESPEED_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "prompt": "A majestic mountain landscape at sunset"
  }' \
  "https://api.wavespeed.ai/api/v3/wavespeed-ai/flux-dev")

echo "$RESPONSE"
```

Extract the task ID from the response:

```bash
TASK_ID=$(echo "$RESPONSE" | jq -r '.data.id')
```

### Sync Mode Shortcut

Some models support `enable_sync_mode: true`, which waits for the result in a single request.
Check the llms.txt — if supported, use it for a simpler workflow. Set an appropriate curl
timeout for slow models (e.g. `--max-time 120`).

## Step 6: Poll for Results

Poll `/api/v3/predictions/{id}/result`. The **`/result` suffix is required** —
`/api/v3/predictions/{id}` on its own returns a bare `404 page not found`, which parses to
an empty status and makes a naive poll loop spin until it times out instead of failing.

```bash
# Define once per session
wavespeed_poll() {
  local task_id="$1"
  local interval="${2:-2}"   # default 2s; use 5 for video
  local timeout="${3:-300}"
  local status result
  SECONDS=0
  while [ $SECONDS -lt "$timeout" ]; do
    result=$(curl -s \
      -H "Authorization: Bearer $WAVESPEED_API_KEY" \
      "https://api.wavespeed.ai/api/v3/predictions/$task_id/result")
    status=$(echo "$result" | jq -r '.data.status // empty' 2>/dev/null)
    if [ "$status" = "completed" ]; then
      echo "$result" | jq -r '.data.outputs[]'
      return 0
    elif [ "$status" = "failed" ]; then
      echo "Task failed:"; echo "$result"
      return 1
    elif [ -z "$status" ]; then
      # No parsable status: a wrong URL or an auth error, not a pending task.
      # Surface it instead of spinning for the full timeout.
      echo "Unexpected poll response:"; echo "$result"
      return 3
    fi
    sleep "$interval"
  done
  echo "Timed out after ${timeout}s"
  return 2
}
```

```bash
# Images / speech (fast)
wavespeed_poll "$TASK_ID"

# Video (slower — use 5s interval)
wavespeed_poll "$TASK_ID" 5
```

## Step 7: Deliver the Output

Once completed, the `outputs` array contains URLs to the generated content (expire after 7 days).

- For images: show the URL. Download with `curl -o output.png <url>`.
- For videos: show the URL and offer to download as `curl -o output.mp4 <url>`.
- For audio: show the URL and offer to download as `curl -o output.mp3 <url>`.

To download and open a single image:

```bash
curl -s -o /workspace/wavespeed_output.png "<output-url>"
open --view /workspace/wavespeed_output.png
```

## Error Handling

| HTTP Code | Meaning | Action |
|-----------|---------|--------|
| 401 | Bad API key | Ask the user to verify their API key |
| 429 | Rate limited | Wait and retry after a few seconds |
| 400 | Bad parameters | Re-read the llms.txt for correct params |
| 500 | Server error | Retry once, then report to user |

## Complete Example: Text-to-Image

```bash
# Prerequisite: define wavespeed_poll (see Step 6) once per shell session.
wavespeed_poll() {
  local task_id="$1" interval="${2:-2}" timeout="${3:-300}" status result
  SECONDS=0
  while [ $SECONDS -lt "$timeout" ]; do
    result=$(curl -s -H "Authorization: Bearer $WAVESPEED_API_KEY" \
      "https://api.wavespeed.ai/api/v3/predictions/$task_id/result")
    status=$(echo "$result" | jq -r '.data.status // empty' 2>/dev/null)
    if [ "$status" = "completed" ]; then echo "$result" | jq -r '.data.outputs[]'; return 0
    elif [ "$status" = "failed" ]; then echo "Task failed:"; echo "$result"; return 1
    elif [ -z "$status" ]; then echo "Unexpected poll response:"; echo "$result"; return 3; fi
    sleep "$interval"
  done
  echo "Timed out after ${timeout}s"; return 2
}

# 1. Submit
RESPONSE=$(curl -s -X POST \
  -H "Authorization: Bearer $WAVESPEED_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"prompt": "A cat wearing a space suit, photorealistic", "size": "1024*1024", "num_inference_steps": 28}' \
  "https://api.wavespeed.ai/api/v3/wavespeed-ai/flux-dev")

TASK_ID=$(echo "$RESPONSE" | jq -r '.data.id')

# 2. Poll and get output (uses wavespeed_poll defined above)
wavespeed_poll "$TASK_ID"
```

## Complete Example: Image-to-Video

```bash
# Prerequisite: requires wavespeed_poll from Step 6 (or the Text-to-Image example above)
# to be defined in the current shell session. If running this block standalone, copy the
# wavespeed_poll definition from Step 6 first.

# 1. Upload source image
UPLOAD=$(curl -s -X POST \
  -H "Authorization: Bearer $WAVESPEED_API_KEY" \
  -F "file=@/workspace/source.jpg" \
  "https://api.wavespeed.ai/api/v3/media/upload/binary")

IMAGE_URL=$(echo "$UPLOAD" | jq -r '.data.download_url')

# 2. Submit video generation
RESPONSE=$(curl -s -X POST \
  -H "Authorization: Bearer $WAVESPEED_API_KEY" \
  -H "Content-Type: application/json" \
  -d "{\"prompt\": \"Slowly panning across the scene\", \"image\": \"$IMAGE_URL\", \"duration\": 5}" \
  "https://api.wavespeed.ai/api/v3/alibaba/wan-2.6/image-to-video")

TASK_ID=$(echo "$RESPONSE" | jq -r '.data.id')

# 3. Poll with longer interval for video
wavespeed_poll "$TASK_ID" 5
```

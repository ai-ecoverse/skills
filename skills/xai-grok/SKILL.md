---
name: xai-grok
description: "Use Grok (xAI) models for chat, reasoning, image generation, web/X search, and function calling via the xAI API. Use this skill to call Grok, use xAI models, generate images with Aurora, do real-time web or X search through Grok, or build applications that integrate with xAI's API."
allowed-tools: bash
---

# xAI / Grok Skill

## Step 1: Get the API Key

Before any xAI API call, retrieve the key:

```bash
echo $XAI_API_KEY
```

If the variable is empty, tell the user to set it:
```bash
export XAI_API_KEY=<your-xai-api-key>
```

Store the returned value and use it as `Authorization: Bearer $XAI_API_KEY` in all subsequent API calls.

Base URL for all REST calls: `https://api.x.ai/v1`

## Step 2: Pick the Right Model

### Text / Reasoning Models

Always default to the most capable model unless the user explicitly asks for something cheaper or faster.

| Model | When to Use |
|---|---|
| **`grok-4`** | **Default choice.** Flagship reasoning model for all tasks. |
| `grok-4-1-fast` | Use when the task is tool/search-heavy (multiple tool calls) or needs the 2M token context window. Best tool-calling model. |
| `grok-3` | Only when the user explicitly wants to save cost. Non-reasoning, supports `reasoning_effort`. |
| `grok-3-mini` | Only for high-volume/batch tasks where cost is the primary concern. |

**Grok 4 caveats:** Does NOT support `presencePenalty`, `frequencyPenalty`, `stop`, or `reasoning_effort`. Passing these will cause errors.

### Image Generation

| Model | Status |
|---|---|
| **`grok-imagine-image`** | **Use this.** Aurora-powered, current model. Supports aspect ratios. |
| ~~`grok-2-image-1212`~~ | Deprecated as of 2026-02-24. Do not use. |

### Context Windows
- `grok-4`: 256k tokens
- `grok-4-1-fast`: 2M tokens
- `grok-3`: 131k tokens

## Step 3: Make the API Call

Pick the right pattern based on what the user needs:

### Simple Chat (no tools needed)

Use `/v1/chat/completions` with `grok-4`:
```bash
curl https://api.x.ai/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $XAI_API_KEY" \
  -m 3600 \
  -d '{
    "model": "grok-4",
    "messages": [
      {"role": "system", "content": "You are a helpful assistant."},
      {"role": "user", "content": "Explain quantum entanglement simply."}
    ],
    "stream": false
  }'
```

### Search, Tools, or Agentic Tasks → Responses API

When the task involves web search, X search, code execution, or any combination of tools, use the Responses API (`/v1/responses`) with `grok-4-1-fast`.

**Important:** Include ALL relevant tools in a single API call. Grok handles orchestration — it will decide which tools to invoke and in what order.

```bash
curl https://api.x.ai/v1/responses \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $XAI_API_KEY" \
  -d '{
    "model": "grok-4-1-fast",
    "stream": false,
    "input": [
      {"role": "user", "content": "What are people on X saying about the latest AI news? Cross-reference with web articles."}
    ],
    "tools": [
      {"type": "web_search"},
      {"type": "x_search"}
    ]
  }'
```

**Available server-side tools** (combine as many as needed in one call):
- `web_search` — real-time internet search ($5/1k calls)
- `x_search` — search X posts/profiles ($5/1k calls)
- `code_execution` — sandboxed Python ($5/1k calls)
- `attachment_search` — search uploaded files ($10/1k calls)
- `collections_search` — RAG over document collections ($2.50/1k calls)

### Function Calling (Custom Tools)

Use the Chat Completions endpoint with OpenAI-format tool definitions:
```bash
curl https://api.x.ai/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $XAI_API_KEY" \
  -d '{
    "model": "grok-4-1-fast",
    "messages": [{"role": "user", "content": "What is the weather in San Francisco?"}],
    "tools": [
      {
        "type": "function",
        "function": {
          "name": "get_weather",
          "description": "Get current weather for a city",
          "parameters": {
            "type": "object",
            "properties": {
              "location": {"type": "string", "description": "City name"},
              "unit": {"type": "string", "enum": ["celsius", "fahrenheit"], "default": "celsius"}
            },
            "required": ["location"]
          }
        }
      }
    ],
    "tool_choice": "auto"
  }'
```

**Multi-turn function call loop:**
1. Send request → model returns `tool_calls` in response
2. Execute the function locally
3. Send result back as `{"role": "tool", "tool_call_id": "<id>", "content": "<result>"}`
4. Model generates final answer

### Image Generation

Use `grok-imagine-image` with the images endpoint. Always specify an aspect ratio when the user's intent suggests one (landscape scenes → `16:9`, portraits → `9:16`, etc.).

```bash
curl https://api.x.ai/v1/images/generations \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $XAI_API_KEY" \
  -d '{
    "model": "grok-imagine-image",
    "prompt": "A dramatic eclipse over an Aztec pyramid, photorealistic, golden hour lighting",
    "n": 1,
    "aspect_ratio": "16:9"
  }'
```

**Parameters:**
- `aspect_ratio`: `1:1`, `16:9`, `9:16`, `4:3`, `3:4`, `3:2`, `2:3`, `2:1`, `1:2`, `auto`
- `resolution`: `1k` (default) or `2k`
- `n`: up to 10 images per request

**Image URLs are ephemeral** — always download the image immediately after generation.

#### Writing Good Aurora Prompts

Aurora is an autoregressive model (generates pixels sequentially, like an LLM generates text), not a diffusion model. This means it responds well to natural language descriptions rather than keyword-heavy prompts. However, short or vague prompts get rewritten by an internal "refiner" layer before reaching the image model — which can change your intent. To keep control, write prompts of 40+ words with specific details.

**Recommended prompt structure** — think like a film director, setting the stage before introducing the subject:

```
[Environment/Setting] → [Lighting/Atmosphere] → [Subject + Action] → [Camera/Composition] → [Style/Technical]
```

**Example:**
> A rain-soaked cobblestone alley in a European old town at dusk, warm amber light spilling from wrought-iron streetlamps, a lone figure in a long coat walking away from camera, shot from a low angle with shallow depth of field, cinematic 35mm film grain, Rembrandt lighting.

**What works well:**
- **Natural language** over keyword lists — describe a scene, not a tag cloud
- **Specific camera/lens references** for photorealism: "85mm f/1.4", "Canon EOS R5", "35mm film"
- **Lighting terms**: golden hour, volumetric fog, Rembrandt lighting, neon, bioluminescence
- **Art style references**: "Studio Ghibli meets National Geographic", "oil painting", "cyberpunk aesthetic"
- **Text in images** — Aurora excels at this. Use double quotes for exact text: `a neon sign that says "OPEN" in bright red cursive`
- **Hex colors** for precision: `#FF6B35 orange accent lighting`

**What doesn't work:**
- **Negative prompts** ("no hands", "without text") — Aurora ignores these unlike diffusion models
- **Very short prompts** — the refiner will rewrite them, often changing your intent
- **Seed values** — inconsistent results, unreliable for reproduction

### Vision / Image Understanding
```bash
curl https://api.x.ai/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $XAI_API_KEY" \
  -d '{
    "model": "grok-4",
    "messages": [{
      "role": "user",
      "content": [
        {
          "type": "image_url",
          "image_url": {
            "url": "data:image/jpeg;base64,<base64_string>",
            "detail": "high"
          }
        },
        {"type": "text", "text": "Describe this image in detail."}
      ]
    }]
  }'
```

Image constraints: max 20MiB, jpg/jpeg or png only, any number of images.

### Streaming

Add `"stream": true` to any request. Response comes as SSE (`data: {...}` chunks).

### Structured Outputs
```json
{
  "model": "grok-4",
  "messages": [...],
  "response_format": {
    "type": "json_object"
  }
}
```

## SDK Example (JavaScript / Node.js via OpenAI SDK)

Use with `node -e` for quick inline calls:

```bash
node -e '
const OpenAI = require("openai");
const client = new OpenAI({
  apiKey: process.env.XAI_API_KEY,
  baseURL: "https://api.x.ai/v1",
});

(async () => {
  const completion = await client.chat.completions.create({
    model: "grok-4",
    messages: [{ role: "user", content: "Hello Grok!" }],
  });
  console.log(completion.choices[0].message.content);
})();
'
```

> **Note:** Requires `openai` npm package installed. Prefer `curl` examples for standalone use.

## Pricing Summary

| Model | Input | Output |
|---|---|---|
| grok-4 | Check console.x.ai | Check console.x.ai |
| grok-4-1-fast | Lower than grok-4 | Lower than grok-4 |
| grok-3 | ~$3/M tokens | ~$15/M tokens |
| grok-3-mini | ~$0.30/M | ~$0.50/M |

Tool invocations: $5/1k (web/x/code), $2.50/1k (collections), $10/1k (files).
Batch API: 50% off all token costs (async, ~24h turnaround).

## Common Pitfalls

1. **Grok 4 is always reasoning** — never pass `reasoning_effort`, `stop`, `presencePenalty`, or `frequencyPenalty` to `grok-4`.
2. **Use `-m 3600`** (curl timeout) for reasoning models — they think before answering.
3. **Combine tools in one call** — the Responses API handles orchestration. Don't split `web_search` and `x_search` into separate requests; pass them both in the `tools` array and let Grok decide how to use them.
4. **Image URLs are ephemeral** — download generated images immediately.
5. **Knowledge cutoff is November 2024** — enable `web_search` or `x_search` for current events.
6. **Model aliases auto-update** — use `grok-4` not `grok-4-<date>` unless you need pinned consistency.
7. **Always retrieve the API key first** — see Step 1. Without a valid key, API calls will fail with auth errors.


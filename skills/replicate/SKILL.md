---
name: replicate
description: |
  Interact with Replicate.com via its HTTP API — run models, list and inspect models
  and versions, manage predictions and trainings, browse hardware and collections,
  and make raw authenticated API calls. Use when the user wants to run an AI model
  on Replicate, check prediction status, browse available models, manage trainings,
  inspect model schemas, or automate any Replicate workflow from the shell.
  Triggers on "replicate", "run a model on replicate", "replicate prediction",
  "replicate training", "replicate model schema", "list replicate models", or
  any request involving Replicate.com workflows.
allowed-tools: bash
---

# Replicate — CLI Client for Replicate.com

Run AI models, manage predictions and trainings, and interact with the full
Replicate HTTP API from the shell via the `replicate` script.

## Step 1: Authenticate

Get a token at https://replicate.com/account/api-tokens (format: `r8_...`).

Store it for this session and all future sessions:

```bash
replicate auth login r8_<your-token>
```

Or set it for the current shell only:

```bash
export REPLICATE_API_TOKEN=r8_<your-token>
```

The script resolves the token in priority order:
1. `--token <t>` flag on the command
2. `REPLICATE_API_TOKEN` environment variable
3. Config stored by `replicate auth login`

**Never commit the token.** It is stored in `scripts/.config` which is git-ignored.

## Step 2: Choose What to Do

### Run a model

```bash
# Run black-forest-labs/flux-schnell with default latest version
replicate run black-forest-labs/flux-schnell prompt="a photo of a cat astronaut"

# Specify a version explicitly
replicate run stability-ai/sdxl:7762fd07 prompt="a lighthouse at dusk" num_outputs=2

# Run and get raw JSON output
replicate run stability-ai/sdxl prompt="a lighthouse" --json

# Run without waiting (returns prediction ID immediately)
replicate run stability-ai/sdxl prompt="test" --no-wait
```

Input values are coerced automatically:
- `num_outputs=2` → number 2
- `disable_safety_checker=true` → boolean true
- `extra={"key":"val"}` → parsed as JSON object
- `prompt="a cat"` → string (quotes optional in shell)

The command uses `Prefer: wait=60` for single-call sync mode (up to 60s), then falls
back to polling every 2 seconds until `succeeded`, `failed`, or `canceled`.

### Inspect a model

```bash
# Model overview
replicate model get stability-ai/sdxl
replicate model get black-forest-labs/flux-schnell

# List all versions
replicate model versions stability-ai/sdxl

# Show input/output schema (from OpenAPI spec in the version)
replicate model schema stability-ai/sdxl
replicate model schema stability-ai/sdxl:7762fd07cf82c948538e41f63f77d685e02b063e37e496e96eefd46c929f9bdc
```

### Browse public models

```bash
# First page of public models
replicate models list

# Search models (beta — uses /v1/search)
replicate models search "flux lora portrait"
replicate models search "text to speech"
```

### Manage predictions

```bash
# List your predictions
replicate prediction list

# Show a specific prediction (with output URLs and tail of logs)
replicate prediction get <prediction_id>

# Cancel a running prediction
replicate prediction cancel <prediction_id>
```

### Manage trainings

```bash
replicate training list
replicate training get <training_id>
```

### Hardware, deployments, collections

```bash
replicate hardware list         # Available GPU/CPU SKUs for model creation
replicate deployment list       # Your deployments
replicate collections list      # Curated model collections
replicate collections get generating-images   # Models in a collection
```

### Account

```bash
replicate account               # Show authenticated account info
```

## Step 3: Output

By default the script outputs human-readable formatted text. Add `--json` to any
command to get raw JSON (useful for piping to `jq`):

```bash
replicate prediction list --json | jq '.[0].output'
replicate model get stability-ai/sdxl --json | jq .latest_version.id
```

## Raw API Access

Call any endpoint with `replicate api`:

```bash
# GET with a path
replicate api /account
replicate api GET /models/stability-ai/sdxl
replicate api /models/stability-ai/sdxl/versions

# POST with a JSON body (read-only via --data is fine; use --no-wait for mutations)
replicate api POST /predictions --data '{"version":"...","input":{"prompt":"test"}}'
```

## Limitations

- **File inputs** (`@path/to/file`) are not supported in this script. Upload files to
  a public URL first, then pass the URL as the input value.
- **Streaming output** (`--stream`) is not implemented. For models that stream token-by-token
  text output, the polling mode captures the final assembled output.
- **Model creation / version push** requires the Cog CLI; this script focuses on the
  inference and management API surface.
- **The `run` code path has not been live-verified** because running models costs real money.
  The create-prediction and poll logic is patterned directly from the official CLI source
  and Replicate HTTP API docs. Live-verify it yourself with an inexpensive model such as
  `replicate run replicate/hello-world text="test"` (free tier, ~1s).

## Error Handling

| HTTP | Meaning | Action |
|------|---------|--------|
| 401  | Invalid token | `replicate auth login <new-token>` |
| 403  | Billing required or private model | Add payment method at replicate.com/billing |
| 404  | Model / version / prediction not found | Check the identifier |
| 422  | Invalid inputs | Run `replicate model schema <owner/name>` to see valid params |
| 429  | Rate limited | Wait a few seconds and retry |
| 500  | Server error | Retry once; check replicate.com/status |

## References

- HTTP API docs: https://replicate.com/docs/reference/http
- Official CLI source (Go): https://github.com/replicate/cli
- API token management: https://replicate.com/account/api-tokens
- Replicate docs: https://replicate.com/docs

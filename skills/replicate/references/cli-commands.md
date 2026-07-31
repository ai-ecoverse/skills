# Replicate Official CLI — Command Surface Reference

Source: https://github.com/replicate/cli  
Verified from source at commit `a865c18` (Jul 2024).

## Top-Level Commands

```
replicate [command]

Core commands:
  account     Interact with account
  auth        Manage authentication
  hardware    Interact with hardware
  model       Interact with models
  prediction  Interact with predictions
  scaffold    Create a local dev environment from a prediction
  training    Interact with trainings
  deployment  Interact with deployments

Alias commands:
  run         Alias for "prediction create"
  stream      Alias for "prediction create --stream"
  train       Alias for "training create"
```

## model subcommands

Source: `internal/cmd/model/`

```
replicate model list
replicate model show <owner/name>
replicate model schema <owner/name>        # Shows OpenAPI input/output schema
replicate model create <owner/name> [flags]
```

run is also exposed as `replicate model run` (alias).

## prediction subcommands

Source: `internal/cmd/prediction/`

```
replicate prediction create <owner/name[:version]> [input=value ...]
  Flags:
    --json              Emit JSON
    --web               Open prediction in browser
    --wait / --no-wait  Wait for completion (default: wait)
    --stream / --no-stream  Stream output (default: stream if model supports it)
    --save              Save outputs to directory
    --output-directory  Directory for --save (default: ./<prediction-id>)
    --separator         Input key=value separator (default: =)

replicate prediction list
replicate prediction show <id>
```

## training subcommands

Source: `internal/cmd/training/`

```
replicate training create <owner/name[:version]> [input=value ...]
  --destination <owner/name>   Where to push the trained model version
  --web                        Open in browser

replicate training list
replicate training show <id>
```

## auth subcommand

Source: `internal/cmd/auth/`

```
replicate auth login    # Prompts for token (sets REPLICATE_API_TOKEN or writes config)
replicate auth logout   # Clears stored token
replicate auth whoami   # Shows current authenticated identity
replicate auth token    # Prints raw token (for scripting)
```

## run alias

```
replicate run <owner/name[:version]> [input=value ...]
```

Same as `prediction create`. Inputs: `key=value` pairs.  
Use `@path/to/file` to upload a local file (not supported in jsh version).

## Input parsing (from official CLI)

The official CLI (`internal/util/input.go`):
- Splits on `--separator` (default `=`)
- Value coercion via OpenAPI schema `type` field:
  - string → string
  - integer/number → parsed as number
  - boolean → "true"/"false" → bool
  - uri → if `@path`, uploads file and substitutes URL
  - array/object → JSON-parsed
- Stdin piped input: if model expects one input and only `key=` is given (no value),
  it reads the value from stdin

## Differences in jsh implementation

This skill's `replicate.jsh` mirrors the official CLI command surface with these differences:

| Feature | Official CLI | replicate.jsh |
|---------|-------------|---------------|
| `@file` uploads | ✓ supported | ✗ not supported (pass URLs) |
| `--stream` | ✓ SSE streaming | ✗ not implemented (polls) |
| `scaffold` | ✓ creates Node/Python project | ✗ not implemented |
| `model create` | ✓ | ✗ not implemented (requires billing) |
| `training create` | ✓ | ✗ (would cost money; just `training get/list`) |
| Progress bar | ✓ ncurses | simple stderr dots |
| `--web` | ✓ opens browser | ✗ not implemented |
| Single-dash flags | ✓ via cobra | ✗ use `--flag` form |

## Model identifier formats

Official CLI source (`internal/identifier/identifier.go`):

```
owner/name           → latest version (looks up /models/<owner>/<name>)
owner/name:version   → explicit full 64-hex version ID
owner/name:tag       → version tag (if the model uses tags)
```

The jsh implementation supports the same three forms.

## Version IDs

Replicate version IDs are 64-character hex strings, e.g.:
`7762fd07cf82c948538e41f63f77d685e02b063e37e496e96eefd46c929f9bdc`

Short prefixes (12 chars) are shown in the jsh output for readability but full IDs
are required for API calls. The jsh script uses the full ID internally.

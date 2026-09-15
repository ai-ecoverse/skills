# gh mcp — GitHub MCP server passthrough

Authenticated passthrough to GitHub's remote MCP server, mirroring
`gh api` ergonomics for the JSON-RPC based Model Context Protocol.

**Endpoint:** `https://api.githubcopilot.com/mcp/`
**Transport:** streamable-http (JSON-RPC over HTTP POST)
**Source:** [github/github-mcp-server](https://github.com/github/github-mcp-server)

## Authentication

The managed OAuth token (`skill.token('github')`) is domain-locked to `api.github.com`
by the SLICC runtime and cannot authenticate against `api.githubcopilot.com`.

Token resolution order:
1. `GITHUB_MCP_TOKEN` environment variable
2. `git config gh-mcp-token`
3. `skill.token('github')` (works only if the runtime's domain allow-list is expanded)

Setup:
```bash
export GITHUB_MCP_TOKEN="ghp_…"
# or persistently:
git config gh-mcp-token "ghp_…"
```

The PAT needs the same scopes as for `gh api` (`repo`, `read:org`), plus any
Copilot-specific entitlements for tools like `assign_copilot_to_issue`.

## Subcommands

### gh mcp tools

List tools exposed by the MCP server.

```
gh mcp tools [--json] [--jq <expr>]
```

| Flag | Description |
|------|-------------|
| `--json` | Raw JSON output (array of tool objects with name, description, inputSchema) |
| `-q, --jq <expr>` | Filter `--json` output through a jq expression |

### gh mcp call

Invoke a single MCP tool.

```
gh mcp call <tool> [-F key=value]... [-f key=value]... [--jq <expr>]
```

| Flag | Description |
|------|-------------|
| `-F, --field <key=value>` | Typed field — `true`/`false`/`null` and integers are auto-converted |
| `-f, --raw-field <key=value>` | Raw string field — value is always a string |
| `-q, --jq <expr>` | Filter output through a jq expression |

Field parsing follows the same rules as `gh api -F`/`-f`, including bracket
notation for nested objects.

Examples:
```bash
gh mcp call get_me
gh mcp call get_file_contents -F owner=octocat -F repo=Hello-World -F path=README.md
gh mcp call search_code -f query="language:go repo:github/github-mcp-server"
gh mcp call assign_copilot_to_issue -F owner=myorg -F repo=myrepo -F issueNumber=42
```

### gh mcp server-card

Fetch and display the MCP server card. No authentication required.

```
gh mcp server-card [--json] [--jq <expr>]
```

### gh mcp raw

Send an arbitrary JSON-RPC method. Escape hatch for methods not covered by
the other subcommands.

```
gh mcp raw <method> [--params '{"key":"value"}'] [--input <file>] [--init] [--id <n>] [--jq <expr>]
```

| Flag | Description |
|------|-------------|
| `--params <json>` | JSON object for the `params` field |
| `--input <file>` | Read params from a JSON file (`-` for stdin) |
| `--id <n>` | JSON-RPC request id (default: 1) |
| `--init` | Send `initialize` + `notifications/initialized` before the request |
| `-q, --jq <expr>` | Filter output through a jq expression |

Example:
```bash
gh mcp raw tools/list --init
gh mcp raw tools/call --init --params '{"name":"get_me","arguments":{}}'
```

## MCP tools with no REST API equivalent

These tools are available only through the MCP server and cannot be replicated
with `gh api`:

| Tool | Description |
|------|-------------|
| `assign_copilot_to_issue` | Assign Copilot coding agent to an issue |
| `create_pull_request_with_copilot` | Delegate a task to Copilot coding agent |
| `get_copilot_job_status` | Check status of a Copilot coding agent job |
| `request_copilot_review` | Request Copilot code review on a PR |
| `find_duplicate` | Issue deduplication |
| `push_files` | Multi-file commit in a single call |
| `run_secret_scanning` | Scan content for exposed secrets |
| `search_code` | Native code search (different from REST search API) |
| `sub_issue_write` | Manage sub-issues (add, remove, reprioritize) |
| `issue_write` | Granular issue field updates (types, custom fields) |

Most other MCP tools (`list_issues`, `create_pull_request`, `get_file_contents`,
etc.) duplicate functionality already available through `gh api` and the REST API.

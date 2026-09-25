# Slack Support Portal (`slack-support`)

Reference for the `slack-support` command summarised in SKILL.md ("Slack Support Portal").

The `slack-support` script manages help requests on Adobe's Slack Support Portal
(`adobe-dx-support.enterprise.slack.com`). It scrapes the server-rendered portal
using `playwright-cli` — no REST API is available. Requires an open browser tab
at the support portal domain.

### Quick start

```bash
# List all help requests, or only the open ones
slack-support list
slack-support list --status=open
# View a specific request with its comment thread
slack-support view 6750592
# Reply to a request
slack-support reply 6750592 "Thanks, that fixed it."
# Create a new request
slack-support create --topic=slack-connect --title="Connect issue" "Cannot invite external user"
# Resolve a request
slack-support resolve 6750592
```

### Available commands

- `slack-support list [--status=open|closed|all]` — request ID, status, title and
  last-updated date. Default `all`.
- `slack-support view <id>` — details plus the comment thread.
- `slack-support reply <id> <message>` — add a reply to an existing request.
- `slack-support create --topic=<topic> --title=<title> <message>` — open a new
  request. Topics: `audio-video`, `billing-plans`, `connection-trouble`,
  `managing-channels`, `managing-members`, `notifications`, `signing-in`,
  `slack-connect`, `workflow-builder`, `workspace-migration`.
- `slack-support resolve <id>` — mark a request resolved.

Auth is the existing browser session cookie at
`adobe-dx-support.enterprise.slack.com` — no separate token, since the
`playwright-cli` commands run in the tab context.

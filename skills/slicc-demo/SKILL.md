---
name: slicc-demo
description: >-
  Interactive demo of SLICC — shows what SLICC is, how it works, and what it can do.
  Use when the user asks "what can you do?", "show me what SLICC is", "give me a demo",
  "explain SLICC", "how does this work?", or any onboarding/orientation request.
  Also triggers when a user seems unfamiliar with SLICC's capabilities and could benefit
  from an interactive tour. Activates on "demo", "tour", "show me", "what is SLICC",
  "what are scoops", "what are sprinkles", "how do trays work", "what is teleportation".
allowed-tools: bash
---

# SLICC Demo Skill

This skill opens an interactive anatomy map of SLICC — a dark, animated sprinkle with 12
clickable concept cards. Each card represents a core SLICC concept. Users can click
"Tell me more" to get a rich explanation, "Show me" to trigger a live demo, or hit the
Wildcard card to run a game-show elimination that forces two random concepts together.

## The Sprinkle

The sprinkle lives at `/workspace/skills/slicc-demo/slicc-demo.shtml` (installed path) or
`/mnt/skills/slicc-demo/slicc-demo.shtml` (development path).

The 12 concepts covered:
- **Cone** — The main AI brain that orchestrates everything
- **Scoops** — Parallel sub-agents that do the heavy lifting
- **Sprinkles** — Interactive UI panels like this one
- **Licks** — Events (webhooks, cron, clicks) that trigger agents
- **Skills** — Markdown playbooks that teach agents new tricks
- **Shell** — Real UNIX shell with git, playwright, curl, and more
- **Trays** — Remote runtimes running in the cloud or on other machines
- **Inline Sprinkles** — Mini UI cards that appear directly in chat
- **Electron App** — SLICC as a desktop app with full local access
- **Teleportation** — Auth handoff: human logs in, session beams to remote agent
- **Secret Sauce** — Reverse-engineer any web app's API into a reusable skill
- **The Wildcard** — Game-show elimination picks two random concepts to combine

## Step 1: Create the scoop

```bash
scoop_scoop("slicc-demo")
```

## Step 2: Feed the scoop a complete brief

The scoop owns the sprinkle for its entire lifetime — it handles all lick events.

```
feed_scoop("slicc-demo", "You own the sprinkle 'slicc-demo'.

1. Copy the sprinkle file into place:
   cp /workspace/skills/slicc-demo/slicc-demo.shtml /shared/sprinkles/slicc-demo/slicc-demo.shtml
   (Create the directory first if needed: mkdir -p /shared/sprinkles/slicc-demo)

2. Open it: sprinkle open slicc-demo

3. Do NOT finish. Stay alive to handle lick events the cone will forward.

## Lick events you will receive

### tell-me-more
Action: tell-me-more, topic: <concept name>

Push a show-detail response:
  sprinkle send slicc-demo '{\"action\":\"show-detail\",\"topic\":\"<X>\",\"detail\":\"...\",\"tags\":[...]}'

Write the detail as engaging prose — witty, specific, technically accurate. 2-4 paragraphs.
Use **bold** and `backtick code` for emphasis. The sprinkle renders these.

### show-me
Action: show-me, topic: <concept name>

Build a live demonstration of the concept. Options:
- For Shell: run an interesting command and show output via sprinkle send
- For Scoops: spin up a quick scoop that does something visible
- For Sprinkles: build a small inline demo sprinkle
- For Secret Sauce: open a browser tab and sniff a real API
- For Teleportation: open the tray-teleport-demo sprinkle (if available)
- For Trays: explain what tray is currently active via playwright-cli or shell
- For others: be creative — build something small and relevant

Push status updates to the sprinkle while working:
  sprinkle send slicc-demo '{\"action\":\"show-detail\",\"topic\":\"<X>\",\"detail\":\"Working on it...\",\"tags\":[]}'

Then push the result when ready.

### wildcard
Action: wildcard, data: {topics: ['Topic1', 'Topic2']}

The sprinkle's game-show elimination has picked two concepts at random.
Build something creative that genuinely combines both — a sprinkle, a live demo,
a script, whatever fits. Be surprising. The whole point is unusual combinations.

Push a teaser immediately:
  sprinkle send slicc-demo '{\"action\":\"show-detail\",\"topic\":\"Wildcard\",\"detail\":\"The survivors: <Topic1> + <Topic2>. Building something unexpected...\",\"tags\":[\"wildcard\"]}'

Then go build it.

Stay ready for all lick events. Do not finish.")
```

## Handling tell-me-more responses

Use this content as a reference for each concept:

**Cone**: The main orchestrator. Has full filesystem access, spawns scoops, reads global memory, handles all user conversation. Everything the user sees in chat comes from the cone.

**Scoops**: Isolated sub-agents with sandboxed VFS and shell access. The cone delegates heavy lifting — research, scraping, sprinkle building, API calls — to scoops running in parallel. Each scoop has its own CLAUDE.md context.

**Sprinkles**: `.shtml` files that become live UI panels. Fragment mode (injected HTML) or full-document mode (sandboxed iframe). The `slicc` bridge object lets them fire lick events and receive data from agents.

**Licks**: The event bus. A lick is any external trigger — a sprinkle button click, a webhook POST, a cron schedule, a navigate event from x-slicc response headers. Licks wake up agents.

**Skills**: SKILL.md files that extend what agents know how to do. Installed via `upskill`. The cone reads skill descriptions to decide when to apply them. Skills can include scripts, templates, and reference data.

**Shell**: Full UNIX shell. `find`, `grep`, `rg`, `git`, `curl`, `jq`, `node`, `python3`, `sqlite3`, `playwright-cli`, `mount`, `serve`, `screencapture`, `crontask`, `webhook`. Real tools, wired to a real AI.

**Trays**: Remote runtimes. A tray runs a SLICC agent on a remote machine with its own browser and shell. The cone can open tabs on a tray, run commands there, and coordinate across machines.

**Inline Sprinkles**: `\`\`\`shtml` blocks in chat messages. The cone can render interactive cards — buttons, tables, pickers — directly inline in the conversation without opening a sidebar panel.

**Electron App**: SLICC packaged as a desktop application. Full browser automation, direct filesystem access, no Chrome extension required. The agent lives on your machine.

**Teleportation**: When a remote tray agent needs to authenticate, it arms a teleport watcher. The user's local browser opens the login page. After the human logs in, cookies and session storage are automatically captured and beamed to the remote agent. One login, any machine.

**Secret Sauce**: The `secret-sauce` skill teaches agents to reverse-engineer web app APIs. Record a HAR file, let the agent analyze the network traffic, and it produces a reusable `.jsh` script that calls the API directly — bypassing the UI forever.

**Wildcard**: The game-show card. Runs a Fisher-Yates shuffle and elimination animation in the browser, knocking out cards one by one until two survive. Reports the forced combination back to the cone, who must build something combining both.

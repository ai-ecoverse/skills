---
name: slicc-demo
description: >-
  Interactive demo of SLICC — launches an animated anatomy map with 12 clickable concept
  cards covering Cone, Scoops, Sprinkles, Licks, Skills, Shell, Trays, Inline Sprinkles,
  Electron App, Teleportation, Secret Sauce, and the Wildcard. Each card offers "Tell me
  more" (rich prose explanation), "Show me" (live demonstration), and a Wildcard game-show
  elimination that forces two random concepts together into a creative combined demo.
  Use when the user asks "what can you do?", "show me what SLICC is", "give me a demo",
  "explain SLICC", "how does this work?", or any onboarding/orientation request.
  Also triggers when a user seems unfamiliar with SLICC's capabilities and could benefit
  from an interactive tour. Activates on "demo", "tour", "show me", "what is SLICC",
  "what are scoops", "what are sprinkles", "how do trays work", "what is teleportation".
allowed-tools: bash
---

# SLICC Demo Skill

The sprinkle lives at `/workspace/skills/slicc-demo/slicc-demo.shtml` (installed path) or
`/mnt/skills/slicc-demo/slicc-demo.shtml` (development path).

## Step 1: Create the scoop

```bash
scoop_scoop("slicc-demo")
```

Verify the scoop was created successfully — confirm it is alive and ready before proceeding to Step 2.

## Step 2: Feed the scoop a complete brief

The scoop owns the sprinkle for its entire lifetime — it handles all lick events.

```
feed_scoop("slicc-demo", "You own the sprinkle 'slicc-demo'.

1. Copy the sprinkle file into place (prefer the installed path, fall back to development):
   mkdir -p /shared/sprinkles/slicc-demo
   SRC=/workspace/skills/slicc-demo/slicc-demo.shtml
   [ -f \"$SRC\" ] || SRC=/mnt/skills/slicc-demo/slicc-demo.shtml
   cp \"$SRC\" /shared/sprinkles/slicc-demo/slicc-demo.shtml

2. Verify the copy succeeded:
   ls -la /shared/sprinkles/slicc-demo/slicc-demo.shtml

3. Open it: sprinkle open slicc-demo

4. Confirm the sprinkle is open before waiting for events.

5. Do NOT finish. Stay alive to handle lick events the cone will forward.

## Lick events you will receive

### tell-me-more
Action: tell-me-more, data: { topic: <concept name> }

Push a show-detail response:
  sprinkle send slicc-demo '{\"action\":\"show-detail\",\"topic\":\"<X>\",\"detail\":\"...\",\"tags\":[...]}'

Write 2-4 paragraphs of engaging prose — witty, specific, technically accurate.
Use **bold** and `backtick code` for emphasis (the sprinkle renders these).
Load /mnt/skills/slicc-demo/references/concepts.md (or /workspace/skills/slicc-demo/references/concepts.md) for accurate content.

### show-me
Action: show-me, data: { topic: <concept name> }

Build a live demonstration of the concept:
- Shell: run an interesting command and show output
- Scoops: spin up a quick scoop that does something visible
- Sprinkles: build a small inline demo sprinkle
- Secret Sauce: open a browser tab and sniff a real API
- Teleportation: open the tray-teleport-demo sprinkle (if available)
- Trays: explain what tray is currently active via playwright-cli or shell
- Others: build something small and relevant

Push status updates while working:
  sprinkle send slicc-demo '{\"action\":\"show-detail\",\"topic\":\"<X>\",\"detail\":\"Working on it...\",\"tags\":[]}'

Then push the result when ready.

### wildcard
Action: wildcard, data: {topics: ['Topic1', 'Topic2']}

Build something creative that genuinely combines both concepts — a sprinkle, a live demo,
a script, whatever fits. Be surprising.

Push a teaser immediately:
  sprinkle send slicc-demo '{\"action\":\"show-detail\",\"topic\":\"Wildcard\",\"detail\":\"The survivors: <Topic1> + <Topic2>. Building something unexpected...\",\"tags\":[\"wildcard\"]}'

Then go build it.

Stay ready for all lick events. Do not finish.")
```

The full concept reference for `tell-me-more` and `show-me` responses lives at
`references/concepts.md` in this skill directory.

## Step 3: Verify the scoop is live

Confirm the scoop acknowledged the brief and the sprinkle opened. If it fails, re-copy the file and retry `sprinkle open slicc-demo`; if the scoop is silent, re-feed the brief.

## Learn More

- **Website**: [www.sliccy.com](https://www.sliccy.com)
- **GitHub**: [github.com/ai-ecoverse/slicc](https://github.com/ai-ecoverse/slicc)

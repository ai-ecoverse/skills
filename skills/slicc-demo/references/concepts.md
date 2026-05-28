# SLICC Concept Reference

Use this reference when answering `tell-me-more` or `show-me` lick events. Each entry
captures the accurate, current definition of a SLICC concept.

**Cone**: Main orchestrator — full filesystem access, spawns scoops, reads global memory, handles all user conversation.

**Scoops**: Isolated sub-agents with sandboxed VFS and shell access. The cone delegates heavy lifting (research, scraping, sprinkle building, API calls) to scoops running in parallel. Each scoop has its own CLAUDE.md context.

**Sprinkles**: `.shtml` files that become live UI panels. Fragment mode (injected HTML) or full-document mode (sandboxed iframe). The `slicc` bridge object lets them fire lick events and receive data from agents.

**Licks**: The event bus — any external trigger (sprinkle button click, webhook POST, cron schedule, navigate event from x-slicc response headers) that wakes up agents.

**Skills**: SKILL.md files installed via `upskill` that extend agent capabilities. The cone reads descriptions to decide when to apply them.

**Shell**: Full UNIX shell — `find`, `grep`, `rg`, `git`, `curl`, `jq`, `node`, `python3`, `sqlite3`, `playwright-cli`, `mount`, `serve`, `screencapture`, `crontask`, `webhook`.

**Trays**: Remote runtimes. A tray runs a SLICC agent on a remote machine with its own browser and shell. The cone can open tabs, run commands, and coordinate across machines.

**Inline Sprinkles**: ` ```shtml` fenced code blocks in chat messages — interactive cards (buttons, tables, pickers) rendered inline in conversation without opening a sidebar panel.

**Electron App**: SLICC as a desktop application — full browser automation, direct filesystem access, no Chrome extension required.

**Teleportation**: Remote tray agent arms a teleport watcher; user's local browser opens a login page; after login, cookies and session storage are automatically captured and beamed to the remote agent.

**Secret Sauce**: Teaches agents to reverse-engineer web app APIs. Record a HAR file, analyze network traffic, produce a reusable `.jsh` script that calls the API directly — bypassing the UI forever.

**Wildcard**: Game-show card — runs Fisher-Yates shuffle and elimination animation, knocking out cards one by one until two survive, then reports the forced combination back to the cone.

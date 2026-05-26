# Stardust setup reference

Stardust is Adobe's website-redesign skill. When run for a brand, it produces `DESIGN.md` and `DESIGN.json` at the project root carrying brand-specific tokens — palette role names, typography, spacing, divergence seed (decade × craft × register × ground-family), and a font deck. The presentations skill consumes those tokens to generate brand-native theme CSS.

Source: <https://github.com/adobe/skills/tree/main/plugins/stardust>

## Detection

```bash
test -f DESIGN.json   # preferred — token spec is here
test -f DESIGN.md     # design system markdown
test -f stardust/direction.md  # full reasoning trace (optional)
```

If `DESIGN.json` exists: skip install, generate theme dynamically (see `style-guide.md` § Stardust integration).

If neither exists, also check whether the stardust skill itself is installed:

```bash
ls .claude/skills/stardust/SKILL.md \
   ~/.claude/skills/stardust/SKILL.md \
   .agents/skills/stardust/SKILL.md \
   .cursor/skills/stardust/SKILL.md \
   plugins/stardust/skills/stardust/SKILL.md 2>/dev/null
```

## Install methods

Pick whichever matches the user's harness. Run the bash-based ones via the Bash tool; print the slash commands for the user to invoke themselves.

| Method | Command | Notes |
|--------|---------|-------|
| Claude Code plugin (built-in) | `/plugin marketplace add adobe/skills` then `/plugin install stardust@adobe-skills` | User runs the slash commands. Skills can't invoke them. |
| upskill (SLICC native) | `upskill adobe/skills --skill stardust` | Run via Bash. Standalone CLI. |
| gh upskill (extension) | `gh upskill adobe/skills --skill stardust` | Run via Bash. Requires `trieloff/gh-upskill` gh extension. |
| npx skills (Vercel) | `npx skills add adobe/skills --skill stardust` | Run via Bash. Generic, works anywhere npx runs. |

## Impeccable dependency

Stardust hard-depends on **impeccable** (`pbakaus/impeccable`). On install, also offer to install impeccable the same way:

- `upskill pbakaus/impeccable --all`
- `gh upskill pbakaus/impeccable --all`
- `npx skills add pbakaus/impeccable --all`

Without impeccable, stardust refuses to run on first invocation.

## After install

Stardust normally needs `$stardust extract <url>` then `$stardust direct` before `DESIGN.json` appears at the project root. Surface those steps to the user — they're not automatic.

## Phrasing the offer

Concise. Don't oversell. Example:

> Want me to install stardust first? It generates brand-specific tokens that make presentations feel native to a brand, not pasted onto one. Without it, decks fall back to anchor-mood mode (still distinctive, just not specific to your brand).
>
> Install: `upskill adobe/skills --skill stardust` · `gh upskill adobe/skills --skill stardust` · `npx skills add adobe/skills --skill stardust` · or run `/plugin marketplace add adobe/skills` then `/plugin install stardust@adobe-skills` for Claude Code.
>
> Or skip — I'll use anchor-mood mode.

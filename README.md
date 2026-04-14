# ai-ecoverse/skills

A collection of agent skills for [SLICC](https://github.com/ai-ecoverse/slicc), installable via [upskill](https://github.com/ai-ecoverse/upskill).

## Install

Install a single skill:

```sh
upskill ai-ecoverse/skills --skill <name>
```

Install all skills:

```sh
upskill ai-ecoverse/skills --all
```

## Skill directory structure

Each skill lives in its own directory under `skills/`:

```
skills/{skill-name}/
├── SKILL.md              # Required — skill definition with YAML frontmatter
├── scripts/              # .jsh scripts (callable as shell commands)
├── references/           # API docs, endpoint references
└── assets/               # Observer scripts, .bsh auto-injectors, etc.
```

Only `SKILL.md` is required. Add the other directories as needed.

## SKILL.md frontmatter

Every `SKILL.md` starts with YAML frontmatter that defines the skill metadata:

```yaml
---
name: my-skill
description: Short description of what the skill does and when to use it
allowed-tools: bash
---
```

| Field | Required | Description |
|-------|----------|-------------|
| `name` | Yes | Skill identifier (should match the directory name) |
| `description` | Yes | What the skill does and when to trigger it |
| `allowed-tools` | No | Tools the skill is allowed to use |

The body of `SKILL.md` contains the full skill definition — instructions, examples, constraints, and any other context the agent needs.

## Related repos

- **[ai-ecoverse/slicc](https://github.com/ai-ecoverse/slicc)** — The SLICC agent runtime that loads and executes skills
- **[ai-ecoverse/upskill](https://github.com/ai-ecoverse/upskill)** — CLI tool for installing and managing skills from GitHub repos

## License

Apache 2.0 — see [LICENSE](LICENSE).


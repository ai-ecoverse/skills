# Publishing a Skill to GitHub

## Prerequisites

A GitHub Personal Access Token (PAT) with `repo` scope must be saved at `/workspace/skills/github/.config`.

Read the token:
```bash
source /workspace/skills/github/.config
# Now $GITHUB_TOKEN is available
```

## Publishing the pm-prd skill to ai-ecoverse/skills

The skill lives at `/workspace/skills/pm-prd/`. To publish it, upload each file to the GitHub repo via the Contents API.

### Step 1: Check if the skill already exists in the repo

```bash
curl -s \
  -H "Authorization: Bearer $GITHUB_TOKEN" \
  https://api.github.com/repos/ai-ecoverse/skills/contents/skills/pm-prd
```

If it returns a 404, the skill is new. If it returns files, you'll need the `sha` of each file to update them.

### Step 2: Base64-encode the file content

```bash
base64 -w 0 /workspace/skills/pm-prd/SKILL.md
```

### Step 3: Create or update the file via API

**Create (new file):**
```bash
curl -s -X PUT \
  -H "Authorization: Bearer $GITHUB_TOKEN" \
  -H "Content-Type: application/json" \
  https://api.github.com/repos/ai-ecoverse/skills/contents/skills/pm-prd/SKILL.md \
  -d "{
    \"message\": \"Add pm-prd skill\",
    \"content\": \"$(base64 -w 0 /workspace/skills/pm-prd/SKILL.md)\"
  }"
```

**Update (existing file — requires sha):**
```bash
curl -s -X PUT \
  -H "Authorization: Bearer $GITHUB_TOKEN" \
  -H "Content-Type: application/json" \
  https://api.github.com/repos/ai-ecoverse/skills/contents/skills/pm-prd/SKILL.md \
  -d "{
    \"message\": \"Update pm-prd skill\",
    \"content\": \"$(base64 -w 0 /workspace/skills/pm-prd/SKILL.md)\",
    \"sha\": \"<sha-from-step-1>\"
  }"
```

### Files to publish

Upload in this order:
1. `skills/pm-prd/SKILL.md`
2. `skills/pm-prd/references/prd-template.md`
3. `skills/pm-prd/references/github-publish.md`

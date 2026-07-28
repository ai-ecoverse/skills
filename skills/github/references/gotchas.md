# GitHub skill — SLICC-specific gotchas

Quirks that bite when you go beyond `gh.jsh` and reach for raw `git` or `curl` from the SLICC shell. The skill's main commands route around all of these, so most users never hit them — but if you're scripting workflows directly, read this first.

## `git clone` aborts on directory bundles (`.graffle`, `.app`, `.framework`)

The OPFS-backed git in SLICC fails mid-checkout when a tracked directory whose name has a dotted suffix has child entries — it tries to `mkdir` the children before the parent dir is fully realised. Cloning `adobe/helix-home` reproducibly aborts on `docs/helix2/observation/Observation.graffle/` with:

```
git: ENOENT: ENOENT: No such file or directory, mkdir
'.../helix-home/docs/helix2/observation/Observation.graffle' …
```

The wrapper also rejects flag-based workarounds: `git clone --depth=1`, `--single-branch`, and `--filter=…` all error with `Cannot parse remote URL: --depth`. And once a checkout aborts, the OPFS node can be left in a "phantom" state — `ls` won't show it, but `mkdir` rejects with `File exists`. `rm -rf` and re-mkdir don't recover; the only fix is to clone into a fresh path.

**Workaround: `init` + `fetch` + sparse-checkout to skip the bad directory:**

```bash
mkdir -p /workspace/clones/myrepo
cd /workspace/clones/myrepo

git init
git remote add origin "https://$(oauth-token github)@github.com/owner/repo.git"
git fetch origin

# Tell git to skip the path that triggers the OPFS mkdir bug:
git config core.sparseCheckout true
mkdir -p .git/info
cat > .git/info/sparse-checkout <<SPARSE
/*
!/path/to/Bad.graffle/
SPARSE

# Materialise the working tree:
git checkout --force <branch>
```

`git checkout --force` will print `There are multiple errors that were thrown by the method` — those are the suppressed errors for the excluded paths. Checkout actually succeeds. Verify with `ls` and `git ls-files | wc -l`.

After this, `git status` may report the excluded files as "Changes to be committed" because the index treats them as deletions — sparse-checkout isn't fully wired in this git wrapper. Don't `git commit -a` from this tree blindly; stage explicitly with `git add <specific-paths>` or restore with `git checkout HEAD -- <excluded-path>`.

## Missing git subcommands

The SLICC `git` wrapper supports the verbs listed in `git --help`. Anything else fails with `'<cmd>' is not a git command`. Notably absent:

- `git update-ref` — you can't manually move a branch ref
- `git read-tree` — can't populate the index from a tree without a checkout
- `git restore` — use `git checkout -- <path>` instead
- `git worktree` — single working tree only

For ref manipulation, fall back to the GitHub Git Data API (`gh.jsh api /repos/owner/repo/git/refs -X POST …`).

## `curl --data @file` silently corrupts the body for GitHub API uploads

For any file containing non-ASCII bytes (or arbitrarily, sometimes for ASCII-only files too), `curl --data @<path>` and `curl --data-binary @<path>` produce a body that GitHub rejects with:

```json
{ "message": "Problems parsing JSON", "status": "400" }
```

Inline `-d '{"…":"…"}'` works fine for short payloads, and stdin pipe (`echo … | curl -d @-`) sometimes works for short payloads, but neither is reliable for longer JSON.

**Workaround: build and POST entirely from `node`:**

```bash
cat > /tmp/post-issue.mjs <<NODE
const body = await fs.readFile('/tmp/issue-body.md', 'utf8');
const tok = process.env.GH_TOK;
const r = await fetch('https://api.github.com/repos/owner/repo/issues', {
  method: 'POST',
  headers: {
    Authorization: 'Bearer ' + tok,
    'Content-Type': 'application/json',
    Accept: 'application/vnd.github+json'
  },
  body: JSON.stringify({ title: 'My issue', body })
});
console.log(r.status, await r.text());
NODE
GH_TOK="$(oauth-token github)" node /tmp/post-issue.mjs
```

The `gh.jsh api` passthrough avoids this entirely — it builds the body from `-f key=value` flags or stdin, never from `@file`. Prefer it whenever possible. (`gh api` also accepts the upstream spellings `--method POST` for `-X POST` and `-q`/`--jq` for the response filter.)

## Reach for `--json` before `gh api` + `--jq`

Most read commands now support `--json [fields]` (+ `--jq`), so structured output rarely needs
the raw passthrough any more:

```bash
gh pr view 42 --json statusCheckRollup,reviews,comments,mergeable
gh pr checks 42 --json name,state,bucket
gh run view 123 --json jobs --jq '.jobs[] | select(.conclusion=="failure") | .name'
```

`--jq` shells out to the real `jq` when it is available and falls back to a built-in
`.a.b` / `.a[].b` path evaluator otherwise, so simple filters work either way. Field names
are matched shape-insensitively (`statusCheckRollup` == `status_check_rollup`) and an unknown
field errors with the list of valid ones — no silent empty output.

## `--help` works on every command

`gh <cmd> --help`, `gh <cmd> <sub> --help` and `gh help <cmd> [<sub>]` all print scoped usage
and exit 0. Help is intercepted before argument validation, so `gh pr watch --help` prints
usage rather than complaining about a missing PR number.

## Uploading binary or non-ASCII content via the Contents API

`PUT /repos/owner/repo/contents/<path>` requires a base64-encoded `content` field. The naïve approach — `fs.readFile(path, 'utf8')` then `btoa(text)` — produces a **double-encoded** result for any file with non-ASCII bytes. The SLICC node realm's `fs.readFile(path, 'utf8')` does not actually UTF-8-decode the bytes; it returns a JS string where each input byte is a single codepoint. `TextEncoder().encode()` then re-UTF-8-encodes those codepoints, so an em-dash (`e2 80 94` on disk) becomes `c3 a2 c2 80 c2 94` in the upload payload, and GitHub stores those exact corrupted bytes. The file looks fine when read back via the same broken pipeline, but is mojibake to anyone using a different tool.

**Use `fs.readFileBinary` instead** — it returns a `Uint8Array` with the actual on-disk bytes:

```javascript
const arr = await fs.readFileBinary('/tmp/file.md');
// Convert Uint8Array → "binary string" → base64 (this round-trip is byte-faithful):
let bin = '';
for (let i = 0; i < arr.length; i++) bin += String.fromCharCode(arr[i]);
const b64 = btoa(bin);

// PUT to the contents API:
const r = await fetch(`https://api.github.com/repos/owner/repo/contents/${path}`, {
  method: 'PUT',
  headers: { Authorization: 'Bearer ' + tok, 'Content-Type': 'application/json' },
  body: JSON.stringify({ message: 'commit msg', content: b64, sha: existingSha, branch })
});
```

Verify after upload by fetching `https://raw.githubusercontent.com/owner/repo/<branch>/<path>` from a browser tab via `playwright-cli eval`, **not** from `curl | xxd` — the SLICC shell's I/O layer also applies a Latin-1↔UTF-8 round-trip, so a correctly-stored file will *look* corrupted in `cat` / `xxd` / `head -c`.

## Creating symlinks via the Contents API

`PUT /repos/owner/repo/contents/<path>` always creates a regular file (mode `100644`). It cannot create a symlink. To add a symlink (e.g. `tiles/basic/skills/<name> → ../../../skills/<name>` in `ai-ecoverse/skills`), use the Git Data API:

```bash
TOK=$(oauth-token github)

# 1. Get current branch HEAD and tree
HEAD=$(gh.jsh api /repos/owner/repo/git/ref/heads/<branch> --jq .object.sha)
TREE=$(gh.jsh api /repos/owner/repo/git/commits/$HEAD --jq .tree.sha)

# 2. Create a blob with the symlink target (just the target path text)
BLOB=$(gh.jsh api /repos/owner/repo/git/blobs -X POST \
  -f content="../../../skills/myskill" -f encoding=utf-8 --jq .sha)

# 3. Build a new tree on top of the current tree, with mode 120000 (symlink)
NEW_TREE=$(gh.jsh api /repos/owner/repo/git/trees -X POST \
  -f base_tree=$TREE \
  -f tree[0][path]="tiles/basic/skills/myskill" \
  -f tree[0][mode]=120000 \
  -f tree[0][type]=blob \
  -f tree[0][sha]=$BLOB \
  --jq .sha)

# 4. Commit and move the ref
COMMIT=$(gh.jsh api /repos/owner/repo/git/commits -X POST \
  -f message="add tiles/basic/skills/myskill symlink" \
  -f tree=$NEW_TREE -f parents[]=$HEAD --jq .sha)
gh.jsh api /repos/owner/repo/git/refs/heads/<branch> -X PATCH -f sha=$COMMIT
```

Mode `120000` is the magic number for symlinks in the Git tree object. The blob content is the literal target path string, no special encoding.

## Race conditions on long-running operations

`oauth-token github` and `gh.jsh` calls are quick, but a long sequence of git fetches or contents-API writes can occasionally appear to "stall" — the SLICC bash session enforces some implicit timeouts. If a `git fetch origin` hangs at "Resolving deltas" for >30 seconds and stops emitting progress, give it another 60 seconds before assuming it's stuck. Killing and retrying often resumes from the partial pack.

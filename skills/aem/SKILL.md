---
name: aem
description: AEM Edge Delivery Services (EDS) skill for reading, writing, previewing, and publishing EDS pages via the `aem` CLI. Use when the user asks about AEM Edge Delivery Services, EDS pages, Franklin, Helix, AEM EDS, edge delivery content, document-based authoring, or needs to list, get, put, preview, publish, or upload content in AEM EDS. Supports the full get→edit→put→preview→publish pipeline, on both Helix 5 (admin.hlx.page, admin.da.live) and Helix 6 (api.aem.live Source Bus) sites.
allowed-tools: bash
---

# AEM (Edge Delivery Services)

Shell command for AEM Edge Delivery Services. Manages EDS page content.

## Authentication

Run `oauth-token adobe` to authenticate (auto-triggered on first use).
No manual configuration needed — no client IDs, no service tokens.

## Usage

```
aem <command> <eds-url-or-path> [options]
```

All commands accept full EDS URLs: `https://main--repo--org.aem.page/path`
Or use `--org`/`--repo` flags with a plain path.

## Commands

- `aem list <url>` — List pages in a directory
- `aem get <url> [--output <vfs-path>]` — Get page HTML
- `aem put <url> <vfs-file>` — Write HTML from a VFS file
- `aem preview <url>` — Trigger AEM preview
- `aem publish <url>` — Trigger AEM publish
- `aem upload <vfs-file> <url>` — Upload a media file
- `aem help` — Show usage

## Architecture version: Helix 5 and Helix 6

Sites run on one of two API generations, and the CLI handles both.

| | Helix 5 | Helix 6 |
|---|---|---|
| Content (author source) | `https://admin.da.live/source/<org>/<site>/<path>` | `https://api.aem.live/<org>/sites/<site>/source/<path>` |
| Operations | `https://admin.hlx.page/<verb>/<org>/<site>/<ref>/<path>` | `https://api.aem.live/<org>/sites/<site>/<verb>/<path>` |
| `ref` in the path | yes | dropped where it never mattered |

Helix 6 is in early access. Which generation a site uses is detected per site and
cached for the run, so no flag is normally needed:

- `--hlx6` forces the Helix 6 API.
- `--hlx5` forces the Helix 5 API.
- `--api <host>` points at a different Helix 6 host and implies `--hlx6`.
- `--site <name>` is an alias for `--repo`, matching Helix 6 vocabulary.

Detection probes the Helix 6 source listing for the site. A Helix 5 site has no
such route and answers 404; a 401 or 403 is reported as an authentication
problem rather than swallowed as "not Helix 6".

### Why detection matters

**A site that has been upgraded to Helix 6 is no longer readable through
`admin.da.live`, and the old endpoint does not say so.** It answers 200 with
content from an unrelated project. Any code that assumes `admin.da.live` for
every site will read the wrong document without an error, and a write will land
in a store nobody is looking at. That is the failure this detection exists to
prevent, so avoid hardcoding either backend.

## The Source Bus (Helix 6 content)

On Helix 6 the author content lives behind `/<org>/sites/<site>/source/<path>`,
which the team calls the Source Bus. It is a plain HTTP resource:

- `GET .../source/<path>` returns the document HTML.
- `PUT .../source/<path>` with `Content-Type: text/html` and the file as the
  request body creates or overwrites it, answering **201** in both cases. No
  multipart wrapper is involved, unlike Helix 5.
- `GET .../source/<path>/` lists a folder. **The trailing slash is what makes
  it a listing**; without it the same path returns 404. Entries look like
  `{"name":"my-post.html","size":4595,"content-type":"text/html","last-modified":"..."}`,
  and folders like `{"name":"blog/","content-type":"application/folder"}`. The
  reported `size` has been observed to disagree with the byte length returned by
  `GET`, so treat it as informational.
- Everything requires `Authorization: Bearer <IMS access token>`; without one the
  answer is 401.

Keep request headers minimal. Adding headers such as `Cache-Control` triggers a
CORS preflight that the endpoint rejects.

The wider Helix 6 surface, from the architecture design notes, is
`/<org>/sites/<site>/` plus `status`, `preview`, `live`, `config`, `source`,
`snapshots`, `jobs`, `log`, with `/<org>/config`, `/<org>/profiles`,
`/<org>/sites` at organisation level and `/login`, `/logout`, `/profile`,
`/auth`, `/register`, `/discover` at the root.

### What is verified and what is not

`list`, `get`, `put` and `upload` were exercised by hand against a live Helix 6
site. The `preview` and `live` routes are taken from the design notes and have
not been verified, so on a site detected as Helix 6 those two commands stop and
ask for an explicit `--hlx6` rather than POSTing to a guessed route on a
production site. Binary media through the Source Bus uses the same raw `PUT` as
HTML and is untested, so `upload` reports the HTTP status it received instead of
claiming success.

## Typical Workflow

For editing a page, follow this sequence:

1. **Get** — Fetch the current page HTML:
   ```bash
   aem get https://main--myrepo--myorg.aem.page/page --output /workspace/page.html
   ```
2. **Edit** — Modify `/workspace/page.html` as needed.
3. **Put** — Write the updated HTML back. Verify the command exits successfully (exit code 0) before continuing:
   ```bash
   aem put https://main--myrepo--myorg.aem.page/page /workspace/page.html
   ```
4. **Preview** — Trigger a preview and confirm the response indicates success:
   ```bash
   aem preview https://main--myrepo--myorg.aem.page/page
   ```
5. **Verify** — Optionally re-fetch the page (`aem get`) or inspect the preview URL to confirm the changes appear correctly.
6. **Publish** — Once the preview looks correct, publish:
   ```bash
   aem publish https://main--myrepo--myorg.aem.page/page
   ```

**Error guidance:**
- If `aem put` fails, check that the VFS file path is correct and the file is valid HTML before retrying.
- If `aem preview` or `aem publish` fails, re-run the command — transient network issues are common. If it continues to fail, verify authentication with `oauth-token adobe`.
- Always confirm `aem put` succeeds before running `aem preview` to avoid publishing stale content.

## Examples

```bash
aem list https://main--myrepo--myorg.aem.page/
aem get https://main--myrepo--myorg.aem.page/products/overview
aem get https://main--myrepo--myorg.aem.page/page --output /workspace/page.html
aem put https://main--myrepo--myorg.aem.page/page /workspace/page.html
aem preview https://main--myrepo--myorg.aem.page/page
aem publish https://main--myrepo--myorg.aem.page/page
aem upload /workspace/image.png https://main--myrepo--myorg.aem.page/media_123.png

# Helix 6 site: same commands, backend detected automatically
aem list https://main--aem-website--adobe.aem.page/blog
aem get https://main--aem-website--adobe.aem.page/blog/my-post --output /shared/post.html
aem put https://main--aem-website--adobe.aem.page/blog/my-post /shared/post.html

# Force a backend, or use Helix 6 vocabulary with plain paths
aem list /blog --org adobe --site aem-website --hlx6
aem get /blog/my-post --org myorg --repo myrepo --hlx5
```

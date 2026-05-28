---
name: aem
description: AEM Edge Delivery Services (EDS) skill for reading, writing, previewing, and publishing EDS pages via the `aem` CLI. Use when the user asks about AEM Edge Delivery Services, EDS pages, Franklin, Helix, AEM EDS, edge delivery content, document-based authoring, or needs to list, get, put, preview, publish, or upload content in AEM EDS. Supports the full get→edit→put→preview→publish pipeline.
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
```

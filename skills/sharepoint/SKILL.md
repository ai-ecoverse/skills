---
name: sharepoint
description: >-
  Use this when the user wants to read, search, or list content from
  Microsoft SharePoint — site pages, document libraries, files/folders, and
  list items. Uses the live SharePoint/Microsoft 365 browser session via MSAL
  token extraction (same mechanism as the `outlook` skill), calling Microsoft
  Graph. Triggers on requests involving SharePoint sites, document libraries,
  "read this SharePoint page/file", searching SharePoint, or listing files in
  a SharePoint drive. For Outlook mail/calendar use the `outlook` skill
  instead; for Teams use the `teams` skill.
allowed-tools: bash
---

# SharePoint

Read-oriented CLI access to Microsoft SharePoint via Microsoft Graph. The CLI
extracts an MSAL token from an open Microsoft 365 browser tab (SharePoint,
Outlook, or any `*.sharepoint.com` / `*.cloud.microsoft` tab all share the
same tenant token cache), and falls back to a saved token file so commands
keep working without a tab open. If a command reports it cannot get a token,
open the target SharePoint site (or `https://outlook.office.com`, or
`https://myapps.microsoft.com`) in the browser and retry.

Full flag-by-flag reference: [references/COMMANDS.md](references/COMMANDS.md).

## Quick start

```bash
# Find a site by name/URL segment (needed once, then reuse the id everywhere)
sharepoint sites --search "Marketing"
sharepoint site https://contoso.sharepoint.com/sites/Marketing   # resolve a URL directly

# Document libraries (drives) on a site
sharepoint drives <site-id>

# List files/folders in a library (root, or a subfolder path)
sharepoint files <site-id> --drive <drive-id>
sharepoint files <site-id> --drive <drive-id> --path "Shared Documents/Reports"

# Read a file's content (text-convertible formats: docx, xlsx, pdf, txt, csv, md, html)
sharepoint read <site-id> --drive <drive-id> --item <item-id>
sharepoint read <site-id> --drive <drive-id> --path "Shared Documents/Reports/Q3.docx"

# Search across a site (files, pages, list items)
sharepoint search "budget 2026" --site <site-id>
sharepoint search "budget 2026"                       # tenant-wide

# List items in a SharePoint list (not a document library)
sharepoint lists <site-id>
sharepoint list-items <site-id> --list <list-id>
```

## Resolving a site

Users normally give you a URL (`https://contoso.sharepoint.com/sites/Marketing`)
or a name ("the Marketing site"), not a Graph site id. Two paths:

- **Have a URL** → `sharepoint site <url>` resolves it directly via Graph's
  `/sites/{hostname}:{server-relative-path}` shorthand — one call, no search.
- **Have only a name** → `sharepoint sites --search "<name>"` runs Graph's
  site search and lists candidates with their ids; ask the user to disambiguate
  if more than one plausible match comes back rather than guessing.

Cache the resolved site id for the rest of the conversation — don't re-resolve
on every follow-up command.

## Reading file content

`sharepoint read` fetches the file and converts it to text when the format
supports it:

- `.txt`, `.md`, `.csv`, `.json` — read directly, no conversion.
- `.docx`, `.pdf`, `.pptx` — Graph's `?format=text`preview conversion (falls
  back to raw download + a note if the tenant has conversion disabled).
- `.xlsx` — reads the first worksheet's used range as a table by default;
  pass `--sheet <name>` for a specific sheet.
- Anything else (images, zips, binaries) — refuses with a clear message rather
  than dumping bytes; use `sharepoint download` to save it to the VFS instead.

```bash
sharepoint download <site-id> --drive <drive-id> --item <item-id> --out /workspace/report.pdf
```

## Search scope

`sharepoint search "<query>"` without `--site` searches the whole tenant
(everything the signed-in user can see) via Graph's `/search/query`. Adding
`--site <site-id>` scopes to one site. Results include the item's `webUrl` —
prefer showing that to the user over a bare Graph id so they can click through.

## Don't

- Don't guess a site id from a URL by hand — always resolve via `sharepoint
  site <url>` so the hostname/path parsing (which Graph is picky about) is
  consistent.
- Don't attempt writes (upload, delete, list-item create/update) — this skill
  is read-only by design, matching the `outlook` skill's read/respond split.
  If the user needs to write content back to SharePoint, say so explicitly
  rather than silently trying and failing on a 403.
- Don't assume a `.docx`/`.pdf` preview conversion always succeeds — some
  tenants disable it; fall back to `download` and tell the user why.

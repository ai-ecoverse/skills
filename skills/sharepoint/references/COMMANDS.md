# sharepoint — command reference

```
sharepoint sites --search <query>          Search sites by name/description
sharepoint site <url>                      Resolve a SharePoint URL to a site id
sharepoint drives <site-id>                List document libraries on a site
sharepoint files <site-id> --drive <id>    List files/folders in a library
sharepoint read <site-id> --drive <id>     Read a file's content as text
sharepoint download <site-id> --drive <id> Download a file to the VFS
sharepoint search <query>                  Search files/pages/list items
sharepoint lists <site-id>                 List SharePoint lists on a site
sharepoint list-items <site-id> --list <id> List items in a SharePoint list
sharepoint help                            Show this reference
```

## sites

```
sharepoint sites --search "Marketing"      Search sites tenant-wide
sharepoint sites --search "Marketing" --json
```

Uses Graph `GET /sites?search={query}`. Prints `id`, `displayName`, `webUrl`
for each candidate. Ambiguous results are expected — surface all candidates
rather than picking one.

## site

```
sharepoint site https://contoso.sharepoint.com/sites/Marketing
sharepoint site contoso.sharepoint.com:/sites/Marketing   # same thing, explicit form
```

Parses the hostname and server-relative path out of the URL and calls Graph
`GET /sites/{hostname}:{server-relative-path}`. Prints the resolved `id` —
copy it for the commands below. The root site of a tenant
(`https://contoso.sharepoint.com`, no `/sites/...` segment) resolves via
`GET /sites/{hostname}`.

## drives

```
sharepoint drives <site-id>
sharepoint drives <site-id> --json
```

Uses Graph `GET /sites/{site-id}/drives`. Most sites have one drive named
"Documents" (the default "Shared Documents" library) plus one per additional
library the site owner created. Prints `id`, `name`, `webUrl`, `quota`.

## files

```
sharepoint files <site-id> --drive <drive-id>
sharepoint files <site-id> --drive <drive-id> --path "Shared Documents/Reports"
sharepoint files <site-id> --drive <drive-id> --item <folder-item-id>
sharepoint files <site-id> --drive <drive-id> --recursive
sharepoint files <site-id> --drive <drive-id> --json
```

Lists children of the drive root, or of `--path` / `--item` (folder id) when
given. `--recursive` walks subfolders (bounded — refuses past 5,000 items
total and says so, rather than hanging on a library with tens of thousands of
files). Each row shows `name`, `id`, `size`, `lastModifiedDateTime`, and
whether it's a `folder` or `file`.

## read

```
sharepoint read <site-id> --drive <drive-id> --item <item-id>
sharepoint read <site-id> --drive <drive-id> --path "Shared Documents/Q3.docx"
sharepoint read <site-id> --drive <drive-id> --item <item-id> --sheet "Summary"
sharepoint read <site-id> --drive <drive-id> --item <item-id> --json
```

Resolves `--path` to an item id first if given (one extra Graph call), then
fetches content:

- Plain text formats (`.txt .md .csv .json .html .htm`) — direct download,
  decoded as UTF-8.
- Office formats (`.docx .pptx .pdf`) — Graph preview conversion
  (`GET /drives/{id}/items/{id}/content?format=text`). Some tenants disable
  this; on failure the command says so and suggests `download` instead of
  silently returning nothing.
- `.xlsx` — reads via the Workbook API
  (`GET /drives/{id}/items/{id}/workbook/worksheets/{sheet}/usedRange`),
  defaulting to the first worksheet. `--sheet <name>` picks another.
- Anything else — refused with the file's content type, pointing at
  `download`.

`--json` on a `.xlsx` read returns the raw `values` grid; otherwise it wraps
the extracted text as `{ "name": ..., "text": ... }`.

**Date/time cells print as raw Excel serial numbers** (e.g. `46283`), not
formatted dates — Graph's `usedRange` returns underlying values, not display
text. Convert with `new Date(Date.UTC(1899, 11, 30) + serial * 86400000)`
(Excel's day-zero epoch) when a date-looking integer needs to be read as a
date; don't guess from magnitude alone since a genuine integer column looks
identical.

## download

```
sharepoint download <site-id> --drive <drive-id> --item <item-id> --out /workspace/file.pdf
sharepoint download <site-id> --drive <drive-id> --path "Shared Documents/Q3.pdf" --out /workspace/q3.pdf
```

Streams the raw file bytes to a VFS path via
`GET /drives/{id}/items/{id}/content` (no conversion — exact original bytes).
Use this for anything `read` refuses, or when the user wants the actual file
rather than extracted text.

## search

```
sharepoint search "budget 2026"
sharepoint search "budget 2026" --site <site-id>
sharepoint search "budget 2026" --entity driveItem   # default: all (driveItem + listItem + site)
sharepoint search "budget 2026" --limit 10
sharepoint search "budget 2026" --json
```

Uses Graph `POST /search/query` with `entityTypes` set from `--entity`
(repeatable, default all three). Without `--site`, searches everything the
signed-in user's token can see tenant-wide. Prints `name`/`title`, `webUrl`,
and a short snippet per hit.

## lists / list-items

```
sharepoint lists <site-id>
sharepoint list-items <site-id> --list <list-id>
sharepoint list-items <site-id> --list <list-id> --limit 50
sharepoint list-items <site-id> --list <list-id> --json
```

`lists` uses Graph `GET /sites/{site-id}/lists` (SharePoint lists — Tasks,
Announcements, custom lists — distinct from document libraries, which are
drives). `list-items` uses `GET /sites/{site-id}/lists/{list-id}/items?expand=fields`
and prints each item's `fields` as a flattened table; `--json` gives the raw
per-item `fields` object, useful when a list has custom columns the table
view would truncate.

## Authentication

Token is extracted automatically from an open Microsoft 365 browser tab
(SharePoint, Outlook, or the M365 app launcher all share the same MSAL cache
for the signed-in tenant) — same mechanism as the `outlook` skill's token
extraction, retargeted at the `graph.microsoft.com` audience instead of
`outlook.office.com`. Falls back to `/shared/.sharepoint-token` when no tab is
open. If neither works, the command says exactly which URL to open.

Required scopes: `Sites.Read.All` (or `Sites.ReadWrite.All`, which also
satisfies read) plus `Files.Read.All` for content/download. A token missing
these answers `403 Access is denied` from Graph — re-open a SharePoint tab
(not just Outlook) if that happens, since Outlook's own token sometimes lacks
the Sites/Files scopes even though it targets the same `graph.microsoft.com`
audience.

---
name: da-live
description: >
  Read and write Adobe Document Authoring (da.live) content mounted as a VFS
  filesystem: HTML pages, markdown, images, and spreadsheet-style sheet files
  (.json). Use when editing pages or data through a DA mount (da:// source),
  adding or changing rows in a DA sheet, inspecting a sheet's columns, or
  recalculating its totals. Pages and media use normal file operations; sheets
  go through `da-live`, which validates rows against the sheet's schema,
  recalculates total/limit/offset, and writes once.
allowed_tools:
  - bash
  - read_file
  - write_file
  - edit_file
scripts:
  - da-live.jsh
---

# Adobe Document Authoring (DA) — VFS Mount

DA content is accessed via a filesystem mount backed by `https://admin.da.live`.
Files are read and written as plain bytes — DA performs no server-side processing of content.

## Sheet files (.json)

Sheets are a special case. Always use the `da-live` script to write them — it validates
rows against the existing schema, recalculates derived fields, and performs a single
write to the remote. Never write sheet JSON directly to the VFS path.

## Non-sheet files

For all other file types (HTML, markdown, images, etc.), use normal file operations
directly on the VFS path — read, edit, and write as you would any local file.

## Working with sheets

1. **Inspect** the schema before constructing rows:
   ```bash
   da-live schema /mnt/<mount-path>/data/sheet.json
   # multi-sheet: da-live schema /mnt/<mount-path>/data/sheet.json --sheet <name>
   ```

2. **Write** the complete row set (all rows, not only the changed ones):
   ```bash
   # single-sheet: a sheet whose existing rows have the keys name and role
   da-live write /mnt/<mount-path>/data/team.json '[{"name":"Ada","role":"dev"},{"name":"Bob","role":"ops"}]'

   # multi-sheet: name the sheet to update; the other sheets are kept as they are
   da-live write /mnt/<mount-path>/data/site.json --sheet people '[{"name":"Ada","role":"dev"}]'
   ```

3. **Verify** by re-reading the file:
   ```bash
   cat /mnt/<mount-path>/data/sheet.json
   ```

4. **If write fails**, read the error (missing or extra keys), rebuild the row JSON so every row matches the schema from step 1, and retry `da-live write`. Do not write the JSON directly to the VFS path as a workaround.

## Key rules

- Never write sheet JSON directly to the VFS path: only `da-live write` keeps the schema and the derived fields right.
- Rows must match the existing schema exactly; the script names any missing or extra key.
- `da-live recalc <path>` fixes total/limit/offset in place after a manual repair.

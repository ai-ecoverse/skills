---
name: da-live
description: >
  Working with Adobe Document Authoring (da.live) content mounted as a VFS filesystem.
  Use when reading or writing files through a DA mount (da:// source). Non-sheet files
  use normal file operations; sheet files (.json) must go through the da-live script
  which handles schema validation, derived fields, and a single atomic write.
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

2. **Write** the updated row set — validates schema, recalculates, and writes in one operation:
   ```bash
   # single-sheet
   da-live write /mnt/<mount-path>/data/sheet.json '[{"key":"val",...}, ...]'

   # multi-sheet — specify which sheet to update
   da-live write /mnt/<mount-path>/data/sheet.json --sheet <name> '[{"key":"val",...}, ...]'
   ```

3. **Verify** by re-reading the file:
   ```bash
   cat /mnt/<mount-path>/data/sheet.json
   ```

## Key rules

- **Always** use `da-live write` to modify sheets — never write JSON directly to the VFS path.
- **Always** pass the complete row set for the target sheet, not just changed rows. For multi-sheet files, other sheets are preserved automatically.
- Rows must exactly match the existing schema. The script will fail with a clear error
  if any row has missing or extra keys.
- For multi-sheet files, unmodified sheets are preserved as-is.

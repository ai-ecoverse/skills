---
name: da-live
description: >
  Working with Adobe Document Authoring (da.live) content mounted as a VFS filesystem.
  Use when reading or writing files through a DA mount (da:// source), especially
  DA sheet files (.json). Covers the sheet write contract: derived fields must be
  computed by the agent, da.live stores bytes as-is without any server-side processing.
allowed_tools:
  - bash
  - read_file
  - write_file
  - edit_file
---

# Adobe Document Authoring (DA) — VFS Mount

DA content is accessed via a filesystem mount backed by `https://admin.da.live`.
Files are read and written as plain bytes — DA performs no server-side processing
of content.

## Sheet files (.json)

DA sheets are JSON files stored verbatim in the backing object store. The server
does not interpret, recalculate, or transform the content on read or write.

**You are responsible for all derived values.** This includes:
- Totals, counts, sums, averages
- Any field whose value is computed from other fields in the document

If you add, remove, or modify rows, recalculate every derived field yourself
before writing. DA will store exactly what you send.

## Write workflow for sheets

1. **Read** the current file to get the full JSON structure and the current ETag:
   ```bash
   cat /mnt/<mount-path>/data/sheet.json
   ```

2. **Modify** the data (add/remove/update rows).

3. **Recalculate** all derived fields (totals, counts, etc.) from the updated data.

4. **Write** the complete updated JSON back:
   ```bash
   write_file /mnt/<mount-path>/data/sheet.json <updated-json>
   ```

5. **Verify** by re-reading the file to confirm what was stored:
   ```bash
   cat /mnt/<mount-path>/data/sheet.json
   ```

## Key rules

- **Never** skip recalculation of derived fields — there is no server fallback.
- **Always** read before writing. The mount uses ETags for conflict detection;
  writing without a prior read will fail.
- **Always** write the complete JSON document, not a partial update.

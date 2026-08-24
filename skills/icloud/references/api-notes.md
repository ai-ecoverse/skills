# iCloud Web API Notes

## Authentication

iCloud web APIs use cookie-based authentication. The browser session at
`icloud.com` carries the necessary cookies (`X-APPLE-WEBAUTH-VALIDATE`,
`X-APPLE-WEB-ID`, etc.). All requests must include `credentials: "include"`.

### Session Discovery

```
POST https://setup.icloud.com/setup/ws/1/validate
  ?clientBuildNumber=2618Build21
  &clientMasteringNumber=2618Build21
  &clientId=<any-uuid>
```

Returns:
- `dsInfo.dsid` — the user's Directory Services ID (e.g., `17099314`)
- `webservices.calendar.url` — e.g., `https://p27-calendarws.icloud.com:443`
- `webservices.ckdatabasews.url` — e.g., `https://p27-ckdatabasews.icloud.com:443`
- `webservices.notes.url` — e.g., `https://p49-notesws.icloud.com:443`

The `pXX` prefix varies per user (server partition).

## Calendar API

### Get Events

```
GET https://p27-calendarws.icloud.com/ca/events
  ?startDate=2026-05-27
  &endDate=2026-06-03
  &lang=en-us
  &usertz=Europe%2FBerlin
  &clientBuildNumber=2618Build21
  &clientMasteringNumber=2618Build21
  &clientId=<uuid>
  &dsid=<dsid>
```

Response: `{ Event: [...], Recurrence: [...] }`

### Event Structure

```json
{
  "title": "Meeting",
  "guid": "UUID",
  "pGuid": "calendar-collection-guid",
  "allDay": false,
  "duration": 60,
  "tz": "Europe/Berlin",
  "localStartDate": [20260530, 2026, 5, 30, 20, 0, 1200],
  "localEndDate": [20260530, 2026, 5, 30, 21, 0, 180],
  "startDate": [20260530, 2026, 5, 30, 20, 0, 1200],
  "endDate": [20260530, 2026, 5, 30, 21, 0, 180],
  "location": "Room 42",
  "description": "HTML or plain text",
  "recurrenceMaster": false,
  "recurrence": "GUID*MME-RID"
}
```

Date array format: `[YYYYMMDD, year, month, day, hour, minute, minuteOfDay]`

- Index 6 is **not seconds**. On write and on `startDate` it is minutes since
  midnight (`hour*60 + minute`). On a *server-returned* `endDate` it is minutes
  until midnight (`1440 − (hour*60 + minute)`). Shared-schema ISO therefore
  always uses `arr[4]:arr[5]:00`.
- Timed `duration` is minutes. All-day `duration` is `days × 1440`.
- All-day: `hour`, `minute`, and index 6 are `0`; `tz` is `null`.
- All-day `endDate` is **exclusive** (the day after the last blocked day). A
  same-day all-day event is stored as 1 day (`duration: 1440`, end = next day).

### List calendars

```
GET https://p27-calendarws.icloud.com/ca/allcollections
  ?startDate=YYYY-MM-DD&endDate=YYYY-MM-DD
  &lang=en-US&usertz=Europe%2FBerlin&clientVersion=6.0
  &clientBuildNumber=2618Build21&clientMasteringNumber=2618Build21
  &clientId=<uuid>&dsid=<dsid>
```

Response: `{ Collection: [...] }` with `title`, `guid`, `readOnly`, `isDefault`,
`isFamily`, `ctag`. `icloud calendars` prints those five public fields.

### Create event

```
POST https://p27-calendarws.icloud.com/ca/events/{pGuid}/{guid}
  ?startDate=<event-start-YMD>&endDate=<event-end-YMD>
  &lang=en-US&usertz=Europe%2FBerlin&clientVersion=6.0
  &requestID=<int>&clientBuildNumber=2618Build21
  &clientMasteringNumber=2618Build21&clientId=<uuid>&dsid=<dsid>
```

- Query `startDate`/`endDate` must cover the event being created (not
  `now…now+7d`). Far windows (2027) work.
- Body is JSON with `Content-Type: text/plain`. `Event.etag` must be `''`.
  `ClientState.Collection` carries `{guid, ctag}` from a fresh
  `/ca/allcollections` read. No `ifMatch` on create.
- `--calendar` is required: exact title, then unique substring, then guid.
  Never default to `work` / Arbeit.

Contract write, 2026-08-24, calendar **Familie**
(`guid 8a4b028c24c6454160d55fbae2018d0d4ff76d380b77d1d7649cca8f901cf6b5`):
event `4C693D70-FC5D-4670-A0EA-F3C4E923B511`, all-day 31.07–08.08.2027,
exclusive `endDate` 09.08, `duration` 12960, `tz` null, HTTP 200.

### Other Calendar Endpoints

- `GET /ca/alarmtriggers` — upcoming alarms
- `GET /ca/state` — calendar sync state
- `GET /ca/startup` — full startup payload (may return 400 without proper headers)

## Notes API (CloudKit)

Notes uses CloudKit Database Service (`ckdatabasews`).

### Zone Discovery

```
POST https://p27-ckdatabasews.icloud.com/database/1/com.apple.notes/production/private/zones/list
  ?clientBuildNumber=2618Build21&clientId=<uuid>&dsid=<dsid>
Body: {}
```

Returns zones including `Notes` zone with `ownerRecordName`.

### Fetch Notes (Changes API)

The `query` endpoint doesn't work for Notes (type not marked indexable).
Use `changes/zone` instead:

```
POST https://p27-ckdatabasews.icloud.com/database/1/com.apple.notes/production/private/changes/zone
  ?clientBuildNumber=2618Build21&clientId=<uuid>&dsid=<dsid>
Body: {
  "zones": [{
    "zoneID": { "zoneName": "Notes", "ownerRecordName": "<owner>" }
  }]
}
```

Response includes `syncToken` and `moreComing` for pagination.
Pass `syncToken` in subsequent requests to get next page.

### Record Types in Notes Zone

- `Note` — the note record
- `Folder_UserSpecific` — folder metadata
- `Note_UserSpecific` — per-user note state
- `Attachment` — file attachments
- `InlineAttachment` — inline images/files
- `Media` — media records

### Note Record Fields

| Field | Type | Description |
|-------|------|-------------|
| TitleEncrypted | ENCRYPTED_BYTES | Base64-encoded UTF-8 title |
| SnippetEncrypted | ENCRYPTED_BYTES | Base64-encoded UTF-8 snippet |
| TextDataEncrypted | ENCRYPTED_BYTES | Gzip-compressed protobuf (full content) |
| ModificationDate | TIMESTAMP | Unix timestamp in milliseconds |
| CreationDate | TIMESTAMP | Unix timestamp in milliseconds |
| Deleted | INT64 | 0 = active, 1 = deleted |
| Folder | REFERENCE | Parent folder reference |
| PaperStyleType | INT64 | Note paper style |

### Decoding Note Content

1. **Title/Snippet**: Simple base64 → UTF-8 decode
   ```js
   const binary = atob(b64Value);
   const bytes = new Uint8Array(binary.length);
   for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
   const text = new TextDecoder("utf-8").decode(bytes);
   ```

2. **Full Content (TextDataEncrypted)**:
   - Base64 decode → gzip decompress → protobuf binary
   - Text can be extracted by stripping non-printable characters
   - The protobuf format is Apple's proprietary TTML-like note format
   - Readable text is interspersed with control bytes

   ```js
   // Decompress using DecompressionStream API
   const ds = new DecompressionStream("gzip");
   // ... write bytes, read chunks ...
   const text = new TextDecoder("utf-8", { fatal: false }).decode(result);
   const readable = text.replace(/[^\x20-\x7E\u00A0-\uFFFF\n\r\t]/g, "").trim();
   ```

## Request Headers

All requests use:
- `Content-Type: text/plain` (avoids CORS preflight)
- `Origin: https://www.icloud.com`
- `credentials: "include"` (sends cookies)

Using `application/json` as Content-Type triggers CORS preflight which may fail.

## Client Parameters

All endpoints require:
- `clientBuildNumber=2618Build21` (may change with iCloud updates)
- `clientMasteringNumber=2618Build21`
- `clientId=<any-string>` (can be any identifier)
- `dsid=<user-dsid>` (from validate response)

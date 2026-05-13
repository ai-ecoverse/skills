# Adobe ServiceNow ESC — API Endpoints

**Instance:** `adobe.service-now.com`
**Portal:** ESC (Employee Service Center)
**Portal ID:** `70cd9f3b734b13001fdae9c54cf6a72f`
**Auth:** Cookie-based via Okta SSO (session cookies + X-UserToken CSRF)

## Important notes

- The standard ServiceNow Table API (`/api/now/table/*`) is **blocked** from the ESC portal — requests hang indefinitely.
- All data access goes through the **Service Portal (SP) API** which is accessible via Angular's `$http` injector from the page context.
- The `X-UserToken` header (value from `window.g_ck`) is required but Angular adds it automatically.
- Knowledge Base search is powered by **Coveo** (separate API, token-based).

---

## Service Portal API

### GET /api/now/sp/page

Load a portal page with all widget data pre-rendered.

**Required headers** (added by Angular automatically):
- `X-UserToken: {g_ck}`
- `X-Requested-With: XMLHttpRequest`
- `x-portal: 70cd9f3b734b13001fdae9c54cf6a72f`

**Query parameters:**
| Param | Description |
|-------|-------------|
| id | Page ID (e.g., `ticket`, `adb_esc_my_requests`, `adb_esc_kb_article`, `order_status`) |
| table | Table name (e.g., `incident`, `sc_req_item`, `sc_request`) |
| sys_id | Record sys_id |
| sysparm_article | KB article number (for KB page) |
| portal_id | `70cd9f3b734b13001fdae9c54cf6a72f` |

**Response structure:**
```json
{
  "result": {
    "containers": [{
      "rows": [{
        "columns": [{
          "widgets": [{
            "widget": {
              "name": "Widget Name",
              "data": { /* widget-specific data */ }
            }
          }]
        }]
      }]
    }],
    "user": { "sys_id": "...", "name": "..." }
  }
}
```

**Key pages:**
- `id=adb_esc_my_requests` — My Requests list (uses Coveo)
- `id=ticket&table=incident&sys_id=X` — Individual incident
- `id=ticket&table=sc_req_item&sys_id=X` — Individual request item
- `id=order_status&table=sc_request&sys_id=X` — Request status
- `id=adb_esc_kb_article&sysparm_article=KBxxxxxxx` — KB article
- `id=adb_esc_contact_support` — Create new support request

---

### POST /api/now/sp/widget/{widget_id}

Interact with a specific widget (read data, submit forms).

**Ticket conversation widget:** `a54beb3a87f10010e0ef0cf888cb0bba`

**Query parameters:**
| Param | Description |
|-------|-------------|
| id | Page context (e.g., `ticket`) |
| sys_id | Record sys_id |
| table | Table name |

#### Read ticket comments

```json
POST /api/now/sp/widget/a54beb3a87f10010e0ef0cf888cb0bba?id=ticket&sys_id={SYS_ID}&table=incident

Body: {
  "sys_id": "{SYS_ID}",
  "isPosting": false
}
```

**Response data includes:**
```json
{
  "result": {
    "data": {
      "stream": {
        "number": "INC3616952",
        "entries": [{
          "name": "Lars Trieloff",
          "sys_created_on_adjusted": "05-13-2026 12:30:12",
          "value": "<p>Comment text...</p>",
          "field_label": "Additional comments (Customer Visible)",
          "element": "comments"
        }],
        "journal_fields": [
          { "name": "comments", "label": "Additional comments (Customer Visible)", "can_write": true },
          { "name": "work_notes", "label": "Work notes", "can_write": true }
        ]
      }
    }
  }
}
```

#### Post a comment

```json
POST /api/now/sp/widget/a54beb3a87f10010e0ef0cf888cb0bba?id=ticket&sys_id={SYS_ID}&table=incident

Body: {
  "sys_id": "{SYS_ID}",
  "isPosting": true,
  "journalEntry": "Your comment text here",
  "journalEntryField": "comments",
  "table": "incident"
}
```

Use `"journalEntryField": "work_notes"` for internal work notes.

---

### Ticket header widget: "ADB Standard Ticket Header"

Available in ticket page response. Contains:
```json
{
  "number": { "display_value": "INC3616952", "value": "INC3616952" },
  "title": "Short description",
  "sys_id": "...",
  "table": "incident",
  "headerFields": [
    { "name": "sys_created_on", "display_value": "05-13-2026 12:28:08" },
    { "name": "sys_updated_on", "display_value": "05-13-2026 12:28:08" },
    { "name": "state", "display_value": "New", "value": "1" }
  ],
  "fields": [
    { "name": "caller_id", "display_value": "Lars Trieloff", "label": "Caller" },
    { "name": "priority", "display_value": "3 - Moderate", "label": "Priority" },
    { "name": "assignment_group", "display_value": "SD-Global", "label": "Assignment Group" },
    { "name": "cmdb_ci", "display_value": "AnyConnect", "label": "Configuration item" }
  ]
}
```

---

## Coveo Search API

**Endpoint:** `https://adobev2prod9e382h1q.org.coveo.com/rest/search/v2`
**Auth:** Bearer token (JWT extracted from portal page data)
**Token location:** Portal page → widget "ADB: ECP Coveo Searchbox" → `data.coveo.accessToken`
**Token expiry:** ~24 hours

### POST /rest/search/v2

```json
{
  "q": "search query",
  "numberOfResults": 10,
  "searchHub": "ServiceNowESC_MainSearch",
  "fieldsToInclude": ["sn_kb_article", "sntitle", "snshort_description", "sysid", "snnumber"]
}
```

**Response:**
```json
{
  "totalCount": 32,
  "results": [{
    "title": "Article Title",
    "uri": "https://adobe.service-now.com/api/now/table/kb_knowledge/{sys_id}",
    "clickUri": "...",
    "excerpt": "...",
    "raw": {
      "sn_kb_article": "KB0023295",
      "snnumber": "KB0023295"
    }
  }]
}
```

---

## Known sys_ids

| Entity | sys_id |
|--------|--------|
| User (Lars Trieloff) | `a3b27bff3755df8047afc8cfc3990e7c` |
| Portal (ESC) | `70cd9f3b734b13001fdae9c54cf6a72f` |
| Ticket conversation widget | `a54beb3a87f10010e0ef0cf888cb0bba` |

## State values (incident)

| Value | Label |
|-------|-------|
| 1 | New |
| 2 | In Progress |
| 3 | On Hold |
| 6 | Resolved |
| 7 | Closed |

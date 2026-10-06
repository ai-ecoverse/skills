# gmaps internals — the Maps directions backend

Reverse-engineered 2026-10-06 with the `secret-sauce` method: capture what the
web app sends, replay it, then minimise it.

## Discovery

1. Open `https://www.google.com/maps/dir/?api=1&origin=…&destination=…&travelmode=…`
   in a tab, then list `performance.getEntriesByType('resource')`. The directions
   come from one request:
   `GET https://www.google.com/maps/preview/directions?authuser=0&hl=en&gl=de&pb=<~120 tokens>`
   (the `MapsWizUi/data/batchexecute` calls are unrelated UI RPCs).
2. **Replayed from sandbox `curl` with no cookies: HTTP 200, same data.** So no
   session, key or browser tab is needed; plain `fetch()` from the `.jsh` works.
3. Captured once per mode. Only three tokens differed: the mode, a session id
   (`!15m3!1s…`) and a signed viewport token (`!50s…`), and the last two are
   optional.
4. Removed every node of the `pb` tree one at a time, keeping each removal if
   walking still returned ~21-minute routes. Result (110 chars):

       !1m2!1s<origin>!6e0!1m2!1s<destination>!6e0!6m3!20m2!1e<mode>!2e3

## The `pb` format

`!<field><type><value>`. Types: `s` string, `e` enum, `i` int, `j` int64, `d`
double, `b` bool, `f` float, and `m<k>` a message spanning the next **k
tokens** (counted flat, not as k child messages). Inside `s` values `!` must be
sent as `*21` and `*` as `*2A`; then the whole string is URL-encoded, keeping `!`.

| Token | Meaning |
| --- | --- |
| `!1m2!1s<text>!6e0` | waypoint by free text (repeat: origin, destination) |
| `!6m…!20m2!1e<n>!2e3` | travel mode `n`: 0 driving, 1 bicycling, 2 walking, 3 transit. **`!2e3` is required**: without it, or with any other value, 0 routes |
| `!19m2!2e2!3j<t>` | depart at `t` (inside `6m`, after `20m2`) |
| `!19m3!1e1!2e2!3j<t>` | arrive by `t` |

`t` is the **local wall-clock time encoded as if UTC**: 19:00 in Munich is
`Date.UTC(2026,9,6,19,0)/1000`, not the real epoch. Verified: the page's own
`!8j` in a "depart 19:00" URL equals `Date.UTC(…19:00)`, and the backend returned
the same 19:02/19:12/19:02/19:22 departures the page showed. `!2e1` (tried as
"depart") silently ignores the time and returns routes hours off, which is why
`2e2` is used.

The page-URL mode code (`!3e<n>`, a different ordering) has **no effect** on
this endpoint, and neither do `gl` or the viewport.

## Response

Body is a `)]}'` guard line followed by JSON made of positional arrays.

| Path | Value |
| --- | --- |
| `j[0][0][i][0][0][0]` | waypoint query text as Google echoes it |
| `j[0][0][i][0][0][2]` | `[null,null,lat,lng]` — **null when geocoding failed** (unknown place) |
| `j[0][0][i][0][1][0]` | `["Street 24","81671 München"]` display parts |
| `j[0][1]` | routes; empty array when nothing connects |
| `route[0][1]` | "via …" summary (non-transit) or headway "every 10 min" (transit) |
| `route[0][2]` | `[meters, "1.5 km", 0]` |
| `route[0][3]` | `[seconds, "21 min", …]` |
| `route[0][5][0]` / `[1]` | transit dep/arr `[epoch, "Europe/Berlin", "4:32 PM", utcOffsetSecs, …]` |
| `route[0][10][4][2]` | driving typical range "5–7 min" |
| `route[0][11]` | transit fare `[4.2, "€4.20", "EUR"]` |
| `route[1][0][1]` | transit legs; each `leg[0]` = `s` |
| `s[14][0][2][3]` | leg kind: "Walk", "Bus", "Tram", "Subway", "Train" |
| `s[14]` tags `[5,[line,…]]` / `[7,[headsign]]` | line name(s) / direction |
| `s[6][0]`, `s[6][1]` | boarding / alighting stop |
| `s[6][12][3]`, `s[6][13][2]` | leg departure / arrival time arrays |
| `s[6][14]` | intermediate stops (length + 1 = stops ridden) |

Clock times are printed from `epoch + utcOffset` rather than the "4:32 PM"
string, which is locale-formatted.

## Failure modes, handled

- Unknown place: HTTP 200 with routes empty and that waypoint's coordinates
  null → `can't find "<query>"`.
- No route (Munich → New York by car): coordinates present, routes empty.
- Layout change: non-JSON body, or routes without durations → explicit error
  pointing here. No silent zeroes.

## Verified 2026-10-06

- All four modes for Levelingstraße 2 → August-Everding-Straße 24, München, matching
  the rendered page: walking 21/21/22 min, cycling 5/6, driving 6/5/5, transit Bus
  190 9 min and Tram 21 15 min at €4.20. "Depart 19:00" matched the page's four
  departures exactly; "arrive by 19:00" gave 18:42–18:51.
- London (King's Cross → Tower, 08:30 tomorrow): Circle line, £3.10, miles, local time.
- `!`/`&`/`*`/`#` in place names, unknown place (rc 1), ocean (rc 1), bad args (rc 2).
- Wall time ~1.5 s for all four modes in parallel; the earlier tab-scraping version took ~22 s.

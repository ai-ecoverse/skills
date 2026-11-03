# The panel's cgi-bin

`loose-ends sprinkle` writes a `cgi-bin/` next to the panel. Each script is a
two-line `sh` wrapper that sets `LOOSE_ENDS_FILE` to the store it was
installed for and runs `loose-ends.jsh cgi <action>` with `jsh`, or with
`node` where there is no jsh.

The scripts follow CGI/1.1 (RFC 3875) as proposed for SLICC sprinkles in
[slicc-agent#814](https://github.com/ai-ecoverse/slicc-agent/issues/814), so
they also run under any CGI server.

| script | method | body | does |
|---|---|---|---|
| `items` | GET | none | answers the store's items |
| `done` | POST | `{ "id" }` | marks it done |
| `reopen` | POST | `{ "id" }` | undoes done |
| `snooze` | POST | `{ "id", "when" }` | snoozes it; `when` as for the CLI |
| `wake` | POST | `{ "id" }` | ends the snooze |

## Request

- `REQUEST_METHOD`, `CONTENT_TYPE` and `CONTENT_LENGTH`, with the body on
  stdin, at most 64 KB. The body is JSON (`application/json`) or a form
  (`application/x-www-form-urlencoded`), so an HTML `<form>` works too.
- `id` is matched like the CLI's: an exact id, or a unique prefix with or
  without `le-`.
- `SLICC_OWNER`, when the host sets it, names the cone to tell.

## Response

Always `Status:`, `Content-Type: application/json`, `Cache-Control: no-store`
and `X-Loose-Ends: 2`, then a JSON body.

| status | when | body |
|---|---|---|
| 200 | done | `{ ok: true, id, updated, tasks }`, the whole list after the change |
| 400 | no id, a time it can't read, a body that isn't JSON | `{ ok: false, error }` |
| 404 | no such action, no item matches | `{ ok: false, error }` |
| 405 | GET to a POST script, or the other way round | `{ ok: false, error }` |
| 409 | the id prefix matches more than one item | `{ ok: false, error }` |
| 413 | body over 64 KB | `{ ok: false, error }` |
| 500 | the store can't be read or written | `{ ok: false, error }` |

Errors change nothing. The panel uses cgi-bin only when `GET cgi-bin/items`
answers with `X-Loose-Ends: 2`. Otherwise it falls back to `slicc.readFile`
and licks.

## Telling the cone

After a change, and only when `SLICC_OWNER` is a plain name, the script runs
`agent send <owner> --lick=sprinkle --source loose-ends -` with argv only and
`<action> <id>: <title>` on stdin, then ignores the result. slicc-agent 7.12.1
refuses `--lick=sprinkle` from a process. #814 proposes allowing it for a
sprinkle's own scripts.

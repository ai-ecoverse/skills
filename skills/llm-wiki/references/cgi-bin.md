# The panel's cgi-bin

`wiki sprinkle` writes a `cgi-bin/` next to the panel. Each script is a short
`sh` wrapper that sets `WIKI_ROOT` and `OKF_BIN` to the root and the okf
program it was installed for, then runs `wiki.jsh cgi <action>` with `jsh`,
or with `node` where there is no jsh. The scripts follow CGI/1.1 (RFC 3875),
as SLICC runs a sprinkle's `cgi-bin/`, so the folder also works under any CGI
server (`python3 -m http.server --cgi`).

Both actions are read-only GETs that run okf with argv only, never a shell.

| script | request | answers |
|---|---|---|
| `concepts` | `GET cgi-bin/concepts?text=&type=&tag=` | `{ ok, root, filters, types, concepts }`: `okf search` with those filters. Each concept is `{ id, title, type }`, plus `description`, `tags` and `status` when its frontmatter has them as one-line values. `types` lists every type in the bundle. |
| `show` | `GET cgi-bin/show/<id>` (or `?id=<id>`) | `{ ok, concept, backlinks }`: `okf show` and `okf backlinks` for that id |

Every answer has `Status:`, `Content-Type: application/json`, `Cache-Control:
no-store` and `X-Wiki: 1`. The panel trusts only an answer that carries
`X-Wiki: 1`.

| status | when |
|---|---|
| 200 | done |
| 400 | no id, or an id with `..`, `.`, an empty segment or a leading `/` |
| 403 | `Sec-Fetch-Site` is cross-site, or `Origin` is not `Host` |
| 404 | no such action, or no such concept |
| 405 | anything but GET |
| 500 | the root is not set or is missing, or okf isn't installed (`error` starts with `wiki: okf not found`) |
| 502 | okf failed; `error` carries its message |

Query values are cut to 200 characters. A refused request never runs okf.

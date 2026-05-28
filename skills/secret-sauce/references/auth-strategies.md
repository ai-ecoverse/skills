# Auth strategies

Pick the row that matches the API you discovered in Phase 1.

| Auth type              | How to detect                                                                 | Where the credential lives                         | How to call the API                                                                  |
|------------------------|-------------------------------------------------------------------------------|----------------------------------------------------|--------------------------------------------------------------------------------------|
| **PAT / API key**      | Public docs mention "personal access token" or `X-API-Key` header            | Ask user, store in `/workspace/skills/{app}/.config` | `fetch()` with `Authorization: Bearer <PAT>` or the documented header                |
| **Bearer / JWT**       | `Authorization: Bearer ey…` in HAR; token in `localStorage`/`sessionStorage` | `localStorage.access_token` / `id_token`           | `fetch()` with the JWT in `Authorization`                                            |
| **Cookie session**     | No `Authorization` header in HAR; `Set-Cookie` on login                      | Browser cookie jar                                 | `playwright-cli eval` from the page (cookies attach automatically)                   |
| **Origin-validated**   | `fetch()` from Node → 401/403; same call from page works                     | n/a (server checks `Origin` header)                | `playwright-cli eval` from the page so the real origin is sent                       |
| **CSRF token**         | `X-CSRF-Token` / `X-Requested-With` on every mutating request                | `<meta name="csrf-token">`, cookie, or JS global   | Read token via `eval`, then attach to every non-GET request                          |
| **OAuth (3-legged)**   | Redirect dance, `client_id`, `code` parameter                                | Refresh token in cookie or localStorage            | Prefer a PAT; otherwise see `references/oauth-interception.md` if/when generated     |

## Decision shortcut

1. Try `fetch()` with whatever credential you found in `localStorage`.
2. If `401`/`403` and the response sets/checks a cookie, switch to page-context `eval`.
3. If the server rejects on `Origin`, switch to page-context `eval`.
4. If none of these work, ask the user for a PAT and document the steps to create one.

## Storing credentials

```
/workspace/skills/{app-name}/.config        # one KEY=value per line, gitignored
```

Read them from `.jsh` via `process.env` after sourcing, or via `exec('cat .config')`.

## Bot detection notes

Some apps (Cloudflare Turnstile, hCaptcha, custom JS challenges) block direct
`fetch()` even with valid cookies. Always fall back to page-context `eval` — the
browser has already passed the challenge.

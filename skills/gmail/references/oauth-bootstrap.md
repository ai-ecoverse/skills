# Signing in to Gmail with jerk

`gmail` gets its token from, in order: the `GWS_CLIENT_ID`, `GWS_CLIENT_SECRET`
and `GWS_REFRESH_TOKEN` environment variables, then `jerk gmail get --reveal`,
then the legacy skill config (see `SKILL.md`). If your organization already
provisions the `GWS_*` values, use them and skip this file. Otherwise sign in
once with jerk.

## Sign in

```bash
gmail login            # runs: jerk gmail create
gmail auth             # source: jerk, the account, the scope
```

[jerk](https://github.com/ai-ecoverse/slicc-jerk) (`@ai-ecoverse/slicc-jerk`,
`npm i -g @ai-ecoverse/slicc-jerk` on a host) has a built-in `gmail` provider.
`jerk config show gmail` prints it:

- Mozilla Thunderbird's public desktop OAuth client. Google verified it for
  Gmail's restricted scopes; the Google Cloud SDK's client isn't, so the
  `gcloud` skill's client is not reused. Override it with `GWS_CLIENT_ID` and
  `GWS_CLIENT_SECRET`.
- Scope `https://mail.google.com/`, which allows reading, sending and deleting.
- Loopback redirect with **PKCE** and `access_type=offline`, so an authorization
  code that leaks before the exchange is not enough to redeem it.
- Token variable `GWS_ACCESS_TOKEN`, refresh variable `GWS_REFRESH_TOKEN`.

`gmail login` passes jerk's exit code through:

| exit | meaning |
|------|---------|
| 0 | signed in |
| 3 | a sign-in is needed that can't happen here |
| 4 | not available: jerk missing, no browser, no linked slicc CLI |
| 1, 2, 5 | an error, a usage refusal, or unsupported here |

`gmail login --force` signs in again. `jerk gmail drop` revokes the grant at
Google and forgets it; `gmail logout` only clears the legacy skill config.

## Where the token lives

- **SLICC 7.** jerk keeps the grant in the vault. `jerk gmail get` prints a
  placeholder, and the vault swaps in the real token when the request goes to
  Google's domains. The refresh token never reaches the agent or the realm.
- **macOS and Linux.** jerk keeps the grant in the OS keyring (service
  `slicc-jerk`), or in a 0600 file with `store = "file"`. `gmail` asks for it
  with `--reveal`, because jerk masks a token it prints into a pipe.

`gmail` never prints a token. A masked answer (one containing `…`) is not used.

## Legacy paths, still read

- **`GWS_*` environment variables.** All three must be set. They win over jerk.
- **Skill config.** An earlier `gmail login` stored `client_id`,
  `client_secret`, `refresh_token` and a cached access token in the skill
  config, and `gmail login --from-file creds.json` still imports a set of
  credentials into it after validating them against Google. The config is read
  last, after jerk. The old flow, `oauth-token --intercept` with a fixed
  loopback port and no PKCE, is gone: `oauth-token` isn't a command in SLICC 7.

If Google revokes or rotates the Thunderbird client, jerk's provider has to
change, not this skill. Its source is the `kIssuers` entry for
`accounts.google.com` in
`https://hg.mozilla.org/comm-central/raw-file/tip/mailnews/base/src/OAuth2Providers.sys.mjs`.

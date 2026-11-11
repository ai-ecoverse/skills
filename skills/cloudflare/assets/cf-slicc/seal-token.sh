#!/bin/sh
# Mint a read-only Cloudflare API token with the logged-in cf, seal it in SLICC's
# vault without printing it, grant it to the cf binary only, then log cf out.
#
# Usage: sh seal-token.sh [--dry-run] [--days N] [--name NAME]
# Needs: `cf auth login` done first (OAuth device flow), and sudo approvals.
set -e
DRY=; DAYS=90; NAME="slicc cf CLI (read-only)"
while [ $# -gt 0 ]; do case "$1" in
  --dry-run) DRY=1 ;; --days) DAYS=$2; shift ;; --name) NAME=$2; shift ;;
  *) echo "unknown option $1" >&2; exit 2 ;; esac; shift; done
CF=${CF:-"/usr/bin/node /usr/local/lib/cf-slicc/bin/cf"}   # bypass the wrapper: use the OAuth login
W=$(mktemp -d 2>/dev/null || { d="$HOME/tmp/seal-$$"; mkdir -p "$d"; echo "$d"; })

$CF auth whoami > "$W/me.json"
$CF user get 2>/dev/null > "$W/user.json"
$CF user tokens permission-groups list 2>/dev/null > "$W/pg.json"
EPOCH=$(date +%s); EXP=$(date -u -d "@$((EPOCH + DAYS * 86400))" +%Y-%m-%dT%H:%M:%SZ)
node -e '
const fs = require("fs"), [W, name, exp] = process.argv.slice(1);
const me = JSON.parse(fs.readFileSync(W + "/me.json", "utf8"));
const user = JSON.parse(fs.readFileSync(W + "/user.json", "utf8"));
const pg = JSON.parse(fs.readFileSync(W + "/pg.json", "utf8")).filter(g => / Read$/.test(g.name));
const by = s => pg.filter(g => g.scopes.includes(s)).map(g => ({ id: g.id }));
const A = {}, Z = {};
for (const a of me.accounts) { A["com.cloudflare.api.account." + a.id] = "*"; Z["com.cloudflare.api.account." + a.id] = { "com.cloudflare.api.account.zone.*": "*" }; }
const policies = [
  { effect: "allow", permission_groups: by("com.cloudflare.api.account"), resources: A },
  { effect: "allow", permission_groups: by("com.cloudflare.api.account.zone"), resources: Z },
  { effect: "allow", permission_groups: by("com.cloudflare.api.user"), resources: { ["com.cloudflare.api.user." + user.id]: "*" } },
].filter(p => p.permission_groups.length);
fs.writeFileSync(W + "/body.json", JSON.stringify({ name, expires_on: exp, policies }));
console.error(`token "${name}": ${policies.map(p => p.permission_groups.length).join(" + ")} read permission groups on ${me.accounts.map(a => a.name).join(", ")}, expires ${exp}`);
' "$W" "$NAME" "$EXP"
[ -n "$(jq -r '.id // empty' "$W/user.json")" ] || { echo "cf user get returned no user id; run cf auth login" >&2; exit 1; }

GRANT='CLOUDFLARE_API_TOKEN = { argv = [["/usr/bin/node", "/usr/local/lib/cf-slicc/bin/cf"]] }'
if [ -n "$DRY" ]; then
  $CF user tokens create --body "@$W/body.json" --dry-run | jq '{method, url, name: .body.name, expires_on: .body.expires_on}'
  echo "would add to /etc/slicc/secrets-policy.toml [exec]: $GRANT"
  rm -rf "$W"; exit 0
fi

# The value goes straight from cf's stdout into the vault; it is never printed or written.
$CF user tokens create --body "@$W/body.json" 2>/dev/null | jq -j '.value // empty' \
  | sudo fnox set CLOUDFLARE_API_TOKEN --global -d "$NAME, expires $EXP"
rm -rf "$W"

P=/etc/slicc/secrets-policy.toml
if ! sudo grep -q '^CLOUDFLARE_API_TOKEN *=' "$P" 2>/dev/null; then
  if sudo grep -q '^\[exec\]' "$P" 2>/dev/null; then
    sudo sed -i "/^\[exec\]/a $GRANT" "$P"
  else
    printf '\n[exec]\n%s\n' "$GRANT" | sudo tee -a "$P" >/dev/null
  fi
fi
sealed list | grep CLOUDFLARE_API_TOKEN
$CF auth logout >/dev/null 2>&1 || true   # drop the on-disk OAuth access + refresh token
cf auth whoami | jq -c '{authenticated, authSource, email}'

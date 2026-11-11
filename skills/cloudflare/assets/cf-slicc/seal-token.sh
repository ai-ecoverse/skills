#!/bin/sh
# Seals a read-only cf token in the vault (see SKILL.md, step 3).
# Usage: sh seal-token.sh [--dry-run] [--days N] [--name NAME]
set -e
DRY=; DAYS=90; NAME="slicc cf CLI (read-only)"
while [ $# -gt 0 ]; do case "$1" in
  --dry-run) DRY=1 ;; --days) DAYS=$2; shift ;; --name) NAME=$2; shift ;;
  *) echo "unknown option $1" >&2; exit 2 ;; esac; shift; done
HERE=$(cd "$(dirname "$0")" && pwd)
CF=${CF:-"/usr/bin/node /usr/local/lib/cf-slicc/bin/cf"}
POLICY=${SECRETS_POLICY:-/etc/slicc/secrets-policy.toml}
GRANT='{ argv = [["/usr/bin/node", "/usr/local/lib/cf-slicc/bin/cf"]] }'
W="$HOME/.cache/seal-token-$$"
mkdir -p "$W"
trap_rm() { rm -rf "$W"; }
jget() { node -e 'let d; try { d = JSON.parse(require("fs").readFileSync(0, "utf8")); } catch { d = null; } for (const k of process.argv[1].split(".")) d = d == null ? d : d[k]; process.stdout.write(d == null ? "" : typeof d === "object" ? JSON.stringify(d) : String(d));' "$1"; }

$CF auth whoami > "$W/me.json"
$CF user get > "$W/user.json" 2>/dev/null || true
[ -n "$(jget id < "$W/user.json")" ] || { trap_rm; echo "seal-token: cf user get returned no user id; run cf auth login" >&2; exit 1; }
$CF user tokens permission-groups list > "$W/pg.json" 2>/dev/null
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
if (!policies.length) { console.error("seal-token: no Read permission groups found"); process.exit(1); }
fs.writeFileSync(W + "/body.json", JSON.stringify({ name, expires_on: exp, policies }));
console.error(`token "${name}": ${policies.map(p => p.permission_groups.length).join(" + ")} read permission groups on ${me.accounts.map(a => a.name).join(", ")}, expires ${exp}`);
' "$W" "$NAME" "$EXP" || { trap_rm; exit 1; }

if [ -n "$DRY" ]; then
  $CF user tokens create --body "@$W/body.json" --dry-run | jget url
  echo
  echo "would set in $POLICY [exec]: CLOUDFLARE_API_TOKEN = $GRANT"
  trap_rm; exit 0
fi

sudo cat "$POLICY" 2>/dev/null | node "$HERE/exec-grant.mjs" CLOUDFLARE_API_TOKEN "$GRANT" > "$W/policy.toml" \
  || { trap_rm; echo "seal-token: could not prepare $POLICY; nothing was created" >&2; exit 1; }

TOKEN=$($CF user tokens create --body "@$W/body.json" | jget value) || TOKEN=
if [ -z "$TOKEN" ]; then
  trap_rm; echo "seal-token: cf user tokens create returned no token; nothing was sealed and cf is still logged in" >&2; exit 1
fi
if ! printf '%s' "$TOKEN" | sudo fnox set CLOUDFLARE_API_TOKEN --global -d "$NAME, expires $EXP"; then
  TOKEN=; trap_rm
  echo "seal-token: fnox set failed; delete the new token \"$NAME\" with cf user tokens list / delete" >&2; exit 1
fi
TOKEN=

sudo tee "$POLICY" < "$W/policy.toml" > /dev/null
trap_rm
sealed placeholder CLOUDFLARE_API_TOKEN
$CF auth logout > /dev/null 2>&1 || true

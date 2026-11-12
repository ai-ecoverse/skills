#!/bin/sh
# Seals a gcloud credential JSON in the vault as GCLOUD_CREDENTIALS, base64-encoded,
# grants it to run.py only, and shreds the file (SKILL.md, "Service-account keys").
# Usage: sh seal-key.sh [--dry-run] [--keep] KEY.json
set -e
DRY=; KEEP=; KEY=
while [ $# -gt 0 ]; do case "$1" in
  --dry-run) DRY=1 ;; --keep) KEEP=1 ;; -*) echo "unknown option $1" >&2; exit 2 ;; *) KEY=$1 ;; esac; shift; done
[ -n "$KEY" ] && [ -f "$KEY" ] || { echo "usage: sh seal-key.sh [--dry-run] [--keep] KEY.json" >&2; exit 2; }
HERE=$(cd "$(dirname "$0")" && pwd)
POLICY=${SECRETS_POLICY:-/etc/slicc/secrets-policy.toml}
GRANT='{ argv = [["/usr/bin/python3", "-I", "/usr/local/lib/gcloud-sealed/run.py"]] }'
DESC=$(node -e '
let k; try { k = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")); } catch { process.exit(3); }
if (k.type === "service_account" && k.client_email && k.private_key) console.log("gcloud key for " + k.client_email + " (" + String(k.private_key_id || "").slice(0, 8) + "), base64");
else if (k.type === "authorized_user" && k.refresh_token) console.log("gcloud authorized_user credential, base64");
else process.exit(4);' "$KEY") || { echo "seal-key: $KEY is not a service-account key or authorized_user credential JSON" >&2; exit 1; }
W="$HOME/.cache/seal-key-$$"
mkdir -p "$W"
if [ -r "$POLICY" ]; then
  cat "$POLICY" > "$W/policy.old" || { rm -rf "$W"; echo "seal-key: could not read $POLICY; nothing was sealed" >&2; exit 1; }
elif [ -e "$POLICY" ]; then
  rm -rf "$W"; echo "seal-key: could not read $POLICY; nothing was sealed" >&2; exit 1
else
  : > "$W/policy.old"
fi
node "$HERE/exec-grant.mjs" GCLOUD_CREDENTIALS "$GRANT" < "$W/policy.old" > "$W/policy.toml" \
  || { rm -rf "$W"; echo "seal-key: could not prepare $POLICY; nothing was sealed" >&2; exit 1; }
if [ -n "$DRY" ]; then
  echo "would seal GCLOUD_CREDENTIALS: $DESC"
  echo "would set in $POLICY [exec]: GCLOUD_CREDENTIALS = $GRANT"
  rm -rf "$W"; exit 0
fi
if ! base64 -w0 "$KEY" | sudo sh -c 'fnox set GCLOUD_CREDENTIALS --global -d "$1" || exit 9; cat "$2" > "$3"' seal-key "$DESC" "$W/policy.toml" "$POLICY"; then
  rm -rf "$W"; echo "seal-key: fnox set or the policy write failed; $KEY is untouched (check sealed list)" >&2; exit 1
fi
rm -rf "$W"
[ -n "$KEEP" ] || shred -u "$KEY" 2>/dev/null || rm -f "$KEY"
echo "sealed GCLOUD_CREDENTIALS: $DESC"

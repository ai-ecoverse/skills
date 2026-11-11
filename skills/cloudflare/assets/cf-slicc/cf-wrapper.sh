#!/bin/sh
CF_LIB=${CF_LIB:-/usr/local/lib/cf-slicc}
if sealed placeholder CLOUDFLARE_API_TOKEN >/dev/null 2>&1; then
  exec fnox exec -- /usr/bin/node "$CF_LIB/bin/cf" "$@"
fi
exec /usr/bin/node "$CF_LIB/bin/cf" "$@"

#!/bin/sh
# Build Cloudflare's cf CLI from source for SLICC and install it as `cf`.
#
# Why not `pnpm add -g cf`: the published bundle trips two slicc-jsh bugs.
#   ai-ecoverse/slicc-jsh#1269  minified for-loop/rest bindings resolve to imports -> crash on load
#   ai-ecoverse/slicc-jsh#1270  undici fetch over https exits mid-body -> `cf auth login` dies
# esbuild output avoids the first; aliasing `undici` to global fetch (undici-shim.mjs) avoids the second.
#
# Usage: sh build.sh [<cf source dir>]   (default ~/src/cf, cloned if missing)
# Installs: /usr/local/lib/cf-slicc (root-owned, what the vault's [exec] grant names)
#           /usr/local/bin/cf       (wrapper; uses fnox exec once CLOUDFLARE_API_TOKEN is sealed)
set -e
HERE=$(cd "$(dirname "$0")" && pwd)
SRC=${1:-$HOME/src/cf}
OUT=$HOME/.cache/cf-slicc
LIB=/usr/local/lib/cf-slicc
export npm_config_manage_package_manager_versions=false

[ -d "$SRC/.git" ] || git clone --depth 1 https://github.com/cloudflare/cf "$SRC"
[ -d "$SRC/node_modules/@cloudflare/workers-auth" ] || (cd "$SRC" && pnpm install --ignore-scripts)
command -v esbuild >/dev/null || pnpm add -g @ai-ecoverse/wasi-esbuild

rm -rf "$OUT" && mkdir -p "$OUT/bin"
cd "$SRC/packages/cli"
esbuild index=src/index.ts delegate=src/lib/delegate.ts --bundle --splitting \
  --chunk-names='chunks/[name]-[hash]' --platform=node --format=esm --target=node22 \
  --outdir="$OUT/dist" --out-extension:.js=.mjs --alias:undici="$HERE/undici-shim.mjs" \
  --external:blake3-wasm --external:miniflare --external:vite --external:@cloudflare/vite-plugin \
  --external:cloudflare:workers --define:process.env.SPARROW_SOURCE_KEY='""' \
  --banner:js='import{createRequire as __cr}from"node:module";const require=__cr(import.meta.url);' \
  --loader:.wasm=file --log-level=warning
# loadMeta() looks for _meta/ next to the calling chunk
cp -r src/commands/_generated/_meta "$OUT/dist/_meta"
cp -r src/commands/_generated/_meta "$OUT/dist/chunks/_meta"
cp bin/cf "$OUT/bin/cf"
printf '{"name":"cf","version":"%s","type":"module"}\n' "$(jq -r .version package.json)" > "$OUT/package.json"

cat > "$OUT/cf" <<'WRAP'
#!/bin/sh
# cf for SLICC. Once CLOUDFLARE_API_TOKEN is sealed with an [exec] grant, the vault
# hands the real token to this exact argv only; otherwise cf uses its own login.
if sealed placeholder CLOUDFLARE_API_TOKEN >/dev/null 2>&1; then
  exec fnox exec -- /usr/bin/node /usr/local/lib/cf-slicc/bin/cf "$@"
fi
exec /usr/bin/node /usr/local/lib/cf-slicc/bin/cf "$@"
WRAP

# Root-owned and not writable by others: the vault refuses an [exec] grant for a
# program a non-root user could change.
sudo sh -c "rm -rf $LIB && mkdir -p $LIB && cp -r '$OUT/dist' '$OUT/bin' '$OUT/package.json' $LIB/ \
  && cp '$OUT/cf' /usr/local/bin/cf && chown -R 0:0 $LIB /usr/local/bin/cf \
  && chmod 755 /usr/local/lib && find $LIB -type d -exec chmod 755 {} + \
  && find $LIB -type f -exec chmod 644 {} + && chmod 755 $LIB/bin/cf /usr/local/bin/cf"
rm -rf "$OUT"
/usr/local/bin/cf --version

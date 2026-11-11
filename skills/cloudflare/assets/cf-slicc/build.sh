#!/bin/sh
# Builds cf for SLICC (see SKILL.md, step 1). Usage: sh build.sh [<cf source dir>]
set -e
HERE=$(cd "$(dirname "$0")" && pwd)
SRC=${1:-$HOME/src/cf}
REV=${CF_REV:-54749e62bfc3882f418d96f56506a12df8045bf6}
OUT=$HOME/.cache/cf-slicc
LIB=/usr/local/lib/cf-slicc
export npm_config_manage_package_manager_versions=false

if [ ! -d "$SRC/.git" ]; then
  git init -q "$SRC"
  git -C "$SRC" remote add origin https://github.com/cloudflare/cf
fi
if [ "$(git -C "$SRC" rev-parse HEAD 2>/dev/null)" != "$REV" ]; then
  git -C "$SRC" fetch -q --depth 1 origin "$REV"
  git -C "$SRC" checkout -q "$REV"
fi
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
cp -r src/commands/_generated/_meta "$OUT/dist/_meta"
cp -r src/commands/_generated/_meta "$OUT/dist/chunks/_meta"
cp bin/cf "$OUT/bin/cf"
printf '{"name":"cf","version":"%s","type":"module"}\n' "$(node -p 'require("./package.json").version')" > "$OUT/package.json"

sudo sh -c "rm -rf $LIB && mkdir -p $LIB && cp -r '$OUT/dist' '$OUT/bin' '$OUT/package.json' $LIB/ \
  && cp '$HERE/cf-wrapper.sh' /usr/local/bin/cf && chown -R 0:0 $LIB /usr/local/bin/cf \
  && chmod 755 /usr/local/lib && find $LIB -type d -exec chmod 755 {} + \
  && find $LIB -type f -exec chmod 644 {} + && chmod 755 $LIB/bin/cf /usr/local/bin/cf"
rm -rf "$OUT"
/usr/local/bin/cf --version

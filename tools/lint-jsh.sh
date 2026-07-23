#!/usr/bin/env bash
#
# Lint the repo's `.jsh` / `.bsh` skill scripts with Biome.
#
# Biome's CLI recognises files by extension: in file mode it silently ignores
# `.jsh`/`.bsh`, and in stdin mode it emits no diagnostics. So we mirror each
# script to a temporary `.js` file and lint those with the repo's biome.json
# (passed via --config-path). The SLICC biome shim already treats `.jsh`/`.bsh`
# as JavaScript; once the Biome CLI does too, this reduces to `biome check .`.
#
# Exit code is Biome's: non-zero if any error-level diagnostic is found.
set -uo pipefail

repo_root="$(cd "$(dirname "$0")/.." && pwd)"
cd "$repo_root"

biome="${BIOME:-npx --no-install @biomejs/biome}"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

count=0
while IFS= read -r f; do
  # mirror path with '/' -> '@' so temp names round-trip back to real paths
  key="$(printf '%s' "$f" | tr '/' '@')"
  key="${key%.*}.js"
  cp "$f" "$tmp/$key"
  count=$((count + 1))
done < <(git ls-files '*.jsh' '*.bsh')

if [ "$count" -eq 0 ]; then
  echo "lint-jsh: no .jsh/.bsh files found"
  exit 0
fi

# Lint the mirrors with this repo's config; rewrite temp names back to real paths.
out="$($biome lint --config-path "$repo_root" "$tmp" 2>&1)"
code=$?
printf '%s\n' "$out" | sed -E "s#${tmp}/##g; s#([A-Za-z0-9._@-]+)\.js#\1#g; s#@#/#g"

if [ "$code" -eq 0 ]; then
  echo "lint-jsh: $count .jsh/.bsh file(s) clean (no error-level diagnostics)"
fi
exit "$code"

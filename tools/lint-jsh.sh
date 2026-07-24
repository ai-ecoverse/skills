#!/usr/bin/env bash
#
# Lint the repo's `.jsh` / `.bsh` skill scripts with @ai-ecoverse/biome-jsh — a
# jsh-aware Biome runner that wraps each AsyncFunction body before Biome parses
# it (so top-level `await`/`return` don't raise a false "return outside of a
# function" error), discovers this repo's biome.json, and shifts diagnostics
# back onto the real file.
#
# Scoped to `.jsh`/`.bsh`; the `.js`/`.ts` tooling is not gated here. `lint`
# (not `check`) is used deliberately — it runs only the linter, so legacy skills
# are not failed on formatting.
#
# Exit code is biome-jsh's: non-zero if any error-level diagnostic is found.
set -uo pipefail

cd "$(dirname "$0")/.."

# Collect .jsh/.bsh, skipping files Biome ignores anyway. Biome's default
# maxSize is 1 MiB; larger files (e.g. generated bundles like xlsx.jsh) are
# silently skipped by Biome, so exclude them here rather than have the per-file
# runner report them as unprocessable. The ${#arr[@]} guard keeps an empty
# array safe under `set -u` (bash < 4.4).
max_size=1048576
files=()
while IFS= read -r f; do
  size=$(wc -c <"$f" 2>/dev/null || echo 0)
  if [ "$size" -gt "$max_size" ]; then
    echo "lint-jsh: skipping $f (${size}B > ${max_size}B Biome maxSize)" >&2
    continue
  fi
  files+=("$f")
done < <(git ls-files '*.jsh' '*.bsh')
if [ "${#files[@]}" -eq 0 ]; then
  echo "lint-jsh: no .jsh/.bsh files found"
  exit 0
fi

# BIOME_JSH overrides the runner (e.g. a local checkout) for testing.
biomejsh="${BIOME_JSH:-npx --no-install @ai-ecoverse/biome-jsh}"
# shellcheck disable=SC2086
exec $biomejsh lint "${files[@]}"

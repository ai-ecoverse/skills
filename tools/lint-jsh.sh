#!/usr/bin/env bash
#
# Lint the repo's `.jsh` / `.bsh` skill scripts with @ai-ecoverse/biome-jsh — a
# jsh-aware Biome runner that wraps each AsyncFunction body before Biome parses
# it (so top-level `await`/`return` don't raise a false "return outside of a
# function" error), discovers this repo's biome.json, and shifts diagnostics
# back onto the real file.
#
# Scoped to jsh scripts: `.jsh`/`.bsh`, and extensionless files with a jsh
# hashbang (the list comes from tools/check-jsh-parse.mjs --list, so both
# checks see the same files). biome-jsh picks its wrapper by extension, so an
# extensionless script is linted through a `.jsh` copy next to it and the
# copy's path is mapped back in the output. The `.js`/`.ts` tooling is not gated here. `lint`
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
done < <(node tools/check-jsh-parse.mjs --list)
if [ "${#files[@]}" -eq 0 ]; then
  echo "lint-jsh: no jsh scripts found" >&2
  exit 1
fi

# BIOME_JSH overrides the runner (e.g. a local checkout) for testing.
biomejsh="${BIOME_JSH:-npx --no-install @ai-ecoverse/biome-jsh}"

# Extensionless scripts: lint a `.lint-jsh-<name>.jsh` copy beside each one.
copies=()
sed_args=()
targets=()
cleanup() { [ "${#copies[@]}" -eq 0 ] || rm -f "${copies[@]}"; }
trap cleanup EXIT
for f in "${files[@]}"; do
  case "$f" in
    *.jsh | *.bsh) targets+=("$f") ;;
    *)
      copy="$(dirname "$f")/.lint-jsh-$(basename "$f").jsh"
      cp "$f" "$copy"
      copies+=("$copy")
      targets+=("$copy")
      sed_args+=(-e "s|$copy|$f|g")
      ;;
  esac
done

if [ "${#copies[@]}" -eq 0 ]; then
  # shellcheck disable=SC2086
  $biomejsh lint "${targets[@]}"
  exit $?
fi
# shellcheck disable=SC2086
$biomejsh lint "${targets[@]}" 2>&1 | sed "${sed_args[@]}"
exit "${PIPESTATUS[0]}"

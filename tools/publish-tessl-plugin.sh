#!/usr/bin/env bash
set -euo pipefail

PLUGIN=${1:?usage: publish-tessl-plugin.sh PLUGIN BUMP [FLOOR]}
BUMP=${2:?usage: publish-tessl-plugin.sh PLUGIN BUMP [FLOOR]}
FLOOR=${3:-}
SEMVER='^[0-9]+\.[0-9]+\.[0-9]+$'

case "$PLUGIN" in
  basic|advanced) ;;
  *) echo "unsupported plugin: $PLUGIN" >&2; exit 2 ;;
esac
case "$BUMP" in
  patch|minor|major) ;;
  *) echo "unsupported bump: $BUMP" >&2; exit 2 ;;
esac
if [[ -n "$FLOOR" && ! "$FLOOR" =~ $SEMVER ]]; then
  echo "unsupported floor: $FLOOR" >&2
  exit 2
fi

REPO_ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
SOURCE_MANIFEST="$REPO_ROOT/tiles/$PLUGIN/.tessl-plugin/plugin.json"
STAGE_ROOT=$(mktemp -d)
SOURCE_TMP=
cleanup() {
  rm -rf "$STAGE_ROOT"
  if [[ -n "$SOURCE_TMP" ]]; then rm -f "$SOURCE_TMP"; fi
}
trap cleanup EXIT

next_version() {
  local major minor patch
  IFS=. read -r major minor patch <<< "$1"
  case "$2" in
    major) echo "$((major + 1)).0.0" ;;
    minor) echo "$major.$((minor + 1)).0" ;;
    patch) echo "$major.$minor.$((patch + 1))" ;;
  esac
}

newest() {
  printf '%s\n' "$@" | grep -E "$SEMVER" | sort -V | tail -1
}

published() {
  local found
  found=$(tessl plugin info --json "$NAME@$1" 2>/dev/null | jq -r '.version.version // empty' 2>/dev/null) || return 1
  [[ "$found" == "$1" ]]
}

STAGED_PLUGIN="$STAGE_ROOT/$PLUGIN"
STAGED_MANIFEST="$STAGED_PLUGIN/.tessl-plugin/plugin.json"
bash "$REPO_ROOT/tools/expect-verdict.sh" stage-tessl-plugin \
  node "$REPO_ROOT/tools/stage-tessl-plugin.mjs" "$PLUGIN" "$STAGED_PLUGIN"

NAME=$(jq -er .name "$STAGED_MANIFEST")
LATEST=$(tessl plugin info --json "$NAME" 2>/dev/null | jq -r '.tile.latestVersion // empty' 2>/dev/null || true)
BASE=$(newest "$(jq -er .version "$STAGED_MANIFEST")" "$FLOOR" "$LATEST")

climbed=0
while :; do
  step=
  for kind in major minor patch; do
    if published "$(next_version "$BASE" "$kind")"; then
      step=$kind
      break
    fi
  done
  [[ -n "$step" ]] || break
  BASE=$(next_version "$BASE" "$step")
  climbed=$((climbed + 1))
  if (( climbed >= 200 )); then
    echo "gave up after 200 published versions above the manifest, at $BASE" >&2
    exit 1
  fi
done

VERSION=$(next_version "$BASE" "$BUMP")
if published "$VERSION"; then
  echo "$NAME@$VERSION is already published" >&2
  exit 1
fi
STAGED_TMP="$STAGE_ROOT/plugin.json"
jq --arg version "$VERSION" '.version = $version' "$STAGED_MANIFEST" > "$STAGED_TMP"
mv "$STAGED_TMP" "$STAGED_MANIFEST"

echo "Publishing $NAME@$VERSION ($BUMP above $BASE, the highest published version found)"
ATTEMPTS=${TESSL_PUBLISH_ATTEMPTS:-3}
WAIT=${TESSL_PUBLISH_WAIT:-10}
landed=0
for attempt in $(seq 1 "$ATTEMPTS"); do
  status=0
  tessl plugin publish "$STAGED_PLUGIN" || status=$?
  if [[ "$status" -eq 0 ]]; then
    landed=1
    break
  fi
  for _ in 1 2 3 4 5 6; do
    if published "$VERSION"; then
      echo "$NAME@$VERSION is in the registry although publish exited $status"
      landed=1
      break 2
    fi
    sleep "$WAIT"
  done
  echo "publish attempt $attempt of $ATTEMPTS failed with $status and $NAME@$VERSION is not in the registry" >&2
  [[ "$attempt" -lt "$ATTEMPTS" ]] || exit "$status"
done
[[ "$landed" -eq 1 ]] || exit 1

PUBLISHED_VERSION=$(jq -er '.version | strings | select(test("^[0-9]+\\.[0-9]+\\.[0-9]+(?:-[0-9A-Za-z.-]+)?$"))' "$STAGED_MANIFEST")
SOURCE_TMP=$(mktemp "$SOURCE_MANIFEST.tmp.XXXXXX")
jq --arg version "$PUBLISHED_VERSION" '.version = $version' "$SOURCE_MANIFEST" > "$SOURCE_TMP"
mv "$SOURCE_TMP" "$SOURCE_MANIFEST"
SOURCE_TMP=

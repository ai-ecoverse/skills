#!/usr/bin/env bash
set -euo pipefail

PLUGIN=${1:?usage: publish-tessl-plugin.sh PLUGIN BUMP}
BUMP=${2:?usage: publish-tessl-plugin.sh PLUGIN BUMP}

case "$PLUGIN" in
  basic|advanced) ;;
  *) echo "unsupported plugin: $PLUGIN" >&2; exit 2 ;;
esac
case "$BUMP" in
  patch|minor|major) ;;
  *) echo "unsupported bump: $BUMP" >&2; exit 2 ;;
esac

REPO_ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
SOURCE_MANIFEST="$REPO_ROOT/tiles/$PLUGIN/.tessl-plugin/plugin.json"
STAGE_ROOT=$(mktemp -d)
SOURCE_TMP=
cleanup() {
  rm -rf "$STAGE_ROOT"
  if [[ -n "$SOURCE_TMP" ]]; then rm -f "$SOURCE_TMP"; fi
}
trap cleanup EXIT

STAGED_PLUGIN="$STAGE_ROOT/$PLUGIN"
STAGED_MANIFEST="$STAGED_PLUGIN/.tessl-plugin/plugin.json"
node "$REPO_ROOT/tools/stage-tessl-plugin.mjs" "$PLUGIN" "$STAGED_PLUGIN"

NAME=$(jq -er .name "$STAGED_MANIFEST")
echo "Publishing $NAME with collision-aware $BUMP bumping"
tessl plugin publish --bump "$BUMP" "$STAGED_PLUGIN"

PUBLISHED_VERSION=$(jq -er '.version | strings | select(test("^[0-9]+\\.[0-9]+\\.[0-9]+(?:-[0-9A-Za-z.-]+)?$"))' "$STAGED_MANIFEST")
SOURCE_TMP=$(mktemp "$SOURCE_MANIFEST.tmp.XXXXXX")
jq --arg version "$PUBLISHED_VERSION" '.version = $version' "$SOURCE_MANIFEST" > "$SOURCE_TMP"
mv "$SOURCE_TMP" "$SOURCE_MANIFEST"
SOURCE_TMP=
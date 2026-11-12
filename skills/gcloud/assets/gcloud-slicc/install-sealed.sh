#!/bin/sh
# Installs a root-owned copy of gcloud for vault-sealed credentials (SKILL.md, "Service-account keys").
# Usage: sh install-sealed.sh [SOURCE_PACKAGE_DIR]
set -e
HERE=$(cd "$(dirname "$0")" && pwd)
SRC=${1:-${GCLOUD_CLI_DIR:-$(pnpm root -g)/@ai-ecoverse/gcloud-cli}}
SRC=$(readlink -f "$SRC")
[ -f "$SRC/bin/gcloud" ] || { echo "install-sealed: no gcloud in $SRC; run pnpm add -g @ai-ecoverse/gcloud-cli first" >&2; exit 1; }
LIB=${GCLOUD_LIB:-/usr/local/lib/gcloud-cli}
RUN=${GCLOUD_SEALED:-/usr/local/lib/gcloud-sealed}
BIN=${GCLOUD_BIN:-/usr/local/bin}
sudo sh -c "set -e
rm -rf '$LIB.tmp'
cp -R '$SRC' '$LIB.tmp'
chown -R 0:0 '$LIB.tmp'
chmod -R u+rwX,go+rX,go-w '$LIB.tmp'
rm -rf '$LIB'
mv '$LIB.tmp' '$LIB'
mkdir -p '$RUN' '$BIN'
install -o 0 -g 0 -m 0755 '$HERE/run.py' '$RUN/run.py'
install -o 0 -g 0 -m 0755 '$HERE/gcloud-sealed' '$BIN/gcloud-sealed'
install -o 0 -g 0 -m 0755 '$HERE/bq-sealed' '$BIN/bq-sealed'"
echo "installed $LIB, $RUN/run.py, $BIN/gcloud-sealed and $BIN/bq-sealed"

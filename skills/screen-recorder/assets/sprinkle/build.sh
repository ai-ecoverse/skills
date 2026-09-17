#!/bin/sh
# Build the recording-setup sprinkle's inline JS bundle.
#
#   sh /shared/sprinkles/recording-setup/build.sh
#
# Bundles src/entry.js (which imports chunk-flusher.js IN PLACE from the
# interview-me skill) into a single IIFE, then splices it into the
# @@FLUSHER_BUNDLE@@ / generated-block region of recording-setup.shtml.
#
# WHY INLINE: a full-document sprinkle renders in an `about:srcdoc` iframe whose
# base URI inherits the parent frame's URL, so external JS cannot be loaded --
# every specifier resolves against the SLICC app shell and returns index.html
# with HTTP 200 and the wrong body. See
# /workspace/skills/interview-me/references/sprinkle-module-loading.md.
#
# WHY IIFE: keeps the bundle's internals (including chunk-flusher's own
# top-level `sleep`) inside a closure, so they cannot collide with the
# sprinkle's own top-level declarations. Hand-inlining the module once caused
# exactly that collision: "Identifier 'sleep' has already been declared".
#
# NOT minified on purpose: a readable bundle is far easier to debug and size is
# irrelevant for a local sprinkle.
#
# The <script> block in the .shtml is BUILD OUTPUT. Do not hand-edit it --
# edit src/*.js and re-run this script.
set -e
DIR=$(dirname "$0")
cd "$DIR"
esbuild src/entry.js --bundle --format=iife --outfile=src/bundle.js
echo "built src/bundle.js ($(wc -c < src/bundle.js) bytes)"
node splice.js

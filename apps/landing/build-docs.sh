#!/bin/bash
# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at https://mozilla.org/MPL/2.0/.
#
# Vercel build for the ifclite.dev project (root directory: apps/landing).
# Assembles the deployed site into dist/:
#   dist/        <- the static landing page (this directory, as-is)
#   dist/docs/   <- the mkdocs site built from ../../mkdocs.yml
#
# The project has "include source files outside of the root directory"
# enabled, so ../../docs and ../../mkdocs.yml are present in the build
# container. Python 3 is available in the Vercel build image; the docs
# requirements are pure-Python (mkdocs-material and two plugins).
#
# Locally: bash apps/landing/build-docs.sh (from anywhere) then serve
# apps/landing/dist.

set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
DIST="$HERE/dist"

rm -rf "$DIST"
mkdir -p "$DIST"

# 1. Static landing files. Exclude the build outputs and this script;
#    vercel.json is read from the source dir by Vercel, not served.
(
  cd "$HERE"
  for f in *; do
    case "$f" in
      dist | build-docs.sh | node_modules | .vercel) continue ;;
    esac
    cp -R "$f" "$DIST/$f"
  done
)

# 2. Docs. The Vercel build image's system Python is externally managed
#    (PEP 668), so installs go into a throwaway venv.
VENV="$HERE/.venv-docs"
python3 -m venv "$VENV"
"$VENV/bin/pip" install --quiet --disable-pip-version-check -r "$ROOT/requirements-docs.txt"
"$VENV/bin/python" -m mkdocs build --strict -f "$ROOT/mkdocs.yml" -d "$DIST/docs"

echo "Built landing + docs into $DIST ($(du -sh "$DIST" | cut -f1))"

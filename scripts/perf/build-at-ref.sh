#!/usr/bin/env bash
# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at https://mozilla.org/MPL/2.0/.
#
# Build one cargo example of ifc-lite-processing at a git ref, in a throwaway
# worktree, and copy the binary out. Shared by ab.sh (base side) and
# instructions-replay.mjs (historical commits).
#
#   scripts/perf/build-at-ref.sh --ref <ref> --out <binary-path> [options]
#
# Options:
#   --example <name>      example to build (default perf_probe)
#   --inject <src>=<rel>  copy <src> into the worktree at <rel> before building
#                         (repeatable; e.g. a driver example the ref lacks)
#   --patch <file>        `git apply --unidiff-zero` <file> in the worktree
#                         first (rejected candidates kept only as patches)
#   --target-dir <dir>    CARGO_TARGET_DIR (default: a fresh one next to the
#                         worktree, removed afterwards). A shared directory
#                         reuses dependency builds across refs; the binary is
#                         copied out before the next build can overwrite it.
#   --worktree-root <dir> where the worktree is created (default $TMPDIR)
#   --log <file>          append the build log here instead of stderr
#
# The worktree is removed on exit, success or not. Exit 1 if the patch does
# not apply or the build fails; the cause is in the log.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
[ -f "$HOME/.cargo/env" ] && source "$HOME/.cargo/env"

REF=""
OUT=""
EXAMPLE="perf_probe"
INJECT=()
PATCH=""
TARGET_DIR=""
WT_ROOT="${TMPDIR:-/tmp}"
LOG=""
while [ $# -gt 0 ]; do
  case "$1" in
    --ref) REF="${2:?--ref needs a ref}"; shift 2;;
    --out) OUT="${2:?--out needs a path}"; shift 2;;
    --example) EXAMPLE="${2:?--example needs a name}"; shift 2;;
    --inject) INJECT+=("${2:?--inject needs src=rel}"); shift 2;;
    --patch) PATCH="${2:?--patch needs a file}"; shift 2;;
    --target-dir) TARGET_DIR="${2:?--target-dir needs a directory}"; shift 2;;
    --worktree-root) WT_ROOT="${2:?--worktree-root needs a directory}"; shift 2;;
    --log) LOG="${2:?--log needs a file}"; shift 2;;
    -h|--help) sed -n '2,27p' "$0"; exit 0;;
    *) echo "build-at-ref.sh: unknown argument $1" >&2; exit 2;;
  esac
done
if [ -z "$REF" ] || [ -z "$OUT" ]; then
  echo "build-at-ref.sh: --ref and --out are required (see --help)" >&2
  exit 2
fi
if [ -n "$LOG" ]; then
  exec 3>>"$LOG"
else
  exec 3>&2
fi

mkdir -p "$WT_ROOT"
SCRATCH="$(mktemp -d "$WT_ROOT/ifc-build-at-ref.XXXXXX")"
WT="$SCRATCH/wt"
cleanup() {
  git -C "$ROOT" worktree remove --force "$WT" >/dev/null 2>&1 || true
  rm -rf "$SCRATCH" >/dev/null 2>&1 || true
}
trap cleanup EXIT
[ -n "$TARGET_DIR" ] || TARGET_DIR="$SCRATCH/target"

git -C "$ROOT" worktree add --detach "$WT" "$REF" >&3 2>&3
for spec in ${INJECT[@]+"${INJECT[@]}"}; do
  src="${spec%%=*}"
  rel="${spec#*=}"
  mkdir -p "$(dirname "$WT/$rel")"
  cp "$src" "$WT/$rel"
done
if [ -n "$PATCH" ]; then
  if ! git -C "$WT" apply --unidiff-zero "$PATCH" >&3 2>&3; then
    echo "build-at-ref.sh: $PATCH does not apply at $REF" >&3
    exit 1
  fi
fi
# Refs older than the `profiling` profile get today's definition, so every
# ref builds with the same optimisation and symbol settings.
if ! grep -q '^\[profile\.profiling\]' "$WT/Cargo.toml"; then
  printf '\n[profile.profiling]\ninherits = "release"\nstrip = false\ndebug = "line-tables-only"\npanic = "unwind"\n' >> "$WT/Cargo.toml"
fi
if ! ( cd "$WT" && CARGO_TARGET_DIR="$TARGET_DIR" \
    cargo build --profile profiling -p ifc-lite-processing --example "$EXAMPLE" >&3 2>&3 ); then
  echo "build-at-ref.sh: building $EXAMPLE at $REF failed" >&3
  exit 1
fi
mkdir -p "$(dirname "$OUT")"
# Copy then rename: an interrupted copy must never leave a truncated binary
# at $OUT, because callers treat an existing $OUT as a finished build.
cp "$TARGET_DIR/profiling/examples/$EXAMPLE" "$OUT.partial.$$"
mv -f "$OUT.partial.$$" "$OUT"

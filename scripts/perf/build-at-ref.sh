#!/usr/bin/env bash
# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at https://mozilla.org/MPL/2.0/.
#
# Build one cargo target at a git ref, in a throwaway worktree, and copy the
# binary out. Shared by ab.sh (base side), dm-e2e-ab.mjs (the base server) and
# instructions-replay.mjs (historical commits).
#
#   scripts/perf/build-at-ref.sh --ref <ref> --out <binary-path> [options]
#
# Options:
#   --package <name>      cargo package (default ifc-lite-processing)
#   --example <name>      example to build (default perf_probe)
#   --bin <name>          build a BINARY of --package instead of an example;
#                         mutually exclusive with --example
#   --profile <name>      cargo profile (default profiling). Only `profiling`
#                         is back-filled into older refs, so another profile
#                         must already exist at --ref.
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
#   --rustc-out <file>    write `rustc -vV`'s version line, AS RESOLVED INSIDE
#                         the worktree, here. Rustup picks the toolchain from
#                         the directory it runs in, so the ref's
#                         rust-toolchain.toml governs this build and the
#                         caller's own directory may resolve to a different
#                         compiler entirely. A harness recording provenance
#                         wants this value, not its own. Compiler overrides
#                         are refused (below), so it is also the compiler
#                         that built the binary (#10965).
#
# The worktree is removed on exit, success or not. Exit 1 if the patch does
# not apply, cargo cannot report its version or config, the build fails, or
# --rustc-out cannot record rustc -vV (cause in the log). Exit 1 too if RUSTC,
# RUSTUP_TOOLCHAIN, RUSTC_BOOTSTRAP, a rustc wrapper, or build.rustc* is in
# effect, because the binary would come from a compiler other than the ref's
# toolchain, or if a non-nightly cargo meets [unstable] config, which the
# build ignores but the check would apply. An empty wrapper, RUSTUP_TOOLCHAIN
# or RUSTC_BOOTSTRAP (or a "" wrapper in config) is no override.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
[ -f "$HOME/.cargo/env" ] && source "$HOME/.cargo/env"

REF=""
OUT=""
PACKAGE="ifc-lite-processing"
EXAMPLE="perf_probe"
BIN=""
PROFILE="profiling"
INJECT=()
PATCH=""
TARGET_DIR=""
WT_ROOT="${TMPDIR:-/tmp}"
LOG=""
RUSTC_OUT=""
while [ $# -gt 0 ]; do
  case "$1" in
    --ref) REF="${2:?--ref needs a ref}"; shift 2;;
    --out) OUT="${2:?--out needs a path}"; shift 2;;
    --package) PACKAGE="${2:?--package needs a name}"; shift 2;;
    --example) EXAMPLE="${2:?--example needs a name}"; EXPLICIT_EXAMPLE=1; shift 2;;
    --bin) BIN="${2:?--bin needs a name}"; shift 2;;
    --profile) PROFILE="${2:?--profile needs a name}"; shift 2;;
    --inject) INJECT+=("${2:?--inject needs src=rel}"); shift 2;;
    --patch) PATCH="${2:?--patch needs a file}"; shift 2;;
    --target-dir) TARGET_DIR="${2:?--target-dir needs a directory}"; shift 2;;
    --worktree-root) WT_ROOT="${2:?--worktree-root needs a directory}"; shift 2;;
    --log) LOG="${2:?--log needs a file}"; shift 2;;
    --rustc-out) RUSTC_OUT="${2:?--rustc-out needs a path}"; shift 2;;
    -h|--help) sed -n '2,47p' "$0"; exit 0;;
    *) echo "build-at-ref.sh: unknown argument $1" >&2; exit 2;;
  esac
done
if [ -z "$REF" ] || [ -z "$OUT" ]; then
  echo "build-at-ref.sh: --ref and --out are required (see --help)" >&2
  exit 2
fi
# --bin and --example name DIFFERENT cargo targets that land in different
# directories. Taking both would silently build one and copy the other.
if [ -n "$BIN" ] && [ "${EXPLICIT_EXAMPLE:-0}" = 1 ]; then
  echo "build-at-ref.sh: pass --bin or --example, not both" >&2
  exit 2
fi
if [ -n "$LOG" ]; then
  exec 3>>"$LOG"
else
  exec 3>&2
fi

# RUSTUP_TOOLCHAIN outranks the ref's rust-toolchain.toml, and RUSTC_BOOTSTRAP
# makes a stable build apply [unstable] config (PR #10977 review).
for override in RUSTC RUSTC_WRAPPER RUSTC_WORKSPACE_WRAPPER RUSTUP_TOOLCHAIN RUSTC_BOOTSTRAP \
    CARGO_BUILD_RUSTC CARGO_BUILD_RUSTC_WRAPPER CARGO_BUILD_RUSTC_WORKSPACE_WRAPPER; do
  # An empty wrapper means "no wrapper" to cargo (RUSTC_WRAPPER= skips
  # sccache), and rustup ignores an empty RUSTUP_TOOLCHAIN; an empty RUSTC is
  # an error to cargo, so refuse it here too.
  case "$override" in
    # RUSTC_WRAPPER (even empty) takes precedence over CARGO_BUILD_RUSTC_WRAPPER.
    CARGO_BUILD_RUSTC_WRAPPER) [ -n "${RUSTC_WRAPPER+x}" ] && continue;;
    CARGO_BUILD_RUSTC_WORKSPACE_WRAPPER) [ -n "${RUSTC_WORKSPACE_WRAPPER+x}" ] && continue;;
  esac
  case "$override" in
    *WRAPPER|RUSTUP_TOOLCHAIN|RUSTC_BOOTSTRAP) value="${!override:-}"; fix="unset $override or set it empty";;
    *) value="${!override+set}"; fix="unset $override";;
  esac
  if [ -n "$value" ]; then
    echo "build-at-ref.sh: $fix before building (compiler override)" >&3
    exit 1
  fi
done

# Inherited GIT_* variables (e.g. from a git hook) override -C and would point
# worktree add/apply/remove at the wrong repository or index.
unset GIT_DIR GIT_WORK_TREE GIT_COMMON_DIR GIT_INDEX_FILE GIT_OBJECT_DIRECTORY GIT_ALTERNATE_OBJECT_DIRECTORIES GIT_PREFIX
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
# Cargo resolves build.rustc* from the worktree, its ancestors and CARGO_HOME,
# so ask it from the build directory after injections and patches.
# RUSTC_BOOTSTRAP lets this one query run on a ref whose toolchain is stable;
# it does not reach the build. Fail closed if the query itself fails.
# On a non-nightly cargo the build ignores [unstable] and CARGO_UNSTABLE_*,
# which the bootstrapped query would apply (they can change which config files
# load), so drop the env and refuse the table: both then see the same config.
if ! CARGO_VERSION="$(cd "$WT" && cargo -V 2>&3)"; then
  echo "build-at-ref.sh: cargo failed at $REF before building (version query, see above)" >&3
  exit 1
fi
case "$CARGO_VERSION" in *-nightly*|*-dev*) NIGHTLY=1;; *) NIGHTLY="";; esac
config_get() (
  cd "$WT"
  [ -n "$NIGHTLY" ] || unset "${!CARGO_UNSTABLE_@}"
  RUSTC_BOOTSTRAP=1 cargo -Z unstable-options config get "$@"
)
# The file that sets config key $1. One inside the worktree is gone after exit,
# so it is named as the ref has it.
config_origin() {
  local where wt_real
  where="$(config_get --show-origin "$1" 2>/dev/null | awk -F' # ' 'NF > 1 { print $NF; exit }')" || true
  if [ -z "$where" ]; then echo "Cargo config"; return; fi
  wt_real="$(cd "$WT" && pwd -P)"
  case "$where" in
    "$wt_real"/*) where="${where#"$wt_real"/} at $REF (from the ref, --inject or --patch)";;
  esac
  echo "$where"
}
if ! CARGO_CONFIG="$(config_get 2>&3)"; then
  echo "build-at-ref.sh: cargo failed at $REF before building (config query, see above)" >&3
  exit 1
fi
if [ -z "$NIGHTLY" ] && grep -q '^unstable[.]' <<<"$CARGO_CONFIG"; then
  echo "build-at-ref.sh: remove [unstable] from $(config_origin unstable) before building:" \
    "the build ignores it on a non-nightly cargo ($CARGO_VERSION), so the override check cannot match it" >&3
  exit 1
fi
# A set RUSTC_*WRAPPER (empty, per the loop above) or an empty
# CARGO_BUILD_RUSTC_*WRAPPER turns off that config key, as in cargo.
KEYS=rustc
[ -n "${RUSTC_WRAPPER+x}${CARGO_BUILD_RUSTC_WRAPPER+x}" ] || KEYS+="|rustc-wrapper"
[ -n "${RUSTC_WORKSPACE_WRAPPER+x}${CARGO_BUILD_RUSTC_WORKSPACE_WRAPPER+x}" ] || KEYS+="|rustc-workspace-wrapper"
# Values print in any TOML string form ("", '', """, '''), so match the
# key only. An empty value prints as "": no wrapper, but an unusable rustc.
override="$(awk -v key="^build[.]($KEYS) = " '$0 ~ key && !/^build[.]rustc-[a-z-]+ = ""$/ { print; exit }' <<<"$CARGO_CONFIG")"
if [ -n "$override" ]; then
  key="${override%% = *}"
  case "$key" in
    build.rustc-wrapper) hint="; or set RUSTC_WRAPPER= for this run";;
    build.rustc-workspace-wrapper) hint="; or set RUSTC_WORKSPACE_WRAPPER= for this run";;
    *) hint="";;
  esac
  echo "build-at-ref.sh: remove $key from $(config_origin "$key") before building (compiler override$hint)" >&3
  exit 1
fi
# Refs older than the `profiling` profile get today's definition, so every
# ref builds with the same optimisation and symbol settings. Only that profile
# is back-filled: any other --profile must already exist at --ref, or cargo
# fails below with its own message rather than being handed settings today's
# tree happens to use.
if [ "$PROFILE" = profiling ] && ! grep -q '^\[profile\.profiling\]' "$WT/Cargo.toml"; then
  printf '\n[profile.profiling]\ninherits = "release"\nstrip = false\ndebug = "line-tables-only"\npanic = "unwind"\n' >> "$WT/Cargo.toml"
fi
# Cargo's built-in profiles do NOT each get a directory of their own: dev and
# test both write to target/debug, bench writes to target/release. A custom
# profile is the only case where the directory is the profile's name, so
# `--profile dev` with an unmapped path would build fine and then fail the copy.
case "$PROFILE" in
  dev|test) PROFILE_DIR=debug;;
  bench) PROFILE_DIR=release;;
  *) PROFILE_DIR="$PROFILE";;
esac
if [ -n "$BIN" ]; then
  TARGET_ARGS=(--bin "$BIN")
  BUILT="$TARGET_DIR/$PROFILE_DIR/$BIN"
  WHAT="bin $BIN"
else
  TARGET_ARGS=(--example "$EXAMPLE")
  BUILT="$TARGET_DIR/$PROFILE_DIR/examples/$EXAMPLE"
  WHAT="example $EXAMPLE"
fi
if ! ( cd "$WT" && CARGO_TARGET_DIR="$TARGET_DIR" \
    cargo build --profile "$PROFILE" -p "$PACKAGE" "${TARGET_ARGS[@]}" >&3 2>&3 ); then
  echo "build-at-ref.sh: building $WHAT of $PACKAGE at $REF failed" >&3
  exit 1
fi
# The compiler that built it, resolved where it was resolved for the build:
# same directory, same environment. Overrides were refused above, so this is
# the toolchain cargo used (rustup installs it, if needed, at the version query).
# Written before the binary is copied out, so a caller that finds $OUT finds
# this too.
if [ -n "$RUSTC_OUT" ]; then
  mkdir -p "$(dirname "$RUSTC_OUT")"
  if ! RUSTC_VV="$( cd "$WT" && rustc -vV 2>&3 )"; then
    echo "build-at-ref.sh: could not record rustc -vV in the worktree" >&3
    exit 1
  fi
  # First line only ("rustc 1.x.y (hash date)"); the rest is host/LLVM detail.
  printf '%s\n' "$RUSTC_VV" | head -1 > "$RUSTC_OUT"
  if [ ! -s "$RUSTC_OUT" ]; then
    echo "build-at-ref.sh: rustc -vV printed no version line in the worktree" >&3
    exit 1
  fi
fi
mkdir -p "$(dirname "$OUT")"
# Copy then rename: an interrupted copy must never leave a truncated binary
# at $OUT, because callers treat an existing $OUT as a finished build.
cp "$BUILT" "$OUT.partial.$$"
mv -f "$OUT.partial.$$" "$OUT"

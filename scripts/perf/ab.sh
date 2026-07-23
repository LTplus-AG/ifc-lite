#!/usr/bin/env bash
# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at https://mozilla.org/MPL/2.0/.
#
# Interleaved base-vs-branch native perf A/B on the perf_probe phases.
#
# The single most common perf mistake in this repo is measuring a "win" that is
# machine drift or a contaminated artifact (see scripts/perf/README.md, the
# failure-mode ledger). This tool exists so an agent can produce a *trustworthy*
# base-vs-branch delta with one command:
#
#   - It builds perf_probe from BOTH a base ref and the working tree.
#   - It runs them INTERLEAVED (base, branch, base, branch, …) so a machine that
#     slows down mid-run drags BOTH sides equally instead of faking a delta.
#   - It reports per-phase median + spread and refuses a verdict when the base's
#     OWN run-to-run spread is too wide (the machine is too noisy to trust).
#   - It fingerprints mesh/vertex/triangle counts so a "faster" run that changed
#     the output is flagged, not celebrated.
#
# Usage:
#   scripts/perf/ab.sh tests/models/ara3d/AC20-FZK-Haus.ifc
#   scripts/perf/ab.sh /abs/path/model.ifc --iters 7 --base origin/main
#   scripts/perf/ab.sh a.ifc b.ifc --iters 5      # several fixtures
#
# Flags:
#   --base <ref>   git ref to treat as "before" (default: merge-base with
#                  origin/main, else HEAD~1). The working tree — INCLUDING
#                  uncommitted changes — is "after".
#   --iters <N>    interleaved rounds per side (default 5). Higher = less noise.
#   --json <path>  also write the machine-readable report to <path>.
#
# Notes:
#   - Fixture paths are resolved to ABSOLUTE and both binaries run from the repo
#     root, so the base build (a throwaway worktree that lacks fetched fixtures)
#     still reads the same on-disk file. Fetch fixtures first: `pnpm fixtures …`.
#   - Uses the `profiling` cargo profile (release-grade opt + symbols), same as
#     probe.sh, so the numbers are comparable to a flamegraph run.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"
[ -f "$HOME/.cargo/env" ] && source "$HOME/.cargo/env"

BASE_REF=""
ITERS=5
JSON_OUT=""
FIXTURES=()
while [ $# -gt 0 ]; do
  case "$1" in
    --base) BASE_REF="${2:?--base needs a ref}"; shift 2;;
    --iters) ITERS="${2:?--iters needs a number}"; shift 2;;
    --json) JSON_OUT="${2:?--json needs a path}"; shift 2;;
    -h|--help) sed -n '2,40p' "$0"; exit 0;;
    -*) echo "ab.sh: unknown flag $1" >&2; exit 2;;
    *) FIXTURES+=("$1"); shift;;
  esac
done

if [ "${#FIXTURES[@]}" -eq 0 ]; then
  echo "ab.sh: pass at least one fixture path (see --help)" >&2
  exit 2
fi

# --iters must be a positive integer: 0 runs produces no data (yet the reporter
# would print a non-error verdict), and a decimal makes `seq` iterate an
# unintended count.
if ! [[ "$ITERS" =~ ^[1-9][0-9]*$ ]]; then
  echo "ab.sh: --iters must be a positive integer (got '$ITERS')" >&2
  exit 2
fi

# Resolve fixtures to absolute paths so the base worktree (no fetched fixtures)
# still reads them. Fail early on a missing/typo'd path rather than after a build.
ABS_FIXTURES=()
for f in "${FIXTURES[@]}"; do
  if [ -f "$f" ]; then
    ABS_FIXTURES+=("$(cd "$(dirname "$f")" && pwd)/$(basename "$f")")
  elif [ -f "$ROOT/$f" ]; then
    ABS_FIXTURES+=("$ROOT/$f")
  else
    echo "ab.sh: fixture not found: $f (fetch it first, e.g. \`pnpm fixtures ${f#tests/models/}\`)" >&2
    exit 2
  fi
done

if [ -z "$BASE_REF" ]; then
  BASE_REF="$(git merge-base HEAD origin/main 2>/dev/null || git rev-parse HEAD~1)"
fi
BASE_SHA="$(git rev-parse --short "$BASE_REF")"
# `+dirty` must reflect BOTH unstaged (worktree) and staged (index) edits — the
# working tree is what actually gets built, so a staged-but-uncommitted change
# still makes the "branch" side differ from HEAD.
if git diff --quiet && git diff --cached --quiet; then
  BRANCH_DESC="$(git rev-parse --short HEAD)"
else
  BRANCH_DESC="$(git rev-parse --short HEAD)+dirty"
fi
echo "ab.sh: base=$BASE_SHA ($BASE_REF)  branch=$BRANCH_DESC  iters=$ITERS" >&2

# --- Build the branch (working-tree) probe --------------------------------
echo "ab.sh: building branch perf_probe (working tree)…" >&2
cargo build --profile profiling -p ifc-lite-processing --example perf_probe >&2
BRANCH_BIN="$ROOT/target/profiling/examples/perf_probe"

# --- Build the base probe in a throwaway worktree -------------------------
# Its own CARGO_TARGET_DIR so the base build never clobbers the branch's target
# (which would silently make the two sides share a binary — a classic false A/B).
TMP_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/ifc-ab.XXXXXX")"
BASE_WT="$TMP_ROOT/base-wt"
cleanup() {
  git worktree remove --force "$BASE_WT" >/dev/null 2>&1 || true
  rm -rf "$TMP_ROOT" >/dev/null 2>&1 || true
}
trap cleanup EXIT
echo "ab.sh: building base perf_probe @ $BASE_SHA in a throwaway worktree…" >&2
git worktree add --detach "$BASE_WT" "$BASE_REF" >&2
( cd "$BASE_WT" && CARGO_TARGET_DIR="$TMP_ROOT/target" \
    cargo build --profile profiling -p ifc-lite-processing --example perf_probe >&2 )
BASE_BIN="$TMP_ROOT/target/profiling/examples/perf_probe"

if [ ! -x "$BASE_BIN" ] || [ ! -x "$BRANCH_BIN" ]; then
  echo "ab.sh: a probe binary is missing — build failed above." >&2
  exit 1
fi

# --- Interleaved runs -----------------------------------------------------
# One --iters=1 probe run per side per round, alternating, so drift hits both.
RUNS_JSONL="$TMP_ROOT/runs.jsonl"
: > "$RUNS_JSONL"
for i in $(seq 1 "$ITERS"); do
  echo "ab.sh: round $i/$ITERS" >&2
  for side in base branch; do
    bin="$BASE_BIN"; [ "$side" = branch ] && bin="$BRANCH_BIN"
    # Run from ROOT so relative fixture handling and on-disk fixtures resolve.
    out="$("$bin" "${ABS_FIXTURES[@]}" --iters 1 --json 2>/dev/null)"
    node -e '
      const [side, out] = [process.argv[1], process.argv[2]];
      for (const p of JSON.parse(out)) console.log(JSON.stringify({ side, ...p }));
    ' "$side" "$out" >> "$RUNS_JSONL"
  done
done

# --- Report ---------------------------------------------------------------
REPORT_ARGS=("$RUNS_JSONL" "--base" "$BASE_SHA" "--branch" "$BRANCH_DESC")
[ -n "$JSON_OUT" ] && REPORT_ARGS+=("--json" "$JSON_OUT")
node "$ROOT/scripts/perf/ab-report.mjs" "${REPORT_ARGS[@]}"

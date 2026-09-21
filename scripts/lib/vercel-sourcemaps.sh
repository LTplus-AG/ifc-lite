#!/usr/bin/env bash
# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at https://mozilla.org/MPL/2.0/.

# Decide whether the Vercel viewer build generates source maps for PostHog.
# Kept as a sourceable function so CI can observe every path without launching
# the full Vercel build (same shape as vercel-node-heap.sh).
#
# Maps are worth having — without them every production stack trace reads
# "Could not find sourcemap for source url" — but generating them is the
# largest single slice of the bundler's NATIVE memory: rolldown holds every
# module's original source plus its mappings while it renders ~150 chunks from
# ~8k modules. On Vercel's basic 4-core / 8 GB builder that is what tips the
# container over. Capping the V8 heap (#4990, #5132) did not save it: with a
# 5 GB heap ceiling in place the production build of f927937e8 was still
# OOM-killed 15 s into "rendering chunks" (exit 137), because the pressure is
# outside the heap. The bundle simply grew past the machine between 09-18
# (bffdd89a3 READY) and 09-19 (6c01865b8 ERROR) with no config change.
#
# So the maps follow the machine:
#   * `VERCEL_SOURCEMAPS=1` forces them on, `VERCEL_SOURCEMAPS=0` forces them off
#     (project env; the switch to flip once the machine can afford them);
#   * otherwise they are generated only when the PostHog CLI keys are present
#     AND /proc/meminfo reports at least `VERCEL_SOURCEMAPS_MIN_RAM_MB`, so an
#     Enhanced (16 GB) builder gets symbolicated traces back automatically and
#     the basic 8 GB one gets a build that finishes. Unknown memory (no
#     readable meminfo) fails safe to off.
# A deploy that finishes minified beats one that never finishes.

# 12 GB: comfortably above the 8 GB basic builder (which Linux reports as
# ~7.9 GB) and below the 16 GB enhanced one.
VERCEL_SOURCEMAPS_MIN_RAM_MB=12288

# MemTotal in MB from the meminfo file, or nothing when it cannot be read.
# `VERCEL_SOURCEMAPS_MEMINFO` exists so the test can feed a different machine.
vercel_sourcemaps_ram_mb() {
  local meminfo="${VERCEL_SOURCEMAPS_MEMINFO:-/proc/meminfo}"
  [ -r "$meminfo" ] || return 0
  awk '/^MemTotal:/ { printf "%d", $2 / 1024; exit }' "$meminfo" 2>/dev/null
}

# Exports VITE_SOURCEMAP=1 when maps should be generated and prints why either
# way. Returns 0 when maps are on, 1 when off, so callers can branch.
#
# Every "off" path also clears an inherited VITE_SOURCEMAP: this decision is
# the only thing allowed to switch maps on, so a value leaking in from the
# project env cannot re-enable them behind a "disabled" log line.
configure_vercel_sourcemaps() {
  local have_keys=0 ram
  unset VITE_SOURCEMAP
  if [ -n "${POSTHOG_CLI_API_KEY:-}" ] && [ -n "${POSTHOG_CLI_ENV_ID:-}" ]; then
    have_keys=1
  fi

  case "${VERCEL_SOURCEMAPS:-}" in
    1)
      export VITE_SOURCEMAP=1
      if [ "$have_keys" = 1 ]; then
        echo "🗺️  Source maps ENABLED (VERCEL_SOURCEMAPS=1) — will upload then delete"
      else
        echo "🗺️  Source maps ENABLED (VERCEL_SOURCEMAPS=1) but no PostHog CLI keys: nothing will upload and the maps are swept from the output"
      fi
      return 0
      ;;
    0)
      echo "🗺️  Source maps disabled (VERCEL_SOURCEMAPS=0) — traces stay minified"
      return 1
      ;;
  esac

  if [ "$have_keys" != 1 ]; then
    echo "🗺️  Source maps disabled (need both POSTHOG_CLI_API_KEY and POSTHOG_CLI_ENV_ID) — traces stay minified"
    return 1
  fi

  ram="$(vercel_sourcemaps_ram_mb)"
  case "$ram" in
    ''|*[!0-9]*|0)
      # Unknown memory cannot prove the machine large, so it fails safe: the
      # OOM is the failure mode this rule exists to prevent, and
      # VERCEL_SOURCEMAPS=1 is the way to insist.
      echo "🗺️  Source maps disabled: this builder's memory is unknown (no readable meminfo). Set VERCEL_SOURCEMAPS=1 to force them."
      return 1
      ;;
  esac
  if [ "$ram" -lt "$VERCEL_SOURCEMAPS_MIN_RAM_MB" ]; then
    echo "🗺️  Source maps disabled on this ${ram} MB builder (below ${VERCEL_SOURCEMAPS_MIN_RAM_MB} MB): generating them OOM-killed the bundle at \"rendering chunks\" (#5132). Traces stay minified until the build machine is larger or VERCEL_SOURCEMAPS=1 forces them."
    return 1
  fi

  export VITE_SOURCEMAP=1
  echo "🗺️  Source maps ENABLED (PostHog CLI keys present, ${ram:-unknown} MB builder) — will upload then delete"
  return 0
}

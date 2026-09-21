#!/usr/bin/env bash
# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at https://mozilla.org/MPL/2.0/.

# Configure the V8 old-space ceiling used by the Vercel viewer bundle (#4990).
# Kept as a sourceable function so CI can observe every override path without
# launching the full Vercel build.
#
# The ceiling is a BUDGET derived from the machine, not a preference (#5132).
# Vercel's build image already exports `NODE_OPTIONS=--max_old_space_size=8192`
# on its basic 4-core / 8 GB builder. The first version of this helper treated
# any pre-set cap as an operator's intent and kept it, so the bundler ran with
# an 8 GB heap ceiling inside an 8 GB container: V8 never felt pressure, the
# kernel OOM-killed vite at "rendering chunks" (exit 137) whenever the peak
# landed high, and the nightly production advance froze on the builds that
# lost that coin toss (51c36ecd9, 707cc22a0, 6c01865b8, 13a04c038 first try).
#
# So: a pre-set cap is kept only when it fits the budget (a smaller ceiling
# cannot cause the OOM, and a project that lowers it on purpose keeps it); a
# larger one is replaced. The budget is `VERCEL_NODE_MAX_OLD_SPACE_MB` when
# the project sets it — the documented override, which wins outright — else
# 5120 MB, lowered to ~62 % of physical RAM when /proc/meminfo reports a
# machine smaller than the 8 GB that figure was sized for.

# The 5 GB default leaves ~3 GB for rolldown's native side, worker threads
# and the OS on the 8 GB builder; on a larger machine the cap is simply not
# reached.
VERCEL_NODE_HEAP_DEFAULT_MB=5120
# Percentage of MemTotal the heap may claim on a smaller machine
# (5120 / 8192 ≈ 62 %).
VERCEL_NODE_HEAP_RAM_PERCENT=62
# Below this MemTotal the machine is smaller than the default was sized for.
# The kernel reports an 8 GB box as ~7.9 GB, so the line sits at 7 GB rather
# than 8 to keep the measured 5120 on the builder the default came from.
VERCEL_NODE_HEAP_SIZED_FOR_MB=7168

# MemTotal in MB from the meminfo file, or nothing when it cannot be read.
# `VERCEL_NODE_HEAP_MEMINFO` exists so the test can feed a smaller machine.
vercel_node_heap_ram_mb() {
  local meminfo="${VERCEL_NODE_HEAP_MEMINFO:-/proc/meminfo}"
  [ -r "$meminfo" ] || return 0
  awk '/^MemTotal:/ { printf "%d", $2 / 1024; exit }' "$meminfo" 2>/dev/null
}

# The heap budget in MB for this machine.
vercel_node_heap_budget_mb() {
  if [ -n "${VERCEL_NODE_MAX_OLD_SPACE_MB:-}" ]; then
    printf '%s' "$VERCEL_NODE_MAX_OLD_SPACE_MB"
    return 0
  fi
  local budget=$VERCEL_NODE_HEAP_DEFAULT_MB ram
  ram="$(vercel_node_heap_ram_mb)"
  if [ -n "$ram" ] && [ "$ram" -gt 0 ] 2>/dev/null && [ "$ram" -lt "$VERCEL_NODE_HEAP_SIZED_FOR_MB" ]; then
    local by_ram=$(( ram * VERCEL_NODE_HEAP_RAM_PERCENT / 100 ))
    [ "$by_ram" -lt "$budget" ] && budget=$by_ram
  fi
  printf '%s' "$budget"
}

# The value of a `--max-old-space-size` / `--max_old_space_size` flag already
# present in NODE_OPTIONS (either spelling, `=` or space separated), or nothing.
vercel_node_heap_preset_mb() {
  printf ' %s ' "${NODE_OPTIONS:-}" \
    | sed -n -E 's/.* --max[-_]old[-_]space[-_]size[= ]([0-9]+)( .*)?$/\1/p' \
    | head -n 1
}

# NODE_OPTIONS with every heap flag removed, whitespace collapsed.
vercel_node_heap_strip() {
  printf ' %s ' "${NODE_OPTIONS:-}" \
    | sed -E 's/ --max[-_]old[-_]space[-_]size(=[0-9]+| [0-9]+)?( |$)/ /g' \
    | sed -E 's/^ +| +$//g; s/ +/ /g'
}

configure_vercel_node_heap() {
  local budget preset rest
  budget="$(vercel_node_heap_budget_mb)"
  preset="$(vercel_node_heap_preset_mb)"

  if [ -n "$preset" ] && [ "$preset" -le "$budget" ] 2>/dev/null; then
    echo "🧠 Node heap: NODE_OPTIONS already caps --max-old-space-size at ${preset} MB, within the ${budget} MB budget (${NODE_OPTIONS})"
    return 0
  fi

  rest="$(vercel_node_heap_strip)"
  export NODE_OPTIONS="${rest:+$rest }--max-old-space-size=${budget}"
  if [ -n "$preset" ]; then
    echo "🧠 Node heap: replaced a pre-set --max-old-space-size of ${preset} MB with the ${budget} MB budget — a heap ceiling at or above the container's RAM lets V8 grow until the kernel OOM-kills the bundler (exit 137, #5132)"
  fi
  echo "🧠 Node heap: NODE_OPTIONS=${NODE_OPTIONS} (vite bundle + source maps GC-thrashed at V8's ~2 GB default on the 8 GB builder, #4990)"
}

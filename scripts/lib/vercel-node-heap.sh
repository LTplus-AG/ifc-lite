#!/usr/bin/env bash
# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at https://mozilla.org/MPL/2.0/.

# Configure the V8 old-space ceiling used by the Vercel viewer bundle (#4990).
# Kept as a sourceable function so CI can observe every override path without
# launching the full Vercel build.
configure_vercel_node_heap() {
  case " ${NODE_OPTIONS:-} " in
    *" --max-old-space-size="*|*" --max_old_space_size="*|*" --max-old-space-size "*|*" --max_old_space_size "*)
      echo "🧠 Node heap: NODE_OPTIONS already sets --max-old-space-size (${NODE_OPTIONS})"
      ;;
    *)
      export NODE_OPTIONS="${NODE_OPTIONS:+$NODE_OPTIONS }--max-old-space-size=${VERCEL_NODE_MAX_OLD_SPACE_MB:-5120}"
      echo "🧠 Node heap: NODE_OPTIONS=${NODE_OPTIONS} (vite bundle + source maps GC-thrashed at V8's ~2 GB default on the 8 GB builder, #4990)"
      ;;
  esac
}

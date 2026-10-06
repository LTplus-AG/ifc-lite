/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The `?perfTrace=1` switch (#6956/#6957), kept dependency-light on purpose:
 * `bootstrap.tsx` imports it before React, so nothing here may pull React (or
 * anything that does) into the module graph.
 */

import { perfCounters } from '@ifc-lite/load-trace';
import { readPerfFlag } from './flags.js';

export function isPerfTraceRequested(
  search: string = globalThis.location?.search ?? '',
  flag: unknown = readPerfFlag('perfTrace'),
): boolean {
  // A defined flag value is authoritative: `__IFC_LITE_PERF_TRACE = 0` must
  // keep tracing off even when the URL asks for it. The URL decides only when
  // the flag is unset.
  if (flag !== undefined && flag !== null) return flag === 1 || flag === true || flag === '1';
  return new URLSearchParams(search).get('perfTrace') === '1';
}

export const PERF_TRACE_ENABLED = isPerfTraceRequested();
// Counters must be live before the store, renderer and workers first bump them.
if (PERF_TRACE_ENABLED) perfCounters.enable();

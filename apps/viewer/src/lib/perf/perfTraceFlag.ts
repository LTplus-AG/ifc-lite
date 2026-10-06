/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The `?perfTrace=1` switch (#6956/#6957), kept dependency-light on purpose:
 * `reactCommits.ts` reads it before react-dom loads (bootstrap.tsx imports it
 * first), so nothing here may pull React (or anything that does) into the graph.
 */

import { perfCounters } from '@ifc-lite/load-trace';

export function isPerfTraceRequested(
  search: string = globalThis.location?.search ?? '',
  flag: unknown = (globalThis as { __IFC_LITE_PERF_TRACE?: unknown }).__IFC_LITE_PERF_TRACE,
): boolean {
  if (flag === 1 || flag === true || flag === '1') return true;
  return new URLSearchParams(search).get('perfTrace') === '1';
}

export const PERF_TRACE_ENABLED = isPerfTraceRequested();
// Counters must be live before the store, renderer and workers first bump them.
if (PERF_TRACE_ENABLED) perfCounters.enable();

/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { TraceAttrValue } from './types.js';

/** Namespace for every User Timing entry this package writes. */
export const MEASURE_PREFIX = 'ifc:';

/** Where finished spans are mirrored (the browser's User Timing buffer by default). */
export interface PerfSink {
  measure(name: string, start: number, end: number, detail: Record<string, TraceAttrValue>): void;
}

type MeasureFn = (name: string, options: { start: number; end: number; detail: unknown }) => unknown;

/**
 * Mirror spans into `performance.measure`. Prefers the instance method but
 * falls back to `Performance.prototype.measure`: the viewer's DEV bootstrap
 * deliberately nulls the INSTANCE property so React's dev render tracker stays
 * off (apps/viewer/AGENTS.md), and the prototype is untouched by that.
 */
export function createPerfSink(perf: Performance | undefined = globalThis.performance): PerfSink | null {
  if (!perf) return null;
  const proto = typeof Performance !== 'undefined' ? (Performance.prototype as unknown as { measure?: MeasureFn }) : undefined;
  const instance = perf as unknown as { measure?: MeasureFn };
  const measure = typeof instance.measure === 'function' ? instance.measure : proto?.measure;
  if (typeof measure !== 'function') return null;
  let warned = false;
  return {
    measure(name, start, end, detail) {
      // User Timing rejects negative timestamps and end < start.
      const s = Math.max(0, start);
      try {
        measure.call(perf, name, { start: s, end: Math.max(s, end), detail });
      } catch (err) {
        if (!warned) {
          warned = true;
          console.warn('[load-trace] performance.measure failed; span tree still recorded', err);
        }
      }
    },
  };
}

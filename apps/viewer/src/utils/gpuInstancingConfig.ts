/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { Renderer } from '@ifc-lite/renderer';
import { recordAppliedPerfFlag } from '../lib/perf/flags.js';
import { isHugeGeometryEnabled, isPerfFlagOn, readRampFlag } from './hugeGeometryConfig.js';

/**
 * GPU-driven instancing (`@ifc-lite/renderer` gpu-instance-pool.ts), OFF by
 * default: occurrence tables, a compute cull and indirect draws instead of
 * per-template CPU culls and repacks. Read once at renderer init, before
 * instanced shards stream in:
 *   ?perf.gpuInstancing=1   or   globalThis.__IFC_LITE_GPU_INSTANCING = 1
 * When unset, the huge-geometry umbrella (`hugeGeometryConfig.ts`) decides,
 * then the `perf-gpu-instancing` PostHog ramp.
 */
export function isGpuInstancingEnabled(readFeatureFlag?: (key: string) => unknown): boolean {
  const huge = isHugeGeometryEnabled();
  const raw = readRampFlag('gpuInstancing', huge, readFeatureFlag);
  if (isPerfFlagOn(raw)) return true;
  return raw === false || raw === 0 || raw === '0' || raw === 'false' ? false : huge; // unrecognised values do not override
}

/** Hand the flag to a fresh renderer before instanced shards stream in; a no-op when off. */
export function configureGpuInstancing(renderer: Pick<Renderer, 'setGpuInstancing'>): boolean {
  const on = isGpuInstancingEnabled() && renderer.setGpuInstancing(true);
  recordAppliedPerfFlag('gpuInstancing', on); // the telemetry arm is what ran
  if (on) console.log('[Viewport] GPU-driven instancing on');
  return on;
}

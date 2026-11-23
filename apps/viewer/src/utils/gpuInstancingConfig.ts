/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { Renderer } from '@ifc-lite/renderer';
import { readPerfFlag } from '../lib/perf/flags.js';

/**
 * GPU-driven instancing (`@ifc-lite/renderer` gpu-instance-pool.ts), OFF by
 * default: occurrence tables, a compute cull and indirect draws instead of
 * per-template CPU culls and repacks. Read once at renderer init, before
 * instanced shards stream in:
 *   ?perf.gpuInstancing=1   or   globalThis.__IFC_LITE_GPU_INSTANCING = 1
 */
export function isGpuInstancingEnabled(): boolean {
  const raw = readPerfFlag('gpuInstancing');
  return raw === 1 || raw === true;
}

/** Hand the flag to a fresh renderer before instanced shards stream in; a no-op when off. */
export function configureGpuInstancing(renderer: Pick<Renderer, 'setGpuInstancing'>): boolean {
  if (!isGpuInstancingEnabled()) return false;
  renderer.setGpuInstancing(true);
  console.log('[Viewport] GPU-driven instancing on');
  return true;
}

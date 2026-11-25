/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The `perf.gpuOnly` switch (GPU-only geometry residency, `gpu-only-residency.ts`).
 * Eager and tiny: the controller is fetched only when the switch is not `off`.
 */

import { readPerfFlag } from '@/lib/perf/flags';

/** `auto` arms GPU-only residency for sources at least this large. */
export const GPU_ONLY_AUTO_BYTES = 64 * 1024 * 1024;

export type GpuOnlyMode = 'off' | 'on' | 'auto';

export function gpuOnlyMode(): GpuOnlyMode {
  const raw = String(readPerfFlag('gpuOnly') ?? 'off').toLowerCase();
  if (raw === 'on' || raw === '1' || raw === 'true') return 'on';
  return raw === 'auto' ? 'auto' : 'off';
}

/** Whether a source of `sourceBytes` bytes is loaded under GPU-only residency. */
export function gpuOnlyRequested(sourceBytes: number, mode: GpuOnlyMode = gpuOnlyMode()): boolean {
  return mode === 'on' || (mode === 'auto' && sourceBytes >= GPU_ONLY_AUTO_BYTES);
}

let installed = false;

/**
 * Watch the viewer store for loads to run under GPU-only residency. Does nothing, and fetches
 * nothing, while the switch is `off`. Installed once for the page: the store outlives any one
 * viewport, and a viewport that remounts mid-load must not drop the load it was backing.
 */
export function installGpuOnlyResidency(): void {
  if (installed || gpuOnlyMode() === 'off') return;
  installed = true;
  void import('./gpu-only-residency').then(({ installGpuOnlyController }) => { installGpuOnlyController(); });
}

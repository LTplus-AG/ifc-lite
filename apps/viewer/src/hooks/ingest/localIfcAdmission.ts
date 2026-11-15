/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { assertWasmSourceSize } from '@ifc-lite/parser';

const GiB = 1024 ** 3;

/**
 * Pre-allocation safety policy, not a prediction of a model's exact footprint.
 * #10264 exhausted a 6 GiB tab with 1.05/1.26 GB sources even at one worker.
 * Reserve 25% of the reported device memory outside the tab, then admit an
 * eight-source working set plus 512 MiB of fixed viewer/browser overhead.
 * Source, parser/geometry WASM heaps, indexes, CPU meshes and GPU uploads all
 * overlap during a local load; the geometry worker count covers only one part.
 * Do not infer extra memory from CPU cores: an 8 GB report must stay 8 GB.
 * Smaller admitted models can still exhaust memory through their complexity.
 */
export function assertLocalIfcAdmission(byteLength: number, deviceMemoryGB?: number): void {
  assertWasmSourceSize(byteLength);
  const reported = deviceMemoryGB ?? (typeof navigator === 'undefined'
    ? undefined : (navigator as Navigator & { deviceMemory?: number }).deviceMemory);
  const memoryGB = typeof reported === 'number' && Number.isFinite(reported) && reported > 0 ? reported : 8;
  const budget = memoryGB * GiB * 0.75;
  const workingSet = byteLength * 8 + GiB / 2;
  if (workingSet > budget) {
    throw new RangeError(
      `This IFC file exceeds this tab's local processing memory budget `
      + `(${(workingSet / GiB).toFixed(1)} GiB estimated, ${(budget / GiB).toFixed(1)} GiB budget). `
      + 'The load was stopped before local processing to avoid crashing the tab. '
      + 'Export a smaller model or use the native CLI/server.',
    );
  }
}

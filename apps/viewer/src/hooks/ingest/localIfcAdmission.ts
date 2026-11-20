/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { assertWasmSourceSize } from '@ifc-lite/parser';
import { assertWasmSimdSupported } from '@/lib/wasm-simd-support';

const GiB = 1024 ** 3;
export interface LocalIfcMemoryWarning { estimatedGiB: number; budgetGiB: number }

/** Peak bytes per source byte: 8 for B-rep/extrusion content, 10 for files made
 * entirely of dense triangulated geometry (`geometryDensity.ts`). The dense end
 * is set by the capped synthetic runs in #10415 (4 GB reported, 3 GiB cap):
 * IfcTriangulatedFaceSet at 225 MB loaded, at 300 MB the tab was killed, so the
 * factor must exceed 8.95 and stay at or below 11.9. */
const SPARSE_BYTES_PER_BYTE = 8, DENSE_BYTES_PER_BYTE = 10;

/** Estimated peak bytes for a source of `byteLength` with `denseShare` (0..1; unknown = 0). */
export function localIfcWorkingSet(byteLength: number, denseShare = 0): number {
  return byteLength * (SPARSE_BYTES_PER_BYTE + (DENSE_BYTES_PER_BYTE - SPARSE_BYTES_PER_BYTE) * denseShare) + GiB / 2;
}

/** This tab's budget and the memory report it came from (absent or unreadable reports read as 8). */
export function localIfcBudget(deviceMemoryGB?: number): { memoryGB: number; budget: number } {
  const reported = deviceMemoryGB ?? (typeof navigator === 'undefined'
    ? undefined : (navigator as Navigator & { deviceMemory?: number }).deviceMemory);
  const memoryGB = typeof reported === 'number' && Number.isFinite(reported) && reported > 0 ? reported : 8;
  return { memoryGB, budget: memoryGB * GiB * 0.75 };
}

/** Pre-allocation policy, not an exact footprint prediction (#10264).
 * Browser memory reports cap at 8 GiB: that value (or an absent report) may
 * describe a much larger workstation, so it requires consent rather than a
 * hard refusal. Below 8, refuse an over-budget load. Never infer RAM from CPU
 * cores. `denseShare` (0..1, from a bounded sample) raises the estimate for
 * triangulated-mesh files; unknown (a ZIP, an unreadable sample) keeps the
 * B-rep rate. The sample shows only where it was taken: four windows can miss a
 * dense region, and the dense factor is bounded by two capped runs. Smaller
 * complex models can still exhaust memory after this check.
 * A browser without WebAssembly SIMD is refused outright (#10784). */
export function inspectLocalIfcAdmission(byteLength: number, deviceMemoryGB?: number, denseShare?: number): LocalIfcMemoryWarning | null {
  assertWasmSimdSupported();
  assertWasmSourceSize(byteLength);
  const { memoryGB, budget } = localIfcBudget(deviceMemoryGB);
  const workingSet = localIfcWorkingSet(byteLength, denseShare);
  if (workingSet <= budget) return null;
  if (memoryGB >= 8) return { estimatedGiB: workingSet / GiB, budgetGiB: budget / GiB };
  throw new RangeError(
    `This IFC file exceeds this tab's local processing memory budget `
    + `(${(workingSet / GiB).toFixed(1)} GiB estimated, ${(budget / GiB).toFixed(1)} GiB budget). `
    + 'The load was stopped before local processing to avoid crashing the tab. '
    + 'Export a smaller model or use the native CLI/server.',
  );
}

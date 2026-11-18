/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { assertWasmSourceSize } from '@ifc-lite/parser';

const GiB = 1024 ** 3;
export interface LocalIfcMemoryWarning { estimatedGiB: number; budgetGiB: number }

/** Pre-allocation policy, not an exact footprint prediction (#10264).
 * Browser memory reports cap at 8 GiB: that value (or an absent report) may
 * describe a much larger workstation, so it requires consent rather than a
 * hard refusal. Below 8, refuse an over-budget load. Never infer RAM from CPU
 * cores. Smaller complex models can still exhaust memory after this check. */
export function inspectLocalIfcAdmission(byteLength: number, deviceMemoryGB?: number): LocalIfcMemoryWarning | null {
  assertWasmSourceSize(byteLength);
  const reported = deviceMemoryGB ?? (typeof navigator === 'undefined'
    ? undefined : (navigator as Navigator & { deviceMemory?: number }).deviceMemory);
  const memoryGB = typeof reported === 'number' && Number.isFinite(reported) && reported > 0 ? reported : 8;
  const budget = memoryGB * GiB * 0.75;
  const workingSet = byteLength * 8 + GiB / 2;
  if (workingSet <= budget) return null;
  if (memoryGB >= 8) return { estimatedGiB: workingSet / GiB, budgetGiB: budget / GiB };
  throw new RangeError(
    `This IFC file exceeds this tab's local processing memory budget `
    + `(${(workingSet / GiB).toFixed(1)} GiB estimated, ${(budget / GiB).toFixed(1)} GiB budget). `
    + 'The load was stopped before local processing to avoid crashing the tab. '
    + 'Export a smaller model or use the native CLI/server.',
  );
}

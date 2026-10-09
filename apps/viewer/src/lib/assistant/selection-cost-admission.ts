/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { evidenceJson, TEXT_LIMIT } from './projection';

const refusal = { status: 'unavailable-transport-budget', recordCount: null, expectedJsonParts: null };
const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** #7360: reserve ordinary selection facts before projecting optional Cost graphs. */
export function selectionCostBaseline(data: unknown): unknown {
  return record(data) && record(data.nativeCost) && data.nativeCost.status === 'available'
    ? { ...data, nativeCost: refusal } : data;
}

/** Admit whole Cost pins only after the otherwise-fitting cited rows are fixed.
 * Each pin gets its own projection work budget, so it cannot consume the work
 * needed for later ordinary fields. The final serialized envelope is measured
 * for every candidate; single-row and non-selection contracts use their existing path.
 */
export function admitSelectionCosts(originalRows: readonly unknown[], projectedRows: unknown[],
  serialize: (rows: unknown[]) => string): void {
  let remaining = 12_000;
  for (let index = 0; index < projectedRows.length; index++) {
    const original = originalRows[index];
    const projected = projectedRows[index];
    if (!record(original) || !('nativeCost' in original) || !record(projected) || !record(projected.data)) continue;
    const pin = original.nativeCost;
    if (!record(pin) || pin.status !== 'available') continue;
    const cost = JSON.stringify(JSON.stringify(pin)).length;
    if (cost > remaining) continue;
    const projectedPin = JSON.parse(evidenceJson(pin).text) as unknown;
    // A shortened or redacted expected graph is unusable; keep explicit refusal.
    if (JSON.stringify(projectedPin) !== JSON.stringify(pin)) continue;
    const candidate = { ...projected, data: { ...projected.data, nativeCost: projectedPin } };
    const candidates = projectedRows.map((row, i) => i === index ? candidate : row);
    if (serialize(candidates).length > TEXT_LIMIT) continue;
    projectedRows[index] = candidate;
    remaining -= cost;
  }
}

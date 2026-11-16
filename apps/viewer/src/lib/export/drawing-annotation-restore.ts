/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import type { Measure2DResult } from '@/store/slices/drawing2DSlice';
import type { Dimension2D } from '@/store/slices/drawing2DDimensions';
import { encodeDimensionPlane, encodeDimensionRef } from '@/lib/drawing2d-markup/dimension-markup-codec';

/** Reconcile formats one-to-one; distinct repeated markups within either format survive. */
function reconcile<T extends { id: string }>(saved: T[], automatic: T[], signature: (item: T) => string): T[] {
  const available = new Map<string, number>();
  for (const item of automatic) {
    const key = signature(item);
    available.set(key, (available.get(key) ?? 0) + 1);
  }
  return [...saved.filter(item => {
    const key = signature(item);
    const count = available.get(key) ?? 0;
    if (!count) return true;
    available.set(key, count - 1);
    return false;
  }), ...automatic];
}

// The saved geometry passes through native units and placement inversion.
// Compare at drawing precision rather than treating float noise as new markup.
const keyOf = (values: unknown[]) => JSON.stringify(values, (_key, value: unknown) =>
  typeof value === 'number' && Number.isFinite(value) && Math.abs(value) < 1e21 ? Math.round(value * 1e6) / 1e6 : value);

// Symbolic polyPoints use float32; compare both formats at that coordinate precision.
export function mergeRestoredMeasures(saved: Measure2DResult[], automatic: Measure2DResult[]): Measure2DResult[] {
  return reconcile(saved, automatic, m => keyOf([Math.fround(m.start.x), Math.fround(m.start.y), Math.fround(m.end.x), Math.fround(m.end.y), m.distance]));
}

export function mergeRestoredDimensions(saved: Dimension2D[], automatic: Dimension2D[]): Dimension2D[] {
  return reconcile(saved, automatic, d => keyOf([d.a.x, d.a.y, d.b.x, d.b.y, d.offset, d.orientation,
    d.text ?? null, encodeDimensionPlane(d.plane), encodeDimensionRef(d.refs?.a), encodeDimensionRef(d.refs?.b)]));
}

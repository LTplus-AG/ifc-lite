/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it, expect } from 'vitest';
import type { IfcDataStore } from '@ifc-lite/parser';
import { resolveEntityTypeName, footprintMidOffset } from './extract-walls.js';

describe('footprintMidOffset', () => {
  it('is ~zero for a symmetric footprint (centroid == geometric mid)', () => {
    const off = footprintMidOffset([[0, 0], [4, 0], [4, 0.3], [0, 0.3]]);
    expect(off).not.toBeNull();
    expect(Math.hypot(off![0], off![1])).toBeLessThan(1e-9);
  });

  it('returns the perpendicular offset when the centroid is pulled off-centre', () => {
    // Extra vertices crowd the bottom face → the centroid is pulled down, so the
    // geometric mid is ABOVE it (+Y). The offset is along the minor (Y) axis,
    // not along X (the length).
    const pts: [number, number][] = [
      [0, 0], [1, 0], [2, 0], [3, 0], [4, 0], // dense bottom face
      [4, 0.3], [0, 0.3],
    ];
    const off = footprintMidOffset(pts);
    expect(off).not.toBeNull();
    expect(Math.abs(off![0])).toBeLessThan(1e-6); // no length-axis component
    expect(off![1]).toBeGreaterThan(0.01); // mid is above the low centroid
  });

  it('returns null for fewer than 3 points', () => {
    expect(footprintMidOffset([[0, 0], [1, 0]])).toBeNull();
  });
});

/**
 * Regression for the AC20-FZK-Haus "no rooms" bug: the columnar entity table
 * only indexes products, so `getTypeName` returns the literal `'Unknown'` for
 * geometry primitives (IfcPolyline, IfcCartesianPoint, profiles). The Axis
 * reader used `getTypeName(id) || entity.type`, and since `'Unknown'` is
 * truthy it shadowed the extractor's reliable type — so every `Curve2D` Axis
 * polyline was skipped and no wall axis was found. `resolveEntityTypeName`
 * must ignore the `'Unknown'` sentinel and fall back to the extractor type.
 */
describe('resolveEntityTypeName', () => {
  const storeWith = (tableName: string) =>
    ({ entities: { getTypeName: () => tableName } } as unknown as IfcDataStore);

  it("falls back to the extractor type when the table says 'Unknown'", () => {
    // This is the exact FZK case: an IfcPolyline axis item.
    expect(resolveEntityTypeName(storeWith('Unknown'), { type: 'IFCPOLYLINE' }, 15031))
      .toBe('ifcpolyline');
  });

  it('prefers the columnar table when it resolves a real product type', () => {
    expect(resolveEntityTypeName(storeWith('IfcWallStandardCase'), { type: undefined }, 1))
      .toBe('ifcwallstandardcase');
  });

  it("returns '' when neither source knows the type", () => {
    expect(resolveEntityTypeName(storeWith('Unknown'), {}, 1)).toBe('');
  });
});

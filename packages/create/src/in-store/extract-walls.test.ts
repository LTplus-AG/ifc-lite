/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it, expect } from 'vitest';
import type { IfcDataStore } from '@ifc-lite/parser';
import { resolveEntityTypeName } from './extract-walls.js';

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

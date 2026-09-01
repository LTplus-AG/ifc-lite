/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Regression for a `Qto_SpaceBaseQuantities` inversion in `--boundary outer`
 * (and, more mildly, `--boundary center`) `ifc-lite generate-spaces` output.
 *
 * `offsetRoomFootprint` (generate-spaces.ts) bakes the emitted `IfcSpace`
 * solid at whichever face `boundaryMode` selects — for `'outer'` that is the
 * OUTWARD-offset (largest) footprint, not the inner (room-side) one.
 * `addSpaceToStore` (space.ts), when a caller omits `netFloorArea`, derives
 * `NetFloorArea` from that same `OuterCurve` polygon's own area. So an
 * unpatched caller that passes only `grossFloorArea` (the centreline area)
 * alongside an outer-offset `OuterCurve` reports `NetFloorArea` LARGER than
 * `GrossFloorArea` — backwards, since a room's net (inner-face) area can
 * never exceed its gross (outer-face or centreline) area.
 *
 * `generateSpacesFromWalls` now always computes the true inner-face area
 * separately and passes it as `netFloorArea`, independent of `boundaryMode`.
 */

import { describe, it, expect } from 'vitest';
import {
  MutablePropertyView,
  StoreEditor,
  type MutationEntityRef,
  type MutationStoreShape,
} from '@ifc-lite/mutations';
import { addSpaceToStore } from './space.js';
import { offsetRoomFootprint, type BoundaryMode } from './generate-spaces.js';
import type { Segment, Vec2 } from './auto-space-detect.js';

function makeStore(maxId: number): MutationStoreShape {
  const byId = new Map<number, MutationEntityRef>();
  for (let id = 1; id <= maxId; id++) {
    byId.set(id, { expressId: id, type: 'IFCDUMMY', byteOffset: 0, byteLength: 1, lineNumber: id });
  }
  return { entityIndex: { byId } };
}

function polygonArea(pts: Vec2[]): number {
  let acc = 0;
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i];
    const q = pts[(i + 1) % pts.length];
    acc += p[0] * q[1] - q[0] * p[1];
  }
  return Math.abs(acc) / 2;
}

// A 4x4 m centreline room bounded by four 0.3 m thick walls.
const outline: Vec2[] = [[0, 0], [4, 0], [4, 4], [0, 4]];
const segments: Segment[] = [
  { a: [0, 0], b: [4, 0] },
  { a: [4, 0], b: [4, 4] },
  { a: [4, 4], b: [0, 4] },
  { a: [0, 4], b: [0, 0] },
];
const wallThicknesses = [0.3, 0.3, 0.3, 0.3];
const grossArea = polygonArea(outline); // 16 — the centreline (GrossFloorArea) measure

function bake(view: MutablePropertyView, editor: StoreEditor, boundaryMode: BoundaryMode, netFloorArea?: number) {
  const bakedOutline = offsetRoomFootprint(outline, segments, wallThicknesses, boundaryMode, []);
  return addSpaceToStore(
    editor,
    { ownerHistoryId: 5, bodyContextId: 14, axisContextId: 15, storeyId: 43, storeyPlacementId: 54 },
    {
      Profile: 'polygon',
      OuterCurve: bakedOutline,
      Height: 3,
      grossFloorArea: grossArea,
      netFloorArea,
    },
  );
}

const namedQ = (view: MutablePropertyView, id: number): Record<string, number> => {
  const qto = view.getQuantitiesForEntity(id).find((s) => s.name === 'Qto_SpaceBaseQuantities');
  return Object.fromEntries((qto?.quantities ?? []).map((q) => [q.name, q.value]));
};

describe('generate-spaces boundaryMode=outer: NetFloorArea must not exceed GrossFloorArea', () => {
  it('BUG (space.ts default fallback): an outer-offset OuterCurve with no netFloorArea override reports Net > Gross', () => {
    const view = new MutablePropertyView(null, 'm1');
    const editor = new StoreEditor(makeStore(60), view);
    // This mirrors the pre-fix generate-spaces.ts call shape: OuterCurve is
    // the outer-offset polygon, only grossFloorArea (centreline) is supplied.
    const result = bake(view, editor, 'outer', undefined);
    const q = namedQ(view, result.spaceId);
    expect(q['GrossFloorArea']).toBeCloseTo(grossArea, 6);
    // The defect: net exceeds gross, which Qto_SpaceBaseQuantities forbids.
    expect(q['NetFloorArea']).toBeGreaterThan(q['GrossFloorArea']);
  });

  it('FIX: generateSpacesFromWalls always derives netFloorArea from the inner (room-side) offset, independent of boundaryMode', () => {
    const view = new MutablePropertyView(null, 'm1');
    const editor = new StoreEditor(makeStore(60), view);
    const innerOutline = offsetRoomFootprint(outline, segments, wallThicknesses, 'inner', []);
    const netFloorArea = polygonArea(innerOutline);
    const result = bake(view, editor, 'outer', netFloorArea);
    const q = namedQ(view, result.spaceId);
    expect(q['GrossFloorArea']).toBeCloseTo(grossArea, 6);
    expect(q['NetFloorArea']).toBeCloseTo(netFloorArea, 6);
    expect(q['NetFloorArea']).toBeLessThanOrEqual(q['GrossFloorArea']);
  });

  it('CONTROL: boundaryMode=inner (the default) was already correct — OuterCurve IS the net face', () => {
    const view = new MutablePropertyView(null, 'm1');
    const editor = new StoreEditor(makeStore(60), view);
    // No netFloorArea override — matches generate-spaces.ts's actual call for
    // the default boundaryMode, both before and after the fix.
    const result = bake(view, editor, 'inner', undefined);
    const q = namedQ(view, result.spaceId);
    expect(q['GrossFloorArea']).toBeCloseTo(grossArea, 6);
    expect(q['NetFloorArea']).toBeLessThanOrEqual(q['GrossFloorArea']);
  });
});

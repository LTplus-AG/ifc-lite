/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it } from 'node:test';
import assert from 'node:assert';

import {
  closestYOnVerticalLineFromRay,
  computeCesiumPlacement,
  computeIfcOriginHeight,
  computeOrthogonalHeightForBaseAltitude,
  getMapUnitScale,
  intersectRayWithHorizontalPlane,
  mapUnitsToMeters,
  metersToMapUnits,
  projectedDeltaToViewerDelta,
  shouldPreferOrthometricTerrain,
  viewerDeltaToProjectedDelta,
} from './cesium-placement.js';

describe('cesium placement helpers', () => {
  it('falls back to the project length unit when mapUnitScale is absent', () => {
    assert.strictEqual(getMapUnitScale(undefined, 0.001), 0.001);
    assert.strictEqual(getMapUnitScale({ mapUnitScale: 1 }, 0.001), 1);
  });

  it('converts between metres and map units using ProjectedCRS.mapUnitScale', () => {
    const usFoot = { mapUnitScale: 0.3048006096 };
    assert.strictEqual(mapUnitsToMeters(10, usFoot, 1), 3.048006096);
    assert.strictEqual(
      metersToMapUnits(3.048006096, usFoot, 1),
      10,
    );
  });

  it('prefers orthometric terrain when a vertical datum is present', () => {
    assert.strictEqual(shouldPreferOrthometricTerrain({ verticalDatum: 'EPSG:8357' }), true);
    assert.strictEqual(shouldPreferOrthometricTerrain({ verticalDatum: '$' }), false);
    assert.strictEqual(shouldPreferOrthometricTerrain({ verticalDatum: '' }), false);
    assert.strictEqual(shouldPreferOrthometricTerrain(undefined), false);
  });

  it('computes terrain-clamped placement and clip plane from storey anchor', () => {
    const placement = computeCesiumPlacement({
      coordinateInfo: {
        originShift: { x: 0, y: 0, z: 0 },
        originalBounds: {
          min: { x: 0, y: -3, z: 0 },
          max: { x: 10, y: 9, z: 10 },
        },
        shiftedBounds: {
          min: { x: 0, y: -3, z: 0 },
          max: { x: 10, y: 9, z: 10 },
        },
        hasLargeCoordinates: false,
      },
      projectedCRS: { verticalDatum: 'EPSG:8357' },
      ifcOriginHeight: 244,
      terrainHeight: 245,
      storeyElevations: new Map([[1, -3], [2, 0], [3, 3]]),
    });

    assert.strictEqual(placement.clampAnchorY, 0);
    assert.strictEqual(placement.anchorOffset, 3);
    assert.strictEqual(placement.placementHeight, 248);
    assert.strictEqual(placement.terrainClipY, 0);
    assert.strictEqual(placement.preferOrthometricTerrain, true);
  });

  it('preserves authored OrthogonalHeight when it is already above terrain', () => {
    const placement = computeCesiumPlacement({
      ifcOriginHeight: 244,
      terrainHeight: 195.4,
    });

    assert.strictEqual(placement.placementHeight, 244);
    assert.strictEqual(placement.terrainClipY, -48.599999999999994);
  });

  it('computes OrthogonalHeight from target base altitude with shift and RTC', () => {
    const orthogonalHeight = computeOrthogonalHeightForBaseAltitude({
      coordinateInfo: {
        originShift: { x: 0, y: 2, z: 0 },
        originalBounds: {
          min: { x: 0, y: -1, z: 0 },
          max: { x: 10, y: 11, z: 10 },
        },
        shiftedBounds: {
          min: { x: 0, y: -1, z: 0 },
          max: { x: 10, y: 11, z: 10 },
        },
        hasLargeCoordinates: false,
        wasmRtcOffset: { x: 0, y: 0, z: 3 },
      },
      projectedCRS: { mapUnitScale: 0.3048 },
      lengthUnitScale: 1,
      storeyElevations: new Map([[1, 0]]),
      targetBaseAltitude: 245,
    });

    assert.strictEqual(orthogonalHeight, 787.4);
  });

  it('computes the IFC origin height from OrthogonalHeight and model center', () => {
    const height = computeIfcOriginHeight(
      { orthogonalHeight: 12 },
      { mapUnitScale: 0.5 },
      {
        originShift: { x: 0, y: 3, z: 0 },
        originalBounds: {
          min: { x: 0, y: 2, z: 0 },
          max: { x: 10, y: 8, z: 10 },
        },
        shiftedBounds: {
          min: { x: 0, y: 2, z: 0 },
          max: { x: 10, y: 8, z: 10 },
        },
        hasLargeCoordinates: false,
      },
      1,
    );

    assert.strictEqual(height, 14);
  });

  it('converts viewer XY drag deltas into projected map deltas', () => {
    const projected = viewerDeltaToProjectedDelta(
      2,
      -1,
      { xAxisAbscissa: 1, xAxisOrdinate: 0, scale: 1 },
      { mapUnitScale: 1 },
      1,
    );

    assert.deepStrictEqual(projected, { eastings: 2, northings: 1 });
  });

  it('converts projected map deltas back to viewer drag deltas', () => {
    const viewer = projectedDeltaToViewerDelta(
      2,
      1,
      { xAxisAbscissa: 1, xAxisOrdinate: 0, scale: 1 },
      { mapUnitScale: 1 },
      1,
    );

    assert.deepStrictEqual(viewer, { x: 2, z: -1 });
  });

  it('intersects a downward ray with a horizontal plane at the expected point', () => {
    const hit = intersectRayWithHorizontalPlane(
      { origin: { x: 5, y: 10, z: -3 }, direction: { x: 0, y: -1, z: 0 } },
      0,
    );
    assert.deepStrictEqual(hit, { x: 5, y: 0, z: -3 });
  });

  it('intersects an oblique ray with a horizontal plane consistently for two cursor samples', () => {
    // Two parallel rays separated by a known horizontal offset should map to
    // hit points separated by the same offset on the plane. This is the
    // invariant the placement gizmo relies on for stable XY drag at any
    // camera angle.
    const direction = { x: 0.4, y: -0.6, z: 0.5 };
    const hitA = intersectRayWithHorizontalPlane(
      { origin: { x: 0, y: 12, z: 0 }, direction },
      0,
    );
    const hitB = intersectRayWithHorizontalPlane(
      { origin: { x: 1, y: 12, z: 2 }, direction },
      0,
    );
    assert.ok(hitA && hitB);
    assert.strictEqual(Math.round((hitB.x - hitA.x) * 1e6) / 1e6, 1);
    assert.strictEqual(Math.round((hitB.z - hitA.z) * 1e6) / 1e6, 2);
  });

  it('rejects rays that are parallel to the horizontal plane', () => {
    const hit = intersectRayWithHorizontalPlane(
      { origin: { x: 0, y: 5, z: 0 }, direction: { x: 1, y: 0, z: 0 } },
      0,
    );
    assert.strictEqual(hit, null);
  });

  it('rejects rays whose intersection lies behind the origin', () => {
    // Ray going up, plane below origin: t < 0.
    const hit = intersectRayWithHorizontalPlane(
      { origin: { x: 0, y: 5, z: 0 }, direction: { x: 0, y: 1, z: 0 } },
      0,
    );
    assert.strictEqual(hit, null);
  });

  it('returns the cursor-aligned Y on a vertical line for an oblique ray', () => {
    // Ray that passes exactly through (anchorX, 7, anchorZ) — the closest
    // point on the vertical axis is the same point, so Y = 7.
    const anchorX = 4;
    const anchorZ = -2;
    const target = { x: anchorX, y: 7, z: anchorZ };
    const origin = { x: 0, y: 0, z: 0 };
    const dx = target.x - origin.x;
    const dy = target.y - origin.y;
    const dz = target.z - origin.z;
    const len = Math.sqrt(dx * dx + dy * dy + dz * dz);
    const direction = { x: dx / len, y: dy / len, z: dz / len };
    const y = closestYOnVerticalLineFromRay({ origin, direction }, anchorX, anchorZ);
    assert.ok(y !== null);
    assert.ok(Math.abs((y as number) - 7) < 1e-9);
  });

  it('preserves vertical drag amount when cursor moves up by a known screen offset', () => {
    // Two rays that pass through points (anchorX, y1, anchorZ) and
    // (anchorX, y2, anchorZ) on the vertical line: returned Y values must
    // equal y1 and y2 exactly — the basis of frame-rate-independent height
    // dragging at oblique camera angles.
    const anchorX = 0;
    const anchorZ = 0;
    const origin = { x: 6, y: 0, z: 4 };

    const aim = (y: number) => {
      const dx = anchorX - origin.x;
      const dy = y - origin.y;
      const dz = anchorZ - origin.z;
      const len = Math.sqrt(dx * dx + dy * dy + dz * dz);
      return { origin, direction: { x: dx / len, y: dy / len, z: dz / len } };
    };

    const y1 = closestYOnVerticalLineFromRay(aim(2), anchorX, anchorZ);
    const y2 = closestYOnVerticalLineFromRay(aim(9), anchorX, anchorZ);
    assert.ok(y1 !== null && y2 !== null);
    assert.ok(Math.abs((y1 as number) - 2) < 1e-9);
    assert.ok(Math.abs((y2 as number) - 9) < 1e-9);
  });

  it('rejects vertical rays for closest-Y-on-line (degenerate)', () => {
    const y = closestYOnVerticalLineFromRay(
      { origin: { x: 0, y: 10, z: 0 }, direction: { x: 0, y: -1, z: 0 } },
      0,
      0,
    );
    assert.strictEqual(y, null);
  });
});

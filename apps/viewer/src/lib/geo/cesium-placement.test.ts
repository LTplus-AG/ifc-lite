/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it } from 'node:test';
import assert from 'node:assert';

import {
  computeCesiumPlacement,
  computeIfcOriginHeight,
  computeOrthogonalHeightForBaseAltitude,
  getMapUnitScale,
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
});

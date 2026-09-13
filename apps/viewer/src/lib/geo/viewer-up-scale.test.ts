/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it } from 'node:test';
import assert from 'node:assert';

import type { MapConversion } from '@ifc-lite/parser';
import {
  divideByAxisScale,
  holdCameraY,
  orthogonalHeightDeltaToViewerDeltaForGeometry,
  viewerHeightDeltaToOrthogonalHeightDeltaForGeometry,
} from './viewer-up-scale.js';

describe('viewer up scale (#4675)', () => {
  it('converts gizmo height deltas through Scale x FactorZ in both directions', () => {
    const conversion: MapConversion = {
      id: 1, sourceCRS: 2, targetCRS: 3, eastings: 0, northings: 0, orthogonalHeight: 0,
      scale: 1, factorZ: 2,
    };
    // Metre units: 3 viewer units x scaleZ 2 = 6 m of OrthogonalHeight. Unscaled: 3.
    const crs = { mapUnitScale: 1 };
    assert.strictEqual(viewerHeightDeltaToOrthogonalHeightDeltaForGeometry(3, conversion, crs, 1, undefined), 6);
    assert.strictEqual(orthogonalHeightDeltaToViewerDeltaForGeometry(6, conversion, crs, 1, undefined), 3);

    const flat = { ...conversion, factorZ: 0 };
    assert.strictEqual(
      orthogonalHeightDeltaToViewerDeltaForGeometry(6, flat, crs, 1, undefined),
      0,
      'a flat authored axis must not put the preview at infinity',
    );
  });

  it('converts OrthogonalHeight map units through the map unit', () => {
    // Map unit 0.5 m, Scale 2 bridging it, so the vertical scale is 1:
    // 6 viewer units are 6 m, which is 12 map units.
    const conversion: MapConversion = {
      id: 1, sourceCRS: 2, targetCRS: 3, eastings: 0, northings: 0, orthogonalHeight: 0, scale: 2,
    };
    const crs = { mapUnitScale: 0.5 };
    assert.strictEqual(viewerHeightDeltaToOrthogonalHeightDeltaForGeometry(6, conversion, crs, 1, undefined), 12);
    assert.strictEqual(orthogonalHeightDeltaToViewerDeltaForGeometry(12, conversion, crs, 1, undefined), 6);
  });

  it('holds the camera at its world height when the frame is rebuilt', () => {
    // Frame height = P + s * (y - c); camera at y = 13.
    const before = { placementHeight: 100, viewerUpScale: 2, modelCenterY: 3 };
    // +4 m OrthogonalHeight edit at scale 2: 2 viewer units down, not 4.
    assert.strictEqual(holdCameraY(13, before, { ...before, placementHeight: 104 }), 11);
    // Scale 2 -> 1 as well: 120 m = 104 + 1 * (y - 3), so y = 19.
    assert.strictEqual(holdCameraY(13, before, { ...before, placementHeight: 104, viewerUpScale: 1 }), 19);
    // New bounds, centre 3 -> 5: the placement moves by 2 * 2 m but no fixed Y moves, so neither does the camera.
    assert.strictEqual(holdCameraY(13, before, { ...before, placementHeight: 104, modelCenterY: 5 }), 13);
    // A flat old or new frame leaves the camera where it is.
    assert.strictEqual(holdCameraY(13, before, { ...before, viewerUpScale: 0 }), 13);
    assert.strictEqual(holdCameraY(13, { ...before, viewerUpScale: 0 }, { ...before, placementHeight: 104 }), 13);
    assert.strictEqual(divideByAxisScale(4, Number.NaN), 0);
  });
});

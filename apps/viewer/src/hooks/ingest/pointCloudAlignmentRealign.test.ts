/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ModelSpatialPlacement } from './federationAlign.js';
import { realignPointCloudsToAnchor } from './pointCloudAlignmentRealign.js';
import {
  registerPointCloudAlignment,
  retargetPointCloudDecodeOrigin,
  unregisterPointCloudAlignment,
} from './pointCloudAlignmentRegistry.js';

function placement(): ModelSpatialPlacement {
  return {
    spatialReference: {
      source: { axes: ['east', 'north', 'up'], horizontalUnitToMetres: 1, verticalUnitToMetres: 1 },
      horizontal: { id: 'EPSG:2056' }, vertical: { id: 'EPSG:5729' }, confidence: 'declared',
      localToProjected: {
        kind: 'local-projected-affine', eastings: 100, northings: 0, orthogonalHeight: 0,
        xAxisAbscissa: 1, xAxisOrdinate: 0, scaleX: 1, scaleY: 1, scaleZ: 1,
      },
    },
  };
}

test('a matching anchor loaded after a scan realigns its retained native source (#5048)', () => {
  const handle = { id: 50_485 };
  const anchor = placement();
  const source = {
    ...anchor.spatialReference,
    localToProjected: {
      ...anchor.spatialReference.localToProjected!,
      eastings: 0,
      northings: 0,
      orthogonalHeight: 0,
    },
  };
  const writes: Array<Float32Array | Float64Array | null> = [];
  const renderer = { setPointCloudTransform: (_handle: { id: number }, matrix: Float32Array | Float64Array | null) => writes.push(matrix) };
  registerPointCloudAlignment(handle, undefined, true, { sourceSpatialReference: source, sourceUnit: 'mapUnit' });
  try {
    retargetPointCloudDecodeOrigin(renderer, handle, [500, 600, 20]);
    realignPointCloudsToAnchor(renderer, anchor);
    const matrix = writes.at(-1);
    assert.ok(matrix, 'matching anchor must replace the native-only transform');
    assert.equal(matrix![12], 400, 'aligned matrix rebases from the anchor map origin, not the raw decode origin');
  } finally {
    unregisterPointCloudAlignment(handle.id);
  }
});

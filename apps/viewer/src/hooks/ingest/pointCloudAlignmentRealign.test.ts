/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ModelSpatialPlacement } from './federationAlign.js';
import { canonicalRendererPlacement } from './federationCanonicalReference.js';
import { computePointCloudAlignment } from './pointCloudAlignment.js';
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

test('a foot LAS scan anchors first in canonical renderer metres and survives anchor replacement (#5048)', () => {
  const foot = 0.3048006096012192;
  const handle = { id: 50_486 };
  const scan: ModelSpatialPlacement = {
    spatialReference: {
      source: { axes: ['north', 'east', 'up'], horizontalUnitToMetres: foot, verticalUnitToMetres: foot },
      horizontal: { id: 'EPSG:2236' }, vertical: { id: 'EPSG:6360' }, confidence: 'declared',
      localToProjected: {
        kind: 'local-projected-affine', eastings: 0, northings: 0, orthogonalHeight: 0,
        xAxisAbscissa: 1, xAxisOrdinate: 0, scaleX: 1, scaleY: 1, scaleZ: 1,
      },
    },
  };
  const sourceBefore = structuredClone(scan.spatialReference.source);
  const writes: Array<Float32Array | Float64Array | null> = [];
  const renderer = { setPointCloudTransform: (_handle: { id: number }, matrix: Float32Array | Float64Array | null) => writes.push(matrix) };
  const apply = (matrix: Float32Array | Float64Array, point: readonly [number, number, number]) => [
    matrix[0] * point[0] + matrix[4] * point[1] + matrix[8] * point[2] + matrix[12],
    matrix[1] * point[0] + matrix[5] * point[1] + matrix[9] * point[2] + matrix[13],
    matrix[2] * point[0] + matrix[6] * point[1] + matrix[10] * point[2] + matrix[14],
  ];
  registerPointCloudAlignment(handle, undefined, true, { sourceSpatialReference: scan.spatialReference, sourceUnit: 'mapUnit' });
  try {
    realignPointCloudsToAnchor(renderer, canonicalRendererPlacement(scan));
    const first = writes.at(-1);
    assert.ok(first);
    assert.deepEqual(apply(first, [10, 30, -20]), [20 * foot, 30 * foot, -10 * foot],
      'scan-first destination is renderer East/Up/South metres, not its North/East foot tuple');
    assert.deepEqual(scan.spatialReference.source, sourceBefore, 'the raw scan reference remains immutable provenance');

    const replacement = canonicalRendererPlacement({
      spatialReference: {
        ...scan.spatialReference,
        localToProjected: { ...scan.spatialReference.localToProjected!, eastings: 100 },
      },
    });
    realignPointCloudsToAnchor(renderer, replacement);
    const second = writes.at(-1);
    assert.ok(second);
    const replacementTransform = computePointCloudAlignment(replacement, 'mapUnit', scan.spatialReference);
    assert.ok(replacementTransform);
    const offset = replacementTransform.decodeOriginOffset;
    const replaced = apply(second, [10 - offset[0], 30 - offset[2], -(20 - offset[1])]);
    assert.ok(Math.abs(replaced[0] - (20 * foot - 100)) < 1e-9,
      'replacing the scan anchor recomputes from raw feet into the new canonical metre frame');
  } finally {
    unregisterPointCloudAlignment(handle.id);
  }
});

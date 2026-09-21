/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { ModelSpatialPlacement } from '@/hooks/ingest/federationAlign.js';
import { georeferencedPlacementFrameKey } from './persistence.js';

function placement(mapConversionExpressId: number): ModelSpatialPlacement {
  return {
    spatialReference: {
      source: { axes: ['east', 'up', 'south'], horizontalUnitToMetres: 1, verticalUnitToMetres: 1 },
      horizontal: { id: 'EPSG:2056' }, vertical: { id: 'EPSG:5729' },
      localToProjected: { kind: 'local-projected-affine', eastings: 2_600_000, northings: 1_200_000,
        orthogonalHeight: 450, xAxisAbscissa: 1, xAxisOrdinate: 0, scaleX: 1, scaleY: 1, scaleZ: 1 },
      confidence: 'declared', sourceMetadata: { format: 'ifc', mapConversionExpressId },
    },
  };
}

describe('georeferenced placement frame identity (#5048)', () => {
  it('survives a source re-export that renumbers non-coordinate IFC entities', () => {
    assert.equal(georeferencedPlacementFrameKey(placement(31)), georeferencedPlacementFrameKey(placement(913)));
  });

  it('changes when the coordinate operation changes', () => {
    const moved = placement(31);
    const localToProjected = moved.spatialReference.localToProjected;
    assert.ok(localToProjected);
    moved.spatialReference = { ...moved.spatialReference,
      localToProjected: { ...localToProjected, eastings: 2_600_001 } };
    assert.notEqual(georeferencedPlacementFrameKey(placement(31)), georeferencedPlacementFrameKey(moved));
  });
});

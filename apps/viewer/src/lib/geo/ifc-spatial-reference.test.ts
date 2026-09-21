/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { localViewerToProjected } from '@ifc-lite/geometry';
import { spatialReferenceFromIfc } from './ifc-spatial-reference.js';

describe('IFC spatial-reference adapter (#5048)', () => {
  it('preserves IFC map conversion as a neutral f64 operation', () => {
    const reference = spatialReferenceFromIfc({
      mapConversion: { id: 2, sourceCRS: 3, targetCRS: 4, eastings: 2_600_000, northings: 1_200_000, orthogonalHeight: 450, xAxisAbscissa: 1, xAxisOrdinate: 0 },
      projectedCRS: { id: 4, name: 'EPSG:2056', verticalDatum: 'EPSG:5729' }, lengthUnitScale: 1,
    });
    assert.deepEqual(reference.horizontal, { id: 'EPSG:2056', provenance: { source: 'IfcProjectedCRS.Name' } });
    assert.deepEqual(reference.vertical, { id: 'EPSG:5729', provenance: { source: 'IfcProjectedCRS.VerticalDatum' } });
    assert.deepEqual(localViewerToProjected(reference, [12, 3, -4]), [2_600_012, 1_200_004, 453]);
    assert.ok(Object.isFrozen(reference));
    assert.ok(Object.isFrozen(reference.localToProjected));
  });

  it('does not invent a CRS identity from a projected CRS display name', () => {
    const reference = spatialReferenceFromIfc({
      mapConversion: { id: 2, sourceCRS: 3, targetCRS: 4, eastings: 0, northings: 0, orthogonalHeight: 0 },
      projectedCRS: { id: 4, name: 'Swiss local grid' }, lengthUnitScale: 1,
    });
    assert.equal(reference.horizontal, undefined);
    assert.equal(reference.confidence, 'unknown');
    assert.equal(reference.sourceMetadata?.projectedCrsName, 'Swiss local grid');
  });

  it('maps only authoritative named vertical datums and leaves ambiguous MSL unresolved (#5048)', () => {
    const reference = (verticalDatum: string) => spatialReferenceFromIfc({
      mapConversion: { id: 2, sourceCRS: 3, targetCRS: 4, eastings: 0, northings: 0, orthogonalHeight: 0 },
      projectedCRS: { id: 4, name: 'EPSG:28992', verticalDatum }, lengthUnitScale: 1,
    }).vertical?.id;
    assert.equal(reference('NAVD88'), 'EPSG:5703');
    assert.equal(reference('Normaal Amsterdams Peil'), 'EPSG:5709');
    assert.equal(reference('MSL'), undefined, 'MSL has no unique global EPSG vertical CRS');
  });
});

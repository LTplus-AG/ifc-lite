/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { findLandXmlModelSourceRecord, landXmlPickSourceRef, type LandXmlTinDocument } from './landXmlSemantics.js';

function document(sourceId: string): LandXmlTinDocument {
  return {
    format: 'landxml', schema: 'LandXML-1.2', version: '1.2',
    capabilities: { renderableTin: true, preservedOnlySurfaces: 0, unknownExtensions: 0 },
    units: { linearUnit: 'meter', elevationUnit: 'meter', linearScaleToMeters: 1, elevationScaleToMeters: 1 },
    surfaces: [{ sourceId: 'landxml:surface:1', ordinal: 1, sourcePath: 'LandXML/Surfaces/Surface[1]', properties: { name: 'EG' }, definitionProperties: { surfType: 'TIN' }, name: 'EG', kind: 'tin', renderState: 'rendered',
      points: [{ sourceId: 'landxml:surface:1:point:1', id: '1', northing: 0, easting: 0, elevation: 0 }],
      sourceDataPoints: [],
      faces: [['1', '1', '1']], faceSourceIds: [sourceId], faceVisibility: [true], hiddenFaceCount: 0,
      boundaries: [{ sourceId: 'landxml:surface:1:boundary:1', ordinal: 1, name: 'Outer', kind: 'outer', sourcePath: 'LandXML/Surfaces/Surface[1]/SourceData/Boundaries/Boundary/PntList3D', properties: { name: 'Outer', bndType: 'outer' }, coordinateDimension: 3, points: [[0, 0, 0], [1, 0, 0]], pointSourceIds: ['landxml:surface:1:boundary:1:point:1', 'landxml:surface:1:boundary:1:point:2'] }], breaklines: [], contours: [],
    }], extensions: [], warnings: [],
    rendering: { meshProvenance: [{ meshExpressId: 1, surfaceSourceId: 'landxml:surface:1', renderedFaceSourceIds: [sourceId] }],
      surfaceCounts: [{ surfaceSourceId: 'landxml:surface:1', sourcePoints: 1, sourceFaces: 1, hiddenFaces: 0, renderedFaces: 1, droppedDegenerateFaces: 0, droppedPrecisionFaces: 0, droppedReframeFaces: 0 }] },
  };
}

describe('LandXML semantic selection (#5042)', () => {
  it('keeps same local source IDs collision-safe across federated models', () => {
    const models = new Map([['a', { landXmlDocument: document('landxml:surface:1:face:1') }], ['b', { landXmlDocument: document('landxml:surface:1:face:1') }]]);
    assert.equal(findLandXmlModelSourceRecord(models, { modelId: 'a', sourceId: 'landxml:surface:1:boundary:1' })?.kind, 'boundary');
    assert.equal(findLandXmlModelSourceRecord(models, { modelId: 'missing', sourceId: 'landxml:surface:1:face:1' }), null);
  });

  it('maps an actual mesh triangle pick back to its source face', () => {
    const model = { landXmlDocument: document('landxml:surface:1:face:1') };
    assert.deepEqual(landXmlPickSourceRef(model, 'federated', 1, 0), { modelId: 'federated', sourceId: 'landxml:surface:1:face:1' });
    assert.equal(landXmlPickSourceRef(model, 'federated', 1, 2), null);
  });
});

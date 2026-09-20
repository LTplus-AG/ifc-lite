/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { FederationRegistry } from '@ifc-lite/renderer';
import { findLandXmlModelSourceRecord, landXmlPickSourceRef, landXmlPickSourceRefFromFederation, type LandXmlTinDocument } from './landXmlSemantics.js';

function document(sourceId: string, meshExpressId = 1): LandXmlTinDocument {
  return {
    format: 'landxml', schema: 'LandXML-1.2', version: '1.2',
    capabilities: { renderableTin: true, preservedOnlySurfaces: 0, unknownExtensions: 0 },
    units: { linearUnit: 'meter', elevationUnit: 'meter', linearScaleToMeters: 1, elevationScaleToMeters: 1 },
    surfaces: [{ sourceId: 'landxml:surface:1', ordinal: 1, sourcePath: 'LandXML/Surfaces/Surface[1]', properties: { name: 'EG' }, definitionProperties: { surfType: 'TIN' }, name: 'EG', kind: 'tin', renderState: 'rendered',
      points: [{ sourceId: 'landxml:surface:1:point:1', id: '1', northing: 0, easting: 0, elevation: 0 }],
      sourceDataPoints: [{ sourceId: 'landxml:surface:1:source-point:1', ordinal: 1, sourcePath: 'LandXML/Surfaces/Surface[1]/SourceData/PntList3D', coordinateDimension: 3, coordinates: [1, 2, 3] }],
      faces: [['1', '1', '1']], faceSourceIds: [sourceId], faceVisibility: [true], hiddenFaceCount: 0,
      boundaries: [{ sourceId: 'landxml:surface:1:boundary:1', ordinal: 1, name: 'Outer', kind: 'outer', sourcePath: 'LandXML/Surfaces/Surface[1]/SourceData/Boundaries/Boundary/PntList3D', properties: { name: 'Outer', bndType: 'outer' }, coordinateDimension: 3, points: [[0, 0, 0], [1, 0, 0]], pointSourceIds: ['landxml:surface:1:boundary:1:point:1', 'landxml:surface:1:boundary:1:point:2'] }], breaklines: [], contours: [],
    }], extensions: [], warnings: [], alignments: [], profiles: [], crossSections: [], crossSectionSurfaces: [], roadways: [], capabilityDiagnostics: [], preservedOnlyExtensions: [],
    rendering: { meshProvenance: [{ meshExpressId, surfaceSourceId: 'landxml:surface:1', renderedFaceSourceIds: [sourceId] }],
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

  it('uses the federation resolver before mapping a production terrain pick', () => {
    const registry = new FederationRegistry();
    registry.registerModel('building', 999_999);
    const terrainOffset = registry.registerModel('terrain', 4);
    const models = new Map([
      ['building', {}],
      ['terrain', { landXmlDocument: document('landxml:surface:1:face:1', terrainOffset + 1) }],
    ]);
    assert.deepEqual(
      landXmlPickSourceRefFromFederation({ models, findModelForGlobalId: (globalId) => registry.getModelForGlobalId(globalId) }, terrainOffset + 1),
      { modelId: 'terrain', sourceId: 'landxml:surface:1' },
      'without a PickResult triangle index the source surface is the honest pick result',
    );
  });

  it('resolves preserved SourceData points without renderer IDs', () => {
    const models = new Map([['terrain', { landXmlDocument: document('landxml:surface:1:face:1') }]]);
    const record = findLandXmlModelSourceRecord(models, {
      modelId: 'terrain', sourceId: 'landxml:surface:1:source-point:1',
    });
    assert.equal(record?.kind, 'source-data-point');
    if (record?.kind === 'source-data-point') assert.deepEqual(record.point.coordinates, [1, 2, 3]);
  });

  it('resolves retained profile-review records without assigning IFC identities (#5045)', () => {
    const source = document('landxml:surface:1:face:1');
    source.profiles.push({
      sourceId: 'landxml:profile:1:1:design:route', parentAlignmentSourceId: 'landxml:alignment:1:route', ordinal: 1,
      name: 'route', kind: 'design', pvis: [], verticalCurves: [], gradeLines: [],
    });
    const record = findLandXmlModelSourceRecord(
      new Map([['terrain', { landXmlDocument: source }]]),
      { modelId: 'terrain', sourceId: 'landxml:profile:1:1:design:route' },
    );
    assert.equal(record?.kind, 'profile');
    if (record?.kind === 'profile') assert.equal(record.profile.parentAlignmentSourceId, 'landxml:alignment:1:route');
  });
});

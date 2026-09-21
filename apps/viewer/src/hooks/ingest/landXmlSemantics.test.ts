/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { FederationRegistry } from '@ifc-lite/renderer';
import { findLandXmlModelSourceRecord, findLandXmlSourceRecord, landXmlPickSourceRef, landXmlPickSourceRefFromFederation, type LandXmlProfile, type LandXmlTinDocument } from './landXmlSemantics.js';

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

function pipeDocument(meshExpressId = 1): LandXmlTinDocument {
  const result = document('landxml:surface:1:face:1', meshExpressId);
  result.pipeNetworks = {
    version: '1.2', rootUnits: null, collections: [],
    networks: [{
      sourceId: 'landxml:pipe-network:1', sourcePath: 'LandXML/PipeNetworks/PipeNetwork[1]', name: 'storm', pipeNetworkType: 'storm', properties: {}, structureUnits: null, pipeUnits: null, features: [],
      structures: [],
      pipes: [{
        sourceId: 'landxml:pipe-network:1:pipe:1', sourcePath: 'LandXML/PipeNetworks/PipeNetwork[1]/Pipes/Pipe[1]', name: 'P-1', properties: {},
        units: { linearUnit: 'meter', elevationUnit: 'meter', diameterUnit: 'meter', widthUnit: 'meter', heightUnit: 'meter', flowUnit: null, linearScaleToMeters: 1, elevationScaleToMeters: 1, diameterScaleToMeters: 1, widthScaleToMeters: 1, heightScaleToMeters: 1 },
        connectivity: { startStructureSourceId: 'A', endStructureSourceId: 'B' }, part: { kind: 'circular', properties: {}, material: null }, geometry: { kind: 'straight', point: null }, length: null, flow: null,
      }],
    }],
    features: [], refusals: [],
  };
  result.rendering.meshProvenance = [{
    meshExpressId, surfaceSourceId: '', renderedFaceSourceIds: [], pipeSourceId: 'landxml:pipe-network:1:pipe:1',
  }];
  return result;
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

  it('keeps pipe picks model-qualified for one and many federated models (#5047)', () => {
    const singleRegistry = new FederationRegistry();
    const singleOffset = singleRegistry.registerModel('pipe-only', 1);
    const singleModels = new Map([['pipe-only', { landXmlDocument: pipeDocument(singleOffset + 1) }]]);
    assert.deepEqual(
      landXmlPickSourceRefFromFederation({ models: singleModels, findModelForGlobalId: (globalId) => singleRegistry.getModelForGlobalId(globalId) }, singleOffset + 1),
      { modelId: 'pipe-only', sourceId: 'landxml:pipe-network:1:pipe:1' },
    );

    const registry = new FederationRegistry();
    registry.registerModel('first-pipes', 1);
    const secondOffset = registry.registerModel('second-pipes', 1);
    const models = new Map([
      ['first-pipes', { landXmlDocument: pipeDocument(1) }],
      ['second-pipes', { landXmlDocument: pipeDocument(secondOffset + 1) }],
    ]);
    assert.deepEqual(
      landXmlPickSourceRefFromFederation({ models, findModelForGlobalId: (globalId) => registry.getModelForGlobalId(globalId) }, secondOffset + 1),
      { modelId: 'second-pipes', sourceId: 'landxml:pipe-network:1:pipe:1' },
      'the same local source ID must never resolve to the first pipe model',
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
      name: 'route', kind: 'design', pvis: [{ sourceId: 'landxml:profile:1:pvi:1', station: 10, elevation: 2 }],
      verticalCurves: [{ sourceId: 'landxml:profile:1:curve:1', parentProfileSourceId: 'landxml:profile:1:1:design:route', kind: 'parabolic', station: 10, elevation: 2, length: 20, lengthIn: null, lengthOut: null, radius: null }],
      gradeLines: [{ sourceId: 'landxml:profile:1:grade:1', parentProfileSourceId: 'landxml:profile:1:1:design:route', ordinal: 1, points: [{ sourceId: 'landxml:profile:1:grade:1:point:1', station: 10, elevation: 2 }] }],
    });
    const record = findLandXmlModelSourceRecord(
      new Map([['terrain', { landXmlDocument: source }]]),
      { modelId: 'terrain', sourceId: 'landxml:profile:1:1:design:route' },
    );
    assert.equal(record?.kind, 'profile');
    if (record?.kind === 'profile') assert.equal(record.profile.parentAlignmentSourceId, 'landxml:alignment:1:route');
    assert.equal(findLandXmlModelSourceRecord(
      new Map([['terrain', { landXmlDocument: source }]]),
      { modelId: 'terrain', sourceId: 'landxml:profile:1:curve:1' },
    )?.kind, 'vertical-curve');
    assert.equal(findLandXmlModelSourceRecord(
      new Map([['terrain', { landXmlDocument: source }]]),
      { modelId: 'terrain', sourceId: 'landxml:profile:1:grade:1:point:1' },
    )?.kind, 'grade-line-point');
  });

  it('opens a root roadway without touching unrelated profile child collections (#5045)', () => {
    const source = document('landxml:surface:1:face:1');
    let childReads = 0;
    const pvis: LandXmlProfile['pvis'] = new Proxy(
      Array.from({ length: 100_000 }, (_, index) => ({ sourceId: `pvi-${index}`, station: index, elevation: index })),
      { get(target, property, receiver) {
        if (property === 'length' || (typeof property === 'string' && /^\d+$/.test(property))) childReads += 1;
        return Reflect.get(target, property, receiver);
      } },
    );
    source.profiles.push({ sourceId: 'profile', parentAlignmentSourceId: 'alignment', ordinal: 1, name: 'design', kind: 'design', pvis, verticalCurves: [], gradeLines: [] });
    source.roadways.push({ sourceId: 'roadway', ordinal: 1, name: 'Route', alignmentRefs: [], alignmentSourceIds: [], surfaceRefs: [], surfaceSourceIds: [], gradeModelRefs: [] });
    assert.equal(findLandXmlSourceRecord(source, 'roadway')?.kind, 'roadway');
    assert.equal(childReads, 0, 'root selection must not scan prior profile PVIs');
  });
});

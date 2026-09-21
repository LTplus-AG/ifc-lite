/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';
import type { IfcDataStore } from '@ifc-lite/parser';
import type { CoordinateInfo, GeometryResult, ModelSpatialReference } from '@ifc-lite/geometry';
import { fixtureModel } from '@/test/store-fixture.js';
import { useViewerStore, type FederatedModel } from '../../store/index.js';
import type { LandXmlTinDocument } from './landXmlSemantics.js';
import { finalizeFederatedSpatialPlacement } from './federatedSpatialFinalize.js';

function coordinateInfo(rtcX?: number): CoordinateInfo {
  return {
    originShift: { x: 0, y: 0, z: 0 },
    originalBounds: { min: { x: 0, y: 0, z: 0 }, max: { x: 1, y: 1, z: 1 } },
    shiftedBounds: { min: { x: 0, y: 0, z: 0 }, max: { x: 1, y: 1, z: 1 } },
    hasLargeCoordinates: rtcX !== undefined,
    ...(rtcX === undefined ? {} : { wasmRtcOffset: { x: rtcX, y: 0, z: 0 } }),
  };
}

function spatialReference(eastings: number, horizontal = 'EPSG:2056'): ModelSpatialReference {
  return {
    source: { axes: ['east', 'up', 'south'], horizontalUnitToMetres: 1, verticalUnitToMetres: 1 },
    horizontal: { id: horizontal, provenance: { source: 'test' } },
    vertical: { id: 'EPSG:5729', provenance: { source: 'test' } },
    localToProjected: {
      kind: 'local-projected-affine', eastings, northings: 0, orthogonalHeight: 0,
      xAxisAbscissa: 1, xAxisOrdinate: 0, scaleX: 1, scaleY: 1, scaleZ: 1,
    },
    confidence: 'declared',
  };
}

function document(): LandXmlTinDocument {
  return {
    format: 'landxml', schema: 'LandXML-1.2', version: '1.2',
    capabilities: { renderableTin: true, preservedOnlySurfaces: 0, unknownExtensions: 0 },
    units: { linearUnit: 'meter', elevationUnit: 'meter', linearScaleToMeters: 1, elevationScaleToMeters: 1 },
    surfaces: [{
      sourceId: 'surface', ordinal: 1, sourcePath: 'LandXML/Surfaces/Surface[1]', properties: {},
      definitionProperties: {}, name: 'survey', kind: 'tin', renderState: 'rendered', points: [],
      sourceDataPoints: [], faces: [], faceSourceIds: [], faceVisibility: [], hiddenFaceCount: 0,
      boundaries: [], contours: [], breaklines: [{
        sourceId: 'line', ordinal: 1, name: null, kind: 'breakline',
        sourcePath: 'LandXML/Surfaces/Surface[1]/Breakline', properties: {}, coordinateDimension: 3,
        points: [[0, 100, 0]], pointSourceIds: [],
      }],
    }],
    extensions: [], warnings: [], alignments: [], profiles: [], crossSections: [],
    crossSectionSurfaces: [], roadways: [], capabilityDiagnostics: [],
    preservedOnlyExtensions: [], rendering: { meshProvenance: [], surfaceCounts: [] },
  };
}

beforeEach(() => useViewerStore.getState().clearAllModels());

describe('federated LandXML spatial finalization (#5048)', () => {
  it('publishes transformed overlays for a mesh-free cross-CRS document', async () => {
    const anchor = fixtureModel('anchor') as FederatedModel;
    anchor.geometryResult = { meshes: [], totalVertices: 0, totalTriangles: 0, coordinateInfo: coordinateInfo() };
    anchor.spatialReference = spatialReference(300_000, 'EPSG:32633');
    useViewerStore.setState({ models: new Map([[anchor.id, anchor]]) });
    const geometry: GeometryResult = {
      meshes: [], totalVertices: 0, totalTriangles: 0, coordinateInfo: coordinateInfo(),
    };
    const landXml = document();
    const result = await finalizeFederatedSpatialPlacement({
      dataStore: {} as IfcDataStore,
      geometry,
      modelId: 'terrain',
      fileName: 'mesh-free.xml',
      spatialReference: spatialReference(500_000, 'EPSG:32632'),
      landXmlDocument: landXml,
      isCurrent: () => true,
      setProgress: () => undefined,
    });

    assert.equal(result?.federationAlignmentStatus, 'reprojected');
    assert.equal(landXml.surfaces[0].breaklines[0].renderedPointState, 'aligned');
    assert.ok(landXml.surfaces[0].breaklines[0].renderedPoints?.[0]?.every(Number.isFinite));
  });

  it('commits an identity alignment destination frame before LandXML reframing', async () => {
    const destinationFrame = coordinateInfo();
    const anchor = fixtureModel('anchor') as FederatedModel;
    anchor.geometryResult = {
      meshes: [], totalVertices: 0, totalTriangles: 0, coordinateInfo: destinationFrame,
    };
    anchor.spatialReference = spatialReference(0);
    useViewerStore.setState({ models: new Map([[anchor.id, anchor]]) });

    // Source RTC +100 and map origin -100 cancel exactly, so the vertex map is
    // identity even though the old and destination frame metadata differ.
    const geometry: GeometryResult = {
      meshes: [{
        expressId: 1, positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]),
        normals: new Float32Array([0, 1, 0, 0, 1, 0, 0, 1, 0]), indices: new Uint32Array([0, 1, 2]),
        color: [1, 1, 1, 1], origin: [0, 0, 0],
      }],
      totalVertices: 3, totalTriangles: 1, coordinateInfo: coordinateInfo(100),
    };
    const landXml = document();

    const result = await finalizeFederatedSpatialPlacement({
      dataStore: {} as IfcDataStore,
      geometry,
      modelId: 'terrain',
      fileName: 'terrain.xml',
      spatialReference: spatialReference(-100),
      landXmlDocument: landXml,
      postAlignmentReframe: true,
      isCurrent: () => true,
      setProgress: () => undefined,
    });

    assert.equal(result?.federationAlignmentStatus, 'identity');
    assert.deepEqual(geometry.coordinateInfo.originShift, destinationFrame.originShift);
    assert.equal(geometry.coordinateInfo.wasmRtcOffset, undefined,
      'identity must still adopt the destination frame');
    assert.deepEqual(geometry.meshes[0].origin, [0, 0, 0],
      'post-alignment reframing must not add the source RTC a second time');
    assert.deepEqual(landXml.surfaces[0].breaklines[0].renderedPoints, [[0, 0, 0]],
      'identity alignment still rebuilds absolute authored overlays in the destination frame');
  });

  it('keeps source bounds when an identity IFC alignment adopts the anchor frame', async () => {
    const anchor = fixtureModel('anchor') as FederatedModel;
    anchor.geometryResult = { meshes: [], totalVertices: 0, totalTriangles: 0, coordinateInfo: coordinateInfo() };
    anchor.spatialReference = spatialReference(0);
    useViewerStore.setState({ models: new Map([[anchor.id, anchor]]) });
    const sourceBounds = { min: { x: 100, y: 0, z: 0 }, max: { x: 101, y: 1, z: 0 } };
    const geometry: GeometryResult = {
      meshes: [{
        expressId: 1, positions: new Float32Array([100, 0, 0, 101, 0, 0, 100, 1, 0]),
        normals: new Float32Array([0, 1, 0, 0, 1, 0, 0, 1, 0]), indices: new Uint32Array([0, 1, 2]),
        color: [1, 1, 1, 1], origin: [0, 0, 0],
      }],
      totalVertices: 3, totalTriangles: 1,
      coordinateInfo: { ...coordinateInfo(), originalBounds: structuredClone(sourceBounds), shiftedBounds: structuredClone(sourceBounds) },
    };

    const result = await finalizeFederatedSpatialPlacement({
      dataStore: {} as IfcDataStore, geometry, modelId: 'ifc', fileName: 'source.ifc',
      spatialReference: spatialReference(0), isCurrent: () => true, setProgress: () => undefined,
    });

    assert.equal(result?.federationAlignmentStatus, 'identity');
    assert.deepEqual(geometry.coordinateInfo.shiftedBounds, sourceBounds);
    assert.deepEqual(Array.from(geometry.meshes[0].positions), [100, 0, 0, 101, 0, 0, 100, 1, 0]);
    assert.equal(geometry.coordinateInfo.wasmRtcOffset, undefined, 'destination frame metadata is adopted');
  });
});

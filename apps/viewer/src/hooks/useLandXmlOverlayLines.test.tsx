/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import '@/test/setup-dom.js';
import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import { act } from 'react';
import { render, cleanup } from '@/test/render.js';
import { fixtureModel, fixtureModels } from '@/test/store-fixture.js';
import { useViewerStore, type FederatedModel } from '@/store/index.js';
import type { LandXmlPolyline, LandXmlTinDocument } from './ingest/landXmlSemantics.js';
import { useLandXmlOverlayLines } from './useLandXmlOverlayLines.js';

const initialState = useViewerStore.getState();

afterEach(() => {
  cleanup();
  useViewerStore.setState(initialState);
});

function line(sourceId: string, dimension: 2 | 3 = 3): LandXmlPolyline {
  return {
    sourceId,
    ordinal: 1,
    name: sourceId,
    kind: null,
    sourcePath: 'LandXML/Surfaces/Surface[1]/SourceData/Breaklines/Breakline/PntList3D',
    properties: {},
    coordinateDimension: dimension,
    points: dimension === 3 ? [[10, 20, 30], [40, 50, 60]] : [[10, 20], [40, 50]],
    pointSourceIds: [],
  };
}

function document(sourceLine: LandXmlPolyline): LandXmlTinDocument {
  return {
    format: 'landxml',
    schema: 'LandXML-1.2',
    version: '1.2',
    capabilities: { renderableTin: false, preservedOnlySurfaces: 1, unknownExtensions: 0 },
    units: { linearUnit: 'meter', elevationUnit: 'meter', linearScaleToMeters: 1, elevationScaleToMeters: 1 },
    surfaces: [{
      sourceId: 'landxml:surface:1', ordinal: 1, sourcePath: 'LandXML/Surfaces/Surface[1]',
      properties: {}, definitionProperties: {}, name: 'survey', kind: 'volume', renderState: 'preserved_only',
      points: [], sourceDataPoints: [], faces: [], faceSourceIds: [], faceVisibility: [], hiddenFaceCount: 0,
      boundaries: [], breaklines: [sourceLine], contours: [],
    }],
    extensions: [], warnings: [], rendering: { meshProvenance: [], surfaceCounts: [] },
  };
}

function landXmlModel(id: string, sourceLine: LandXmlPolyline, originShift = { x: 0, y: 0, z: 0 }): FederatedModel {
  const model = fixtureModel(id);
  model.sourceSchema = 'LandXML-1.2';
  model.landXmlDocument = document(sourceLine);
  model.geometryResult = {
    meshes: [], totalVertices: 0, totalTriangles: 0,
    coordinateInfo: {
      originShift,
      hasLargeCoordinates: false,
      originalBounds: { min: { x: 0, y: 0, z: 0 }, max: { x: 0, y: 0, z: 0 } },
      shiftedBounds: { min: { x: 0, y: 0, z: 0 }, max: { x: 0, y: 0, z: 0 } },
    },
  };
  return model;
}

describe('LandXML source overlay rendering (#5042)', () => {
  it('converts overlays in each model frame and filters a model-qualified selection across 1/N models', () => {
    const one = landXmlModel('one', line('same-source'), { x: 1, y: 2, z: 3 });
    const two = landXmlModel('two', line('same-source'), { x: 100, y: 200, z: 300 });
    useViewerStore.setState({ ...fixtureModels(one, two), selectedLandXmlSource: null });
    let vertices: Float32Array<ArrayBufferLike> = new Float32Array();
    function Probe() { vertices = useLandXmlOverlayLines(); return null; }
    render(<Probe />);

    assert.deepEqual(
      [...vertices],
      [19, 28, -13, 49, 58, -43, -80, -170, -310, -50, -140, -340],
      'all unselected records render in their own published frame',
    );

    act(() => useViewerStore.getState().setSelectedLandXmlSource({ modelId: 'two', sourceId: 'same-source' }));
    assert.deepEqual(
      [...vertices],
      [-80, -170, -310, -50, -140, -340],
      'same local source IDs cannot select the other federated model',
    );
  });

  it('does not lift a two-dimensional source list to an invented elevation', () => {
    const model = landXmlModel('two-dimensional', line('flat', 2));
    useViewerStore.setState({ ...fixtureModels(model), selectedLandXmlSource: { modelId: model.id, sourceId: 'flat' } });
    let vertices: Float32Array<ArrayBufferLike> = new Float32Array();
    function Probe() { vertices = useLandXmlOverlayLines(); return null; }
    render(<Probe />);
    assert.equal(vertices.length, 0, 'a PntList2D stays inspectable but has no fabricated 3D overlay');
  });

  it('removes overlays with federated model visibility', () => {
    const model = landXmlModel('hidden-terrain', line('boundary'));
    useViewerStore.setState({ ...fixtureModels(model), selectedLandXmlSource: null });
    let vertices: Float32Array<ArrayBufferLike> = new Float32Array();
    function Probe() { vertices = useLandXmlOverlayLines(); return null; }
    render(<Probe />);
    assert.ok(vertices.length > 0);

    act(() => useViewerStore.getState().setModelVisibility(model.id, false));
    assert.equal(vertices.length, 0, 'hidden models cannot retain source overlays');
  });

  it('refuses overlay segments outside the terrain render-frame precision limit', () => {
    const distant = line('distant');
    distant.points = [[0, 0, 0], [0, 2_000_000, 0]];
    const model = landXmlModel('distant-overlay', distant);
    useViewerStore.setState({ ...fixtureModels(model), selectedLandXmlSource: null });
    let vertices: Float32Array<ArrayBufferLike> = new Float32Array();
    function Probe() { vertices = useLandXmlOverlayLines(); return null; }
    render(<Probe />);
    assert.equal(vertices.length, 0, 'unsafe segments are refused rather than quantized into f32');
  });

  it('clears source selection on model switch and unload', () => {
    const one = landXmlModel('one', line('one'));
    const two = landXmlModel('two', line('two'));
    useViewerStore.setState({ ...fixtureModels(one, two) });
    const store = useViewerStore.getState();
    store.setSelectedLandXmlSource({ modelId: 'one', sourceId: 'one' });
    store.setSelectedModelId('two');
    assert.equal(useViewerStore.getState().selectedLandXmlSource, null, 'switching the active model clears a source selection');
    store.setSelectedLandXmlSource({ modelId: 'one', sourceId: 'one' });
    store.removeModel('one');
    assert.equal(useViewerStore.getState().selectedLandXmlSource, null, 'unloading the selected model clears its source selection');
  });
});

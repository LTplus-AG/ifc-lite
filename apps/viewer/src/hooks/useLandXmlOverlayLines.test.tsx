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
import type { LandXmlAlignment, LandXmlPolyline, LandXmlTinDocument } from './ingest/landXmlSemantics.js';
import { uploadLandXmlOverlayGuarded, useLandXmlOverlayLines } from './useLandXmlOverlayLines.js';
import { pickLandXmlOverlayLine } from '@/components/viewer/landXmlOverlayPick.js';

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

function document(sourceLine: LandXmlPolyline, lineKind: 'breakline' | 'contour' = 'breakline'): LandXmlTinDocument {
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
      boundaries: [], breaklines: lineKind === 'breakline' ? [sourceLine] : [], contours: lineKind === 'contour' ? [sourceLine] : [],
    }],
    extensions: [], warnings: [], alignments: [], profiles: [], crossSections: [], crossSectionSurfaces: [], roadways: [], capabilityDiagnostics: [], preservedOnlyExtensions: [], rendering: { meshProvenance: [], surfaceCounts: [] },
  };
}

function landXmlModel(
  id: string,
  sourceLine: LandXmlPolyline,
  originShift = { x: 0, y: 0, z: 0 },
  lineKind: 'breakline' | 'contour' = 'breakline',
): FederatedModel {
  const model = fixtureModel(id);
  model.sourceSchema = 'LandXML-1.2';
  model.landXmlDocument = document(sourceLine, lineKind);
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

function planOverlay(model: FederatedModel, cogoNorthing = 2): void {
  const point = (northing: number, easting: number) => ({ northing, easting, elevation: 0 });
  model.landXmlDocument!.plan = {
    version: '1.2', areaUnit: null, areaScaleToSquareMeters: null, warnings: [],
    cogoPoints: [{ sourceId: 'cogo', scopeId: 'scope', ordinal: 1, name: 'control', code: null, description: null, point: point(cogoNorthing, 2), pntRef: null, properties: {} }],
    monuments: [{ sourceId: 'monument', pointScopeId: null, ordinal: 1, name: 'pin', code: null, description: null, pntRef: null, point: null, properties: {} }],
    planFeatures: [{ sourceId: 'feature', ordinal: 1, name: 'curve', code: null, description: null, properties: {}, locations: [], geometry: [{
      sourceId: 'curve', ordinal: 1, kind: 'curve', pointScopeId: null,
      start: { kind: 'coordinates', point: point(0, 1), pntRef: null }, end: { kind: 'coordinates', point: point(1, 0), pntRef: null },
      center: { kind: 'coordinates', point: point(0, 0), pntRef: null }, pi: null, intermediatePoints: [], rotation: 'ccw', radius: 1, declaredLength: null, properties: {},
    }] }], parcels: [], sourceBatches: [{ sourceIds: ['cogo', 'monument', 'curve'] }], parcelProbes: [],
    resolvedMonuments: [{ sourceId: 'monument', point: point(3, 3) }],
    resolvedGeometry: [{ sourceId: 'curve', start: point(0, 1), end: point(1, 0), center: point(0, 0), pi: null }],
  };
}

describe('LandXML source overlay rendering (#5042)', () => {
  it('clears the terrain channel when a GPU upload throws', () => {
    const calls: Array<Float32Array | null> = [];
    let first = true;
    const renderer = {
      setLineOverlay(_channel: 'terrain', vertices: Float32Array | null) {
        calls.push(vertices);
        if (first) {
          first = false;
          throw new Error('device lost');
        }
      },
    };
    const vertices = new Float32Array([0, 0, 0, 1, 1, 1]);
    uploadLandXmlOverlayGuarded(renderer, vertices);
    assert.deepEqual(calls, [vertices, null]);
  });

  it('converts overlays in each model frame and filters a model-qualified selection across 1/N models', () => {
    const one = landXmlModel('one', line('same-source'), { x: 1, y: 2, z: 3 });
    const two = landXmlModel('two', line('same-source'), { x: 100, y: 200, z: 300 });
    useViewerStore.setState({ ...fixtureModels(one, two), selectedLandXmlSource: null });
    let vertices: Float32Array<ArrayBufferLike> = new Float32Array();
    function Probe() { vertices = useLandXmlOverlayLines(); return null; }
    render(<Probe />);

    assert.deepEqual(
      [...vertices].map((value) => Number(value.toFixed(4))),
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

  it('renders only exact authored alignment line spans with model-qualified selection (#5044)', () => {
    const model = landXmlModel('alignment', line('terrain'));
    const alignment: LandXmlAlignment = {
      sourceId: 'alignment:one', ordinal: 1, name: 'Main', length: 20, staStart: 100,
      profileSourceIds: [], crossSectionSourceIds: [],
      segments: [
        { sourceId: 'alignment:line', ordinal: 1, primitive: { kind: 'line', start: { kind: 'coordinates', point: { northing: 10, easting: 20, elevation: null } }, end: { kind: 'coordinates', point: { northing: 40, easting: 50, elevation: null } }, declaredLength: 20 } },
        { sourceId: 'alignment:curve', ordinal: 2, primitive: { kind: 'curve', start: { kind: 'coordinates', point: { northing: 40, easting: 50, elevation: null } }, center: { kind: 'coordinates', point: { northing: 30, easting: 50, elevation: null } }, end: { kind: 'coordinates', point: { northing: 30, easting: 60, elevation: null } }, rotation: 'clockwise', radius: 10, declaredLength: 15.7 }, renderPoints: [{ northing: 40, easting: 50, elevation: null }, { northing: 37, easting: 57, elevation: null }, { northing: 30, easting: 60, elevation: null }] },
      ],
      cantStations: [], superelevations: [], unsupportedTransitions: [],
    };
    model.landXmlDocument!.alignments = [alignment];
    useViewerStore.setState({ ...fixtureModels(model), selectedLandXmlSource: { modelId: model.id, sourceId: alignment.sourceId } });
    let vertices: Float32Array<ArrayBufferLike> = new Float32Array();
    function Probe() { vertices = useLandXmlOverlayLines(); return null; }
    render(<Probe />);
    assert.deepEqual([...vertices], [20, 0, -10, 50, 0, -40, 50, 0, -40, 57, 0, -37, 57, 0, -37, 60, 0, -30], 'curve uses canonical Rust-evaluated display samples');
    act(() => useViewerStore.getState().setSelectedLandXmlSource({ modelId: model.id, sourceId: 'alignment:curve' }));
    assert.deepEqual([...vertices], [50, 0, -40, 57, 0, -37, 57, 0, -37, 60, 0, -30], 'every sampled piece keeps the selected segment source ID');
  });

  it('renders a schema-valid two-dimensional Contour at its authored elevation (#5042)', () => {
    const contour = line('contour-2d', 2);
    contour.properties = { elev: '100' };
    const model = landXmlModel('two-dimensional-contour', contour, { x: 1, y: 2, z: 3 }, 'contour');
    model.landXmlDocument!.units = {
      linearUnit: 'foot', elevationUnit: 'foot', linearScaleToMeters: 0.3048, elevationScaleToMeters: 0.3048,
    };
    useViewerStore.setState({ ...fixtureModels(model), selectedLandXmlSource: { modelId: model.id, sourceId: contour.sourceId } });
    let vertices: Float32Array<ArrayBufferLike> = new Float32Array();
    function Probe() { vertices = useLandXmlOverlayLines(); return null; }
    render(<Probe />);

    const expected = [5.096, 28.48, -6.048, 14.24, 28.48, -15.192];
    for (const [index, coordinate] of vertices.entries()) {
      assert.ok(Math.abs(coordinate - expected[index]) < 0.000_01,
        'elev is retained in source units and converted through elevationScaleToMeters');
    }
    assert.equal(contour.coordinateDimension, 2, 'rendering must not rewrite the authored PntList2D record');
    assert.deepEqual(contour.points, [[10, 20], [40, 50]], 'the original two-dimensional coordinates remain inspectable');
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

  it('keeps a mounted hidden or selection-filtered span unpickable (#5044)', () => {
    const model = landXmlModel('pick-filter', line('visible-source'));
    const hidden = line('hidden-source');
    hidden.points = [[10, 20, 30], [40, 50, 60]];
    model.landXmlDocument!.surfaces[0].breaklines.push(hidden);
    useViewerStore.setState({ ...fixtureModels(model), selectedLandXmlSource: { modelId: model.id, sourceId: 'visible-source' } });
    function Probe() { useLandXmlOverlayLines(); return null; }
    render(<Probe />);
    const projector = { projectToScreen: (point: { x: number; y: number }) => ({ x: point.x, y: point.y }) };
    assert.equal(pickLandXmlOverlayLine(useViewerStore.getState(), projector, 20, 30, 100, 100)?.sourceId, 'visible-source');
    act(() => useViewerStore.getState().setSelectedLandXmlSource({ modelId: model.id, sourceId: 'hidden-source' }));
    assert.equal(pickLandXmlOverlayLine(useViewerStore.getState(), projector, 20, 30, 100, 100)?.sourceId, 'hidden-source');
    act(() => useViewerStore.getState().setModelVisibility(model.id, false));
    assert.equal(pickLandXmlOverlayLine(useViewerStore.getState(), projector, 20, 30, 100, 100), null);
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

  it('does not throw while rejecting finite overlays outside the safe pre-rotation frame', () => {
    const extreme = line('extreme');
    extreme.points = [[1e308, 1e308, 1e308], [1e308, 1e308, 1e308]];
    const model = landXmlModel('extreme-overlay', extreme);
    model.landXmlDocument!.units = {
      linearUnit: 'kilometer', elevationUnit: 'kilometer', linearScaleToMeters: 1000, elevationScaleToMeters: 1000,
    };
    useViewerStore.setState({ ...fixtureModels(model), selectedLandXmlSource: null });
    let vertices: Float32Array<ArrayBufferLike> = new Float32Array();
    function Probe() { vertices = useLandXmlOverlayLines(); return null; }
    assert.doesNotThrow(() => render(<Probe />));
    assert.equal(vertices.length, 0, 'scaled coordinates that overflow are rejected before placement');
  });

  it('tessellates supported plan curves and COGO/monument markers in the shared buffer (#5046)', () => {
    const model = landXmlModel('plan-overlay', line('terrain'));
    planOverlay(model);
    useViewerStore.setState({ ...fixtureModels(model), selectedLandXmlSource: { modelId: model.id, sourceId: 'curve' } });
    let vertices: Float32Array<ArrayBufferLike> = new Float32Array();
    function Probe() { vertices = useLandXmlOverlayLines(); return null; }
    render(<Probe />);
    assert.ok(vertices.length > 6, 'the curve emits bounded tessellation rather than a skipped chord');
    assert.ok([...vertices].every(Number.isFinite), 'the shared f32 upload contains only finite values');

    act(() => useViewerStore.getState().setSelectedLandXmlSource({ modelId: model.id, sourceId: 'monument' }));
    assert.equal(vertices.length, 12, 'a resolved monument has two visible marker segments under its source ID');
  });

  it('refuses finite 1e40 plan values before they become f32 Infinity (#5046)', () => {
    const model = landXmlModel('huge-plan-overlay', line('terrain'));
    planOverlay(model, 1e40);
    useViewerStore.setState({ ...fixtureModels(model), selectedLandXmlSource: { modelId: model.id, sourceId: 'cogo' } });
    let vertices: Float32Array<ArrayBufferLike> = new Float32Array();
    function Probe() { vertices = useLandXmlOverlayLines(); return null; }
    render(<Probe />);
    assert.equal(vertices.length, 0);
    assert.ok([...vertices].every(Number.isFinite));
  });

  it('keeps overlays aligned with committed and preview model translations', () => {
    const model = landXmlModel('moved-terrain', line('boundary'));
    useViewerStore.setState({ ...fixtureModels(model), selectedLandXmlSource: null });
    let vertices: Float32Array<ArrayBufferLike> = new Float32Array();
    function Probe() { vertices = useLandXmlOverlayLines(); return null; }
    render(<Probe />);

    act(() => {
      const state = useViewerStore.getState();
      state.openReposition([model.id]);
      state.previewModelTranslation([5, 6, 7]);
    });
    assert.deepEqual([...vertices], [25, 37, -16, 55, 67, -46]);

    act(() => useViewerStore.getState().applyModelTranslation());
    assert.deepEqual([...vertices], [25, 37, -16, 55, 67, -46]);
  });

  it('keeps overlays aligned with model rotation', () => {
    const model = landXmlModel('rotated-terrain', line('boundary'));
    useViewerStore.setState({ ...fixtureModels(model), selectedLandXmlSource: null });
    let vertices: Float32Array<ArrayBufferLike> = new Float32Array();
    function Probe() { vertices = useLandXmlOverlayLines(); return null; }
    render(<Probe />);

    act(() => useViewerStore.setState((state) => ({ modelPlacement: {
      ...state.modelPlacement,
      placements: new Map([[model.id, {
        translation: [0, 0, 0], rotation: { angle: Math.PI / 2, pivot: [0, 0, 0] }, locked: false,
      }]]),
      revision: state.modelPlacement.revision + 1,
    } })));
    assert.deepEqual([...vertices], [-10, 30, -20, -40, 60, -50]);
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

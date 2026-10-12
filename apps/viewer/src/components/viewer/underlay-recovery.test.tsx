/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import '@/test/setup-dom.js';
import assert from 'node:assert/strict';
import { afterEach, it } from 'node:test';
import { act, useRef, useState } from 'react';
import { importDxf } from '@ifc-lite/drawing-2d';
import { WorldLineBuffer } from '../../../../../packages/renderer/src/section-2d-line-buffer.js';
import { cleanup, render } from '@/test/render.js';
import { fixtureModel, fixtureModels } from '@/test/store-fixture.js';
import { useViewerStore } from '@/store/index.js';
import { useDxfUnderlays3DLines } from '@/hooks/useDxfUnderlay.js';
import { useLandXmlRendererOverlay } from '@/hooks/useLandXmlOverlayLines.js';
import { useDxfRendererOverlay } from './dxf-lines-3d-upload.js';
import type { RendererLineVertices } from '@/lib/renderer/line-overlay-rte.js';

const original = useViewerStore.getState();
const disposals: Array<() => void> = [];
afterEach(() => { cleanup(); disposals.splice(0).forEach(dispose => dispose()); useViewerStore.setState(original, true); });

// Authored source geometry is a stated two-point line invariant. The buffers
// below are the actual production owners; this proves replay, not hardware timing.
function landXmlModel(id: string) {
  const model = fixtureModel(id);
  model.sourceSchema = 'LandXML-1.2';
  model.landXmlDocument = {
    format: 'landxml', schema: 'LandXML-1.2', version: '1.2',
    capabilities: { renderableTin: false, preservedOnlySurfaces: 1, unknownExtensions: 0 },
    units: { linearUnit: 'meter', elevationUnit: 'meter', linearScaleToMeters: 1, elevationScaleToMeters: 1, assumed: false },
    surfaces: [{ sourceId: 'surface', ordinal: 1, sourcePath: 'LandXML/Surfaces/Surface', properties: {}, definitionProperties: {},
      name: 'survey', kind: 'volume', renderState: 'preserved_only', points: [], sourceDataPoints: [], faces: [], faceSourceIds: [],
      faceVisibility: [], hiddenFaceCount: 0, boundaries: [], contours: [], breaklines: [{ sourceId: 'line', ordinal: 1, name: 'line',
        kind: null, sourcePath: 'LandXML/Surfaces/Surface/SourceData/Breaklines/Breakline/PntList3D', properties: {},
        coordinateDimension: 3, points: [[10, 20, 30], [40, 50, 60]], pointSourceIds: [] }] }],
    extensions: [], warnings: [], alignments: [], profiles: [], crossSections: [], crossSectionSurfaces: [], roadways: [],
    capabilityDiagnostics: [], preservedOnlyExtensions: [], rendering: { meshProvenance: [], surfaceCounts: [] },
  };
  model.geometryResult = { meshes: [], totalVertices: 0, totalTriangles: 0, coordinateInfo: {
    originShift: { x: 0, y: 0, z: 0 }, hasLargeCoordinates: false,
    originalBounds: { min: { x: 0, y: 0, z: 0 }, max: { x: 0, y: 0, z: 0 } },
    shiftedBounds: { min: { x: 0, y: 0, z: 0 }, max: { x: 0, y: 0, z: 0 } },
  } };
  return model;
}

function owner() {
  Object.assign(globalThis, { GPUBufferUsage: { COPY_DST: 8, VERTEX: 32, UNIFORM: 64 } });
  const writes: number[][] = [];
  const live = new Set<GPUBuffer>();
  const device = {
    createBuffer({ size }: GPUBufferDescriptor) {
      const buffer = { size, destroy() { live.delete(buffer as unknown as GPUBuffer); } } as unknown as GPUBuffer;
      live.add(buffer); return buffer;
    },
    queue: { writeBuffer(_buffer: GPUBuffer, _offset: number, data: Float32Array) { writes.push(Array.from(data)); } },
  } as unknown as GPUDevice;
  let current = { dxf: new WorldLineBuffer(3), terrain: new WorldLineBuffer(4) };
  const target = { setLineOverlay(channel: 'dxf' | 'terrain', vertices: RendererLineVertices | null) {
    if (vertices === null) current[channel].clear(); else current[channel].upload(device, vertices);
  } };
  const dispose = () => Object.values(current).forEach(buffer => buffer.clear());
  disposals.push(dispose);
  return { target, writes, count: (channel: 'dxf' | 'terrain') => current[channel].vertexCount,
    replaceDevice() { dispose(); assert.equal(live.size, 0); current = { dxf: new WorldLineBuffer(3), terrain: new WorldLineBuffer(4) }; },
  };
}

for (const models of [1, 2]) {
  it(`replays unchanged authored DXF and LandXML into replacement owners at ${models} model(s) (#6993/#7484)`, async () => {
    const sourceModels = Array.from({ length: models }, (_, index) => landXmlModel(`m${index}`));
    useViewerStore.setState({ ...fixtureModels(...sourceModels), dxfUnderlays: [], selectedLandXmlSource: null });
    const underlay = importDxf('0\nSECTION\n2\nHEADER\n9\n$INSUNITS\n70\n6\n0\nENDSEC\n0\nSECTION\n2\nENTITIES\n0\nLINE\n8\nwall\n10\n0\n20\n0\n11\n4\n21\n3\n0\nENDSEC\n0\nEOF');
    for (let index = 0; index < models; index++) useViewerStore.getState().addDxfUnderlay(underlay);
    const sources = { models: useViewerStore.getState().models, underlays: useViewerStore.getState().dxfUnderlays };
    const native = owner();
    let recover: () => void = () => { throw new Error('unmounted'); };
    function Probe() {
      const [epoch, setEpoch] = useState(0);
      recover = () => setEpoch(value => value + 1);
      const ref = useRef(native.target);
      const vertices = useDxfUnderlays3DLines(undefined);
      useDxfRendererOverlay(ref, vertices, true, epoch);
      useLandXmlRendererOverlay(ref, true, epoch);
      return <canvas />;
    }
    const ui = render(<Probe />);
    assert.equal(native.count('dxf'), models * 2, 'actual parsed DXF source reaches the real buffer owner');
    assert.equal(native.count('terrain'), models * 2, 'actual LandXML source reaches the real buffer owner');
    const first = structuredClone(native.writes);
    native.replaceDevice();
    assert.equal(native.count('dxf'), 0); assert.equal(native.count('terrain'), 0);
    const written = native.writes.length;
    console.info('underlay-recovery-prerequisites', JSON.stringify({ models, uploaded: first.length, replacedEmpty: true }));
    await act(async () => recover());
    assert.equal(native.count('dxf'), models * 2, 'recovery epoch replays identical retained DXF input');
    assert.equal(native.count('terrain'), models * 2, 'recovery epoch replays identical retained LandXML input');
    assert.deepEqual(native.writes.slice(written), first, 'both new owners receive the original coordinates');
    assert.equal(useViewerStore.getState().models, sources.models);
    assert.equal(useViewerStore.getState().dxfUnderlays, sources.underlays);
    assert.ok(ui.querySelector('canvas'));
  });
}

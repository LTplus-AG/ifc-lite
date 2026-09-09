/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import '@/test/setup-dom.js';
import { it } from 'node:test';
import assert from 'node:assert/strict';
import { act } from 'react';
import type { GeometryResult, MeshData } from '@ifc-lite/geometry';
import { render, cleanup } from '@/test/render';
import { fixtureModel, fixtureModels } from '@/test/store-fixture';
import { useViewerStore } from '@/store';
import { emptyPlacementState } from '@/lib/model-placement/state';
import { Section2DPanel } from './Section2DPanel';

it('does not map the model mesh collection on placement previews while the drawing panel is closed (#4226)', () => {
  let maps = 0;
  const meshes: GeometryResult['meshes'] = [{ expressId: 1, positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]),
    normals: new Float32Array(9), indices: new Uint32Array([0, 1, 2]), color: [1, 1, 1, 1] }];
  const zero = { x: 0, y: 0, z: 0 };
  const geometry: GeometryResult = { meshes: new Proxy(meshes, { get(target, property, receiver) {
    if (property === 'map') maps++; return Reflect.get(target, property, receiver);
  } }), totalTriangles: 1, totalVertices: 3, coordinateInfo: {
    originShift: zero, originalBounds: { min: zero, max: zero }, shiftedBounds: { min: zero, max: zero }, hasLargeCoordinates: false } };
  useViewerStore.setState({ ...fixtureModels({ ...fixtureModel('m'), ifcDataStore: null, geometryResult: geometry }), modelPlacement: emptyPlacementState(),
    drawing2DPanelVisible: false, activeModelId: null, ifcDataStore: null, activeTool: 'select' });
  try {
    const ui = render(<Section2DPanel mergedGeometry={geometry} />);
    const initialMaps = maps;
    act(() => { const s = useViewerStore.getState(); s.openReposition(['m']); s.previewModelTranslation([100, 0, 0]); });
    assert.equal(ui.textContent, ''); assert.equal(maps, initialMaps, 'a hidden drawing panel does no placement mesh mapping');
  } finally { cleanup(); }
});

function box(
  expressId: number,
  min: [number, number, number],
  max: [number, number, number],
): MeshData {
  const [x0, y0, z0] = min;
  const [x1, y1, z1] = max;
  const positions = new Float32Array([
    x0, y0, z0,  x1, y0, z0,  x1, y1, z0,  x0, y1, z0,
    x0, y0, z1,  x1, y0, z1,  x1, y1, z1,  x0, y1, z1,
  ]);
  const indices = new Uint32Array([
    0, 1, 2,  0, 2, 3,
    4, 6, 5,  4, 7, 6,
    0, 4, 5,  0, 5, 1,
    3, 2, 6,  3, 6, 7,
    0, 3, 7,  0, 7, 4,
    1, 5, 6,  1, 6, 2,
  ]);
  return {
    expressId,
    ifcType: 'IfcWall',
    modelIndex: 0,
    positions,
    normals: new Float32Array(positions.length),
    indices,
    color: [0.5, 0.5, 0.5, 1],
    geometryClass: 0,
  };
}


it('keeps translated section lines when only the 2D panel closes (#4226)', async () => {
  const zero = { x: 0, y: 0, z: 0 }, max = { x: 10, y: 10, z: 10 };
  const geometry: GeometryResult = { meshes: [box(1, [0, 0, 0], [10, 10, 10])], totalTriangles: 12, totalVertices: 8,
    coordinateInfo: { originShift: zero, originalBounds: { min: zero, max }, shiftedBounds: { min: zero, max }, hasLargeCoordinates: false } };
  const s = useViewerStore.getState();
  useViewerStore.setState({ ...fixtureModels({ ...fixtureModel('m'), ifcDataStore: null, geometryResult: geometry }), modelPlacement: emptyPlacementState(),
    drawing2DPanelVisible: false, activeModelId: null, ifcDataStore: null, activeTool: 'select', drawing2D: null,
    drawing2DDisplayOptions: { ...s.drawing2DDisplayOptions, show3DOverlay: true },
    sectionPlane: { ...s.sectionPlane, axis: 'down', position: 50, enabled: true } });
  try {
    render(<Section2DPanel mergedGeometry={geometry} />);
    act(() => { const state = useViewerStore.getState(); state.openReposition(['m']); state.previewModelTranslation([100, 0, 0]); state.applyModelTranslation(); state.closeReposition(); state.setActiveTool('section'); });
    const waitDrawing = async () => {
      for (let i = 0; i < 100; i++) {
        await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });
        const state = useViewerStore.getState();
        if (state.drawing2DStatus === 'ready' && state.drawing2D?.lines.length) return state.drawing2D;
      }
      throw new Error('Section drawing did not complete');
    };
    const visible = await waitDrawing();
    const before = structuredClone(visible.lines);
    act(() => useViewerStore.getState().setDrawing2DPanelVisible(false));
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 600)); });
    const closed = await waitDrawing();
    assert.deepEqual(closed.lines, before, 'closing the panel cannot shift the active 3D overlay back to source coordinates');
  } finally { cleanup(); }
});

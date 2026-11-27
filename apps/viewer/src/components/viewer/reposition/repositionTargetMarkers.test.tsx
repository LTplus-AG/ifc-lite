/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import '@/test/setup-dom.js';
import { it } from 'node:test';
import assert from 'node:assert/strict';
import { act, useState } from 'react';
import { Renderer } from '@ifc-lite/renderer';
import type { MeshData } from '@ifc-lite/geometry';
import { useViewerStore } from '@/store';
import { setGlobalRendererRef } from '@/lib/renderer-ref';
import { render, cleanup } from '@/test/render';
import { fixtureModel, fixtureModels } from '@/test/store-fixture';
import { mousePointer } from '@/test/mouse-controls-fixture';
import { SnapCornerMarkers } from '../tools/SnapCornerMarkers';
import { useRepositionPicking, type PickRole } from './useRepositionPicking';

const onError = (message: string) => assert.fail(message);
function TargetPick() {
  const [role, finish] = useState<PickRole>('target');
  useRepositionPicking(role, finish, onError);
  return <SnapCornerMarkers />;
}

function model(id: string, offset: number, x: number) {
  const mesh: MeshData = { expressId: offset + 1, positions: Float32Array.of(x, 1, 0, x - 2, 1, 0, x, -2, 0),
    indices: Uint32Array.of(0, 1, 2), normals: Float32Array.of(0,0,1, 0,0,1, 0,0,1), color: [1,1,1,1] };
  const bounds = { min: { x: x - 2, y: -2, z: 0 }, max: { x, y: 1, z: 0 } };
  return { ...fixtureModel(id, { idOffset: offset }), maxExpressId: 1, geometryResult: {
    meshes: [mesh], totalTriangles: 1, totalVertices: 3, coordinateInfo: {
      originShift: { x: 0, y: 0, z: 0 }, originalBounds: bounds, shiftedBounds: bounds, hasLargeCoordinates: false,
    },
  } };
}

for (const shift of [false, true]) {
  it(`#11746 Reposition target glyph agrees with the committed move (Shift ${shift})`, async t => {
    const initial = useViewerStore.getState();
    t.after(() => { cleanup(); setGlobalRendererRef(null); useViewerStore.setState(initial, true); });
    const moving = model('moving', 0, 2.25), fixed = model('fixed', 1000, 2);
    useViewerStore.setState({ ...fixtureModels(moving, fixed), snapEnabled: true, editEnabled: true });
    const canvas = document.createElement('canvas');
    canvas.width = 800; canvas.height = 600;
    t.mock.method(canvas, 'getBoundingClientRect', () => ({ left: 0, top: 0, width: 800, height: 600 }));
    const renderer = new Renderer(canvas);
    setGlobalRendererRef({ current: renderer });
    const camera = renderer.getCamera();
    camera.setAspect(800 / 600); camera.setProjectionMode('orthographic'); camera.setOrthoSize(20);
    camera.setPosition(0, 0, 50); camera.setTarget(0, 0, 0);
    const meshes = [moving, fixed].flatMap(m => m.geometryResult.meshes);
    const handles = meshes.map(mesh => ({ expressId: mesh.expressId }));
    t.mock.method(renderer.getScene(), 'getMeshes', () => handles);
    t.mock.method(renderer.getScene(), 'getMeshDataPieces', (id: number) => meshes.filter(m => m.expressId === id));
    const state = useViewerStore.getState();
    state.openReposition(['moving']);
    state.setMoveAnchor('source', { modelId: 'moving', point: [0, 0, 0], kind: 'vertex' });
    const ui = render(<TargetPick />);
    // Aim at the ineligible moving-model corner, within four pixels of the eligible target.
    const cursor = camera.projectToScreen({ x: 2.25, y: 1, z: 0 }, 800, 600)!;
    const fire = (type: string) => act(() => { canvas.dispatchEvent(mousePointer(type, 0, cursor.x, cursor.y,
      { buttons: type === 'pointerdown' ? 1 : 0, shiftKey: shift })); });
    const expected = shift ? [2, 0, 0] : [2, 0, 1];
    const observed: boolean[] = [];
    const check = () => {
      const markers = renderer.cornerMarkers.get();
      assert.ok(markers?.candidates.length);
      assert.ok(markers.candidates.every(c => c.expressId === 1001));
      assert.ok(markers.candidates.some(c => c.position.x === 2 && c.position.y === 1));
      observed.push(!!ui.querySelector('[data-snap-corner-marker="active"]'), markers.activeIndex >= 0);
      const delta = useViewerStore.getState().modelPlacement.preview?.delta;
      assert.ok(delta && delta.every((axis, i) => axis === expected[i]));
    };
    for (let i = 0; i < 80 && !ui.querySelector('[data-snap-corner-marker]'); i++) {
      fire('pointermove');
      await act(async () => { await new Promise(resolve => setTimeout(resolve, 12)); });
    }
    check();
    fire('pointerdown');
    check();
    fire('pointerup'); fire('click');
    act(() => state.applyModelTranslation());
    assert.deepEqual(useViewerStore.getState().modelPlacement.placements.get('moving')?.translation, expected);
    assert.deepEqual(observed, Array(4).fill(!shift), 'hover and press agree with the applied endpoint');
  });
}

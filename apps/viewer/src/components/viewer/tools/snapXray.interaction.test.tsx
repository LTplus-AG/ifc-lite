/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import '@/test/setup-dom.js';
import '@/test/section-tool-ready.js';
import { afterEach, it, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { act } from 'react';
import type { MeshData } from '@ifc-lite/geometry';
import { Renderer } from '@ifc-lite/renderer';
import { useViewerStore } from '@/store';
import { setGlobalRendererRef } from '@/lib/renderer-ref';
import { click, cleanup, render } from '@/test/render';
import { fixtureModel, fixtureModels } from '@/test/store-fixture';
import { mountMouseControls, cleanupMouseControls, mousePointer } from '@/test/mouse-controls-fixture';
import { ViewportHud } from '@/components/viewport-ui/hud/ViewportHud';
import { LocalTab } from '../placement/LocalTab';
import { RepositionRuntimeHost } from '../reposition/RepositionRuntimeHost';
import { MeasureToolbar } from './MeasureToolbar';
import { SnapCornerMarkers } from './SnapCornerMarkers';

const initial = useViewerStore.getState();
afterEach(() => {
  cleanup();
  cleanupMouseControls();
  setGlobalRendererRef(null);
  useViewerStore.setState(initial, true);
});

function model(id: string, offset: number, x: number) {
  const triangle = (localId: number, positions: number[]): MeshData => ({
    expressId: offset + localId, positions: Float32Array.from(positions),
    indices: Uint32Array.of(0, 1, 2), normals: Float32Array.of(0,0,1, 0,0,1, 0,0,1), color: [1,1,1,1],
  });
  // Each eligible model has its own front occluder; filtering to a role cannot uncover its rear vertex.
  const meshes = [triangle(1, [x,2,2, x-4,2,2, x,-2,2]), triangle(2, [-12,-8,6, 12,-8,6, 0,16,6])];
  const bounds = { min: { x: -12, y: -8, z: 2 }, max: { x: 12, y: 16, z: 6 } };
  return { ...fixtureModel(id, { idOffset: offset }), maxExpressId: 2, geometryResult: {
    meshes, totalTriangles: 2, totalVertices: 6, coordinateInfo: {
      originShift: { x: 0, y: 0, z: 0 }, originalBounds: bounds, shiftedBounds: bounds, hasLargeCoordinates: false,
    },
  } };
}

function setup(t: TestContext, tool: 'select' | 'measure') {
  const moving = model('moving', 0, 0), reference = model('reference', 1000, 0.5);
  const meshes = [...moving.geometryResult.meshes, ...reference.geometryResult.meshes];
  useViewerStore.setState({ ...fixtureModels(moving, reference), activeTool: tool, measureMode: 'point',
    snapEnabled: true, editEnabled: true });
  const rendererRef = { current: null as Renderer | null };
  const { canvas } = mountMouseControls({ rendererRef, activeToolRef: { current: tool },
    snapEnabledRef: { current: true } }, (_camera, canvas) => {
    t.mock.method(canvas, 'getBoundingClientRect', () => ({ left: 0, top: 0, width: 800, height: 600 }));
    const renderer = new Renderer(canvas);
    rendererRef.current = renderer;
    const camera = renderer.getCamera();
    camera.setAspect(800 / 600);
    camera.setProjectionMode('orthographic');
    camera.setOrthoSize(20);
    camera.setPosition(0, 0, 50);
    camera.setTarget(0, 0, 0);
    const handles = meshes.map(mesh => ({ expressId: mesh.expressId }));
    t.mock.method(renderer.getScene(), 'getMeshes', () => handles);
    t.mock.method(renderer.getScene(), 'getMeshDataPieces', (id: number) => meshes.filter(mesh => mesh.expressId === id));
  });
  const renderer = rendererRef.current!;
  setGlobalRendererRef(rendererRef);
  const screen = (x: number, y = 2, z = 2) => renderer.getCamera().projectToScreen({ x, y, z }, 800, 600)!;
  const fire = (type: string, x: number, y = 2) => {
    const p = screen(x, y);
    act(() => { canvas.dispatchEvent(mousePointer(type, 0, p.x, p.y, { buttons: type === 'pointerdown' ? 1 : 0 })); });
  };
  const press = (x: number, y = 2) => { for (const type of ['pointerdown', 'pointerup', 'click']) fire(type, x, y); };
  async function hover(ui: HTMLElement, cursorX: number, vertexX: number, entity: number, y = 2, z = 2) {
    const point = screen(vertexX, y, z);
    const glyph = () => ui.querySelector('[data-snap-corner-marker="active"]')?.getAttribute('transform');
    const expected = `translate(${point.x} ${point.y})`;
    for (let i = 0; i < 80; i++) {
      fire('pointermove', cursorX, y);
      await act(async () => { await new Promise(resolve => setTimeout(resolve, 12)); });
      if (glyph() === expected) break;
    }
    assert.equal(glyph(), expected);
    const markers = renderer.cornerMarkers.get()!;
    assert.equal(markers.candidates[markers.activeIndex].expressId, entity);
    return markers;
  }
  return { renderer, press, hover };
}

it('#11518 Measure places the rear glyph with X-ray and the front surface after toggling it off', async t => {
  const { renderer, press, hover } = setup(t, 'measure');
  const ui = render(<><ViewportHud /><MeasureToolbar /><SnapCornerMarkers /></>);
  const toggle = [...ui.querySelectorAll('button')].find(button => button.textContent?.trim() === 'X-ray');
  assert.ok(toggle);
  const placed = () => useViewerStore.getState().measurePointLast!;
  press(0);
  assert.equal(placed().z, 6);
  click(toggle);
  await hover(ui, 0, 0, 1);
  press(0);
  assert.deepEqual([placed().x, placed().y, placed().z], [0, 2, 2]);
  click(toggle);
  press(0);
  assert.equal(placed().z, 6);
  assert.ok(!renderer.cornerMarkers.get()?.candidates.some(c => c.position.z === 2));
  await hover(ui, 0, 0, 2, 16, 6);
  press(0, 16);
  assert.deepEqual([placed().x, placed().y, placed().z], [0, 16, 6]);
});

it('#11518 both Reposition roles pick their occluded corner over a closer ineligible model corner', async t => {
  const { press, hover } = setup(t, 'select');
  useViewerStore.getState().openReposition(['moving']);
  const ui = render(<><RepositionRuntimeHost /><LocalTab /><SnapCornerMarkers /></>);
  const source = [...ui.querySelectorAll('button')].find(button => button.textContent === 'Pick source point');
  const toggle = ui.querySelector('[role=switch][aria-label="X-ray"]');
  assert.ok(source && toggle);
  click(source);
  click(toggle);
  // Aim directly at the other model's corner each time. The eligible one is 7.5 CSS pixels away.
  const sourceMarkers = await hover(ui, 0.5, 0, 1);
  assert.ok(sourceMarkers.candidates.every(c => c.expressId <= 2));
  press(0.5);
  const preview = () => useViewerStore.getState().modelPlacement.preview!;
  assert.deepEqual(preview().source, { modelId: 'moving', kind: 'vertex', point: [0, -2, 2] });
  const targetMarkers = await hover(ui, 0, 0.5, 1001);
  assert.ok(targetMarkers.candidates.every(c => c.expressId > 1000));
  press(0);
  assert.deepEqual(preview().target, { modelId: 'reference', kind: 'vertex', point: [0.5, -2, 2] });
});

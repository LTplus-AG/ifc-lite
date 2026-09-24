/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import '@/test/setup-dom.js';
import { it } from 'node:test';
import assert from 'node:assert/strict';
import { act } from 'react';
import type { GeometryResult, MeshData } from '@ifc-lite/geometry';
import { render, cleanup, click } from '@/test/render';
import { fixtureModel, fixtureModels } from '@/test/store-fixture';
import { useViewerStore } from '@/store';
import { emptyPlacementState } from '@/lib/model-placement/state';
import { Section2DPanel } from '../Section2DPanel';
import { DrawingRuntimeHost } from './DrawingRuntimeHost';

function box(expressId: number, size: number): MeshData {
  const positions = new Float32Array([
    0, 0, 0, size, 0, 0, size, size, 0, 0, size, 0,
    0, 0, size, size, 0, size, size, size, size, 0, size, size,
  ]);
  const indices = new Uint32Array([
    0, 1, 2, 0, 2, 3, 4, 6, 5, 4, 7, 6, 0, 4, 5, 0, 5, 1,
    3, 2, 6, 3, 6, 7, 0, 3, 7, 0, 7, 4, 1, 5, 6, 1, 6, 2,
  ]);
  return { expressId, ifcType: 'IfcWall', modelIndex: 0, positions, normals: new Float32Array(positions.length),
    indices, color: [0.5, 0.5, 0.5, 1], geometryClass: 0 };
}

/** Radix's DropdownMenu trigger opens on pointerdown, then click. */
function openMenu(trigger: Element): void {
  act(() => { trigger.dispatchEvent(new window.MouseEvent('pointerdown', { bubbles: true, cancelable: true })); });
  act(() => { trigger.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true })); });
}

async function readyDrawingOtherThan(previous: unknown) {
  for (let i = 0; i < 150; i++) {
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });
    const state = useViewerStore.getState();
    if (state.drawing2DStatus === 'ready' && state.drawing2D?.lines.length && state.drawing2D !== previous) return state.drawing2D;
  }
  throw new Error('no new section drawing was generated');
}

it("a drawing view's Regenerate runs the host's generator (#5492)", async () => {
  const zero = { x: 0, y: 0, z: 0 }, max = { x: 10, y: 10, z: 10 };
  const geometry: GeometryResult = { meshes: [box(1, 10)], totalTriangles: 12, totalVertices: 8,
    coordinateInfo: { originShift: zero, originalBounds: { min: zero, max }, shiftedBounds: { min: zero, max }, hasLargeCoordinates: false } };
  const s = useViewerStore.getState();
  useViewerStore.setState({ ...fixtureModels({ ...fixtureModel('m'), ifcDataStore: null, geometryResult: geometry }), modelPlacement: emptyPlacementState(),
    drawing2DPanelVisible: true, activeModelId: null, ifcDataStore: null, activeTool: 'select', drawing2D: null, drawing2DStatus: 'idle',
    sectionPlane: { ...s.sectionPlane, axis: 'down', position: 50, enabled: true } });
  try {
    const ui = render(<><DrawingRuntimeHost mergedGeometry={geometry} /><Section2DPanel /></>);
    const first = await readyDrawingOtherThan(null);

    // At the default window width the header collapses to Fit + the overflow menu.
    const more = ui.querySelector('[title="More options"]');
    assert.ok(more, 'the drawing view is mounted with its overflow menu');
    openMenu(more);
    const regenerate = [...document.body.querySelectorAll('[role="menuitem"]')].find((item) => item.textContent?.includes('Regenerate'));
    assert.ok(regenerate, 'the overflow menu offers Regenerate');
    click(regenerate);

    const second = await readyDrawingOtherThan(first);
    assert.notEqual(second, first, 'the view has no generator of its own; the new drawing came from the host');
  } finally { cleanup(); }
});

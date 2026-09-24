/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** The 2D drawing as the `drawing` bottom-strip panel (#5493). */
import '@/test/setup-dom.js';
import { afterEach, it } from 'node:test';
import assert from 'node:assert/strict';
import { act, useRef } from 'react';
import type { GeometryResult, MeshData } from '@ifc-lite/geometry';
import { render, cleanup, click } from '@/test/render';
import { fixtureModel, fixtureModels } from '@/test/store-fixture';
import { useViewerStore } from '@/store';
import { emptyPlacementState } from '@/lib/model-placement/state';
import { activeBottomPanel, bottomPanelFlags } from '@/lib/panels/bottom-panels';
import { usePanelControls } from '@/hooks/usePanelControls';
import { BottomStrip } from '../BottomStrip';
import { DrawingRuntimeHost } from './DrawingRuntimeHost';

function wallBox(): MeshData {
  const positions = new Float32Array([
    0, 0, 0, 10, 0, 0, 10, 10, 0, 0, 10, 0,
    0, 0, 10, 10, 0, 10, 10, 10, 10, 0, 10, 10,
  ]);
  const indices = new Uint32Array([
    0, 1, 2, 0, 2, 3, 4, 6, 5, 4, 7, 6, 0, 4, 5, 0, 5, 1,
    3, 2, 6, 3, 6, 7, 0, 3, 7, 0, 7, 4, 1, 5, 6, 1, 6, 2,
  ]);
  return { expressId: 1, ifcType: 'IfcWall', modelIndex: 0, positions, normals: new Float32Array(positions.length),
    indices, color: [0.5, 0.5, 0.5, 1], geometryClass: 0 };
}

const zero = { x: 0, y: 0, z: 0 }, max = { x: 10, y: 10, z: 10 };
const geometry: GeometryResult = { meshes: [wallBox()], totalTriangles: 12, totalVertices: 8,
  coordinateInfo: { originShift: zero, originalBounds: { min: zero, max }, shiftedBounds: { min: zero, max }, hasLargeCoordinates: false } };

function seed(patch: Partial<ReturnType<typeof useViewerStore.getState>>): void {
  const s = useViewerStore.getState();
  useViewerStore.setState({ ...fixtureModels({ ...fixtureModel('m'), ifcDataStore: null, geometryResult: geometry }),
    modelPlacement: emptyPlacementState(), activeModelId: null, ifcDataStore: null, activeTool: 'select',
    drawing2D: null, drawing2DStatus: 'idle', floatingPanels: [], poppedOutIds: [],
    sectionPlane: { ...s.sectionPlane, axis: 'down', position: 50, enabled: true }, ...bottomPanelFlags(null), ...patch });
}

async function until(check: () => boolean, what: string): Promise<void> {
  for (let i = 0; i < 150; i++) {
    if (check()) return;
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });
  }
  throw new Error(`timed out waiting for ${what}`);
}

afterEach(() => cleanup());

it('opening the Section tool docks the drawing in place of the bottom panel that was open (#5493)', () => {
  seed(bottomPanelFlags('lists'));
  render(<DrawingRuntimeHost mergedGeometry={geometry} />);
  act(() => useViewerStore.getState().setActiveTool('section'));
  const state = useViewerStore.getState();
  assert.equal(activeBottomPanel(state), 'drawing', 'the strip shows the drawing, not Lists');
  assert.equal(state.listPanelVisible, false);
});

it('a floating drawing keeps generating after another bottom panel takes the strip (#5493)', async () => {
  // Opening Lists cleared the drawing's dock flag; the drawing still floats on screen.
  seed({ ...bottomPanelFlags('lists'), floatingPanels: [{ id: 'drawing', snap: 'free', x: 0, y: 0, w: 640, h: 420 }] });
  render(<DrawingRuntimeHost mergedGeometry={geometry} />);
  await until(() => {
    const s = useViewerStore.getState();
    return s.drawing2DStatus === 'ready' && (s.drawing2D?.lines.length ?? 0) > 0;
  }, 'the floating drawing to generate');
});

it('the bottom strip renders the drawing view, and its Close closes the panel (#5493)', async () => {
  seed(bottomPanelFlags('drawing'));
  function Strip() {
    const { closePanel } = usePanelControls();
    const containerRef = useRef<HTMLDivElement>(null);
    return <div ref={containerRef}><BottomStrip dockedPanel="drawing" analysisExtension={null} containerRef={containerRef} closePanel={closePanel} /></div>;
  }
  const ui = render(<><DrawingRuntimeHost mergedGeometry={geometry} /><Strip /></>);
  await until(() => (ui.textContent ?? '').includes('Drawing'), 'the lazy drawing view');
  const close = [...ui.querySelectorAll('[aria-label="Close"]')].at(-1);
  assert.ok(close, 'the drawing view has a Close button');
  click(close);
  assert.equal(useViewerStore.getState().drawing2DPanelVisible, false);
});

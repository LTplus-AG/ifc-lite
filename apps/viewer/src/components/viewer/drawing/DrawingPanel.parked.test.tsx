/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The Drawing panel's "Section parked" contract (#5497): the Section tool no
 * longer auto-opens this panel, so a docked/floating drawing can outlive the
 * tool and keep showing a cut the store has parked
 * (`store/section-active.ts`). The panel must say so, offer Resume, and the
 * header's "Match 3D" action must apply the 3D preset view matching the cut.
 */
import '@/test/setup-dom.js';
import { afterEach, beforeEach, it } from 'node:test';
import assert from 'node:assert/strict';
import type { GeometryResult, MeshData } from '@ifc-lite/geometry';
import { render, cleanup, click } from '@/test/render';
import { fixtureModel, fixtureModels } from '@/test/store-fixture';
import { useViewerStore } from '@/store';
import { emptyPlacementState } from '@/lib/model-placement/state';
import { DrawingPanel } from './DrawingPanel';

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

function seed(patch: Partial<ReturnType<typeof useViewerStore.getState>> = {}): void {
  const s = useViewerStore.getState();
  useViewerStore.setState({ ...fixtureModels({ ...fixtureModel('m'), ifcDataStore: null, geometryResult: geometry }),
    modelPlacement: emptyPlacementState(), activeModelId: null, ifcDataStore: null, activeTool: 'select',
    drawing2D: null, drawing2DStatus: 'idle', drawing2DPanelVisible: true, annotation2DActiveTool: 'none',
    sectionPlane: { ...s.sectionPlane, axis: 'down', position: 50, enabled: false, parked: false, custom: undefined },
    ...patch });
}

const byLabel = (ui: ParentNode, label: string) => {
  const el = ui.querySelector(`[aria-label="${label}"]`);
  assert.ok(el, `a control labelled "${label}"`);
  return el;
};

beforeEach(() => seed());
afterEach(() => cleanup());

it('a parked cut shows the banner and Resume returns to the Section tool', () => {
  const s = useViewerStore.getState();
  seed({ sectionPlane: { ...s.sectionPlane, axis: 'down', position: 50, enabled: false, parked: true, custom: undefined } });
  const ui = render(<DrawingPanel />);
  assert.ok(ui.querySelector('[data-drawing-parked-banner]'), 'the parked banner is shown');
  assert.match(ui.textContent ?? '', /Section parked/);

  const resume = [...ui.querySelectorAll('button')].find((b) => b.textContent === 'Resume');
  assert.ok(resume, 'a Resume button is shown');
  click(resume);
  assert.equal(useViewerStore.getState().activeTool, 'section', 'Resume reopens the Section tool');
});

it('an active (non-parked) cut shows no banner', () => {
  const s = useViewerStore.getState();
  seed({ activeTool: 'section', sectionPlane: { ...s.sectionPlane, axis: 'down', position: 50, enabled: true, parked: false, custom: undefined } });
  const ui = render(<DrawingPanel />);
  assert.equal(ui.querySelector('[data-drawing-parked-banner]'), null, 'no banner while the Section tool holds the cut');
});

it('"Match 3D" sets orthographic projection and the preset view matching the cut axis', () => {
  const setProjectionModeCalls: string[] = [];
  const presetViewCalls: string[] = [];
  useViewerStore.setState({
    setProjectionMode: (mode) => { setProjectionModeCalls.push(mode); },
    cameraCallbacks: { setPresetView: (view) => { presetViewCalls.push(view); } },
  });
  const s = useViewerStore.getState();
  seed({ sectionPlane: { ...s.sectionPlane, axis: 'down', position: 50, flipped: false, enabled: true, parked: false, custom: undefined } });
  const ui = render(<DrawingPanel />);
  click(byLabel(ui, 'Match 3D'));
  assert.deepEqual(setProjectionModeCalls, ['orthographic']);
  assert.deepEqual(presetViewCalls, ['top'], 'a down-axis cut matches the top preset view');
});

it('"Match 3D" is disabled on a custom (face-picked) plane', () => {
  const s = useViewerStore.getState();
  seed({
    sectionPlane: {
      ...s.sectionPlane, axis: 'front', enabled: true, parked: false,
      custom: { normal: [1, 0, 0], distance: 1, pickedAt: [1, 0, 0], tangent: [0, 1, 0], bitangent: [0, 0, 1] },
    },
  });
  const ui = render(<DrawingPanel />);
  assert.ok((byLabel(ui, 'Match 3D') as HTMLButtonElement).disabled, 'a custom plane has no single matching preset view');
});

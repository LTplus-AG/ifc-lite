/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Floor plan activation (#5497): it cuts and docks the Drawing panel, and no
 * longer forces the 3D viewport into orthographic top-down on every
 * activation — that stopped being automatic. The Drawing header's "Match 3D"
 * button (`DrawingPanel.parked.test.tsx`) applies it on request instead.
 */
import '@/test/setup-dom.js';
import { afterEach, it } from 'node:test';
import assert from 'node:assert/strict';
import { act } from 'react';
import { render, cleanup } from '@/test/render.js';
import { useViewerStore } from '@/store';
import { useFloorplanView } from './useFloorplanView.js';

function Probe({ onReady }: { onReady: (activate: (storey: { expressId: number; modelId: string; name: string; elevation: number }) => void) => void }) {
  const { activateFloorplan } = useFloorplanView();
  onReady(activateFloorplan);
  return null;
}

afterEach(() => cleanup());

it('cuts a plan section, opens the Drawing panel docked, and does not touch the 3D camera', () => {
  const setProjectionModeCalls: string[] = [];
  const presetViewCalls: string[] = [];
  useViewerStore.setState({
    activeTool: 'select', drawing2DPanelVisible: false, listPanelVisible: false,
    models: new Map(), ifcDataStore: null,
    sectionPlane: { ...useViewerStore.getState().sectionPlane, axis: 'front', position: 10, enabled: false, parked: false },
    setProjectionMode: (mode) => { setProjectionModeCalls.push(mode); },
    cameraCallbacks: { setPresetView: (view) => { presetViewCalls.push(view); } },
  });

  let activate: ((storey: { expressId: number; modelId: string; name: string; elevation: number }) => void) | null = null;
  render(<Probe onReady={(fn) => { activate = fn; }} />);
  assert.ok(activate, 'the hook returned activateFloorplan');

  act(() => activate!({ expressId: 1, modelId: 'legacy', name: 'Level 1', elevation: 0 }));

  const state = useViewerStore.getState();
  assert.equal(state.sectionPlane.axis, 'down', 'floorplan cuts along the down axis');
  assert.equal(state.activeTool, 'section', 'the Section tool is activated so the cut is visible');
  assert.equal(state.drawing2DPanelVisible, true, 'the Drawing panel is docked open');
  assert.deepEqual(setProjectionModeCalls, [], 'projection mode is left alone — no forced ortho');
  assert.deepEqual(presetViewCalls, [], 'the 3D camera is left alone — no forced top-down preset');
});

/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The Model workspace shell around the session (charter #6232, M2.1): the
 * sidebar hands over to the Model inspector and gets its panel back on exit,
 * the Plan ‖ 3D layout persists, the workplane layer and the onboarding hint
 * exist only inside the workspace, and new walls take the workspace
 * defaults.
 */

import '@/test/setup-dom.js';
import { installLayout } from '@/test/dom-layout.js';
installLayout();
import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { act } from 'react';
import { useViewerStore } from '@/store';
import { cleanup, render } from '@/test/render.js';
import { MODEL_ID, seedModelingSession } from '@/test/modeling-session-fixture';
import '@/lib/commands/modeling/builtin';
import { commandPointerDown, commandPointerMove } from '@/lib/commands/modeling/runtime';
import { renderScene } from '@/components/viewport-ui/scene/test/scene-test-support';
import { ViewportHud } from '@/components/viewport-ui/hud';
import { ToolOverlays } from '@/components/viewer/ToolOverlays';
import { ModelInspectorPanel } from '@/components/viewer/model-inspector/ModelInspectorPanel';
import { loadModelLayout } from './authoringSessionSidebar.js';

const at = (x: number, y: number) => ({ local: [x, y] as const, winner: null, guides: [], locked: false });
const outlines = (root: ParentNode) => [...root.querySelectorAll('[data-scene-primitive="plane-outline"]')] as SVGPolygonElement[];

beforeEach(async () => {
  await seedModelingSession();
  localStorage.clear();
  useViewerStore.setState({ editEnabled: false, selectedEntityId: null, isMobile: false });
  useViewerStore.getState().showWorkspacePanel('changes');
});
afterEach(() => {
  cleanup();
  useViewerStore.getState().exitModelWorkspace();
});

describe('Model workspace sidebar hand-over (#6232 M2.1)', () => {
  it('entry shows the Model inspector; leaving puts the previous panel back', () => {
    useViewerStore.getState().enterModelWorkspace();
    assert.equal(useViewerStore.getState().sidebarActivePanel, 'model');
    useViewerStore.getState().exitModelWorkspace();
    assert.equal(useViewerStore.getState().sidebarActivePanel, 'changes');
  });

  it("a panel the user opened meanwhile stays: their choice wins", () => {
    useViewerStore.getState().enterModelWorkspace();
    useViewerStore.getState().showWorkspacePanel('bcf');
    useViewerStore.getState().exitModelWorkspace();
    assert.equal(useViewerStore.getState().sidebarActivePanel, 'bcf');
  });

  it('the panel comes back when the workspace closes under the user (its model removed)', () => {
    useViewerStore.getState().enterModelWorkspace();
    assert.equal(useViewerStore.getState().sidebarActivePanel, 'model');
    useViewerStore.getState().removeModel(MODEL_ID);
    assert.equal(useViewerStore.getState().workspaceMode, 'view');
    assert.equal(useViewerStore.getState().sidebarActivePanel, 'changes');
  });

  it('phones keep their sheet shut: nothing is taken over', () => {
    useViewerStore.setState({ isMobile: true });
    useViewerStore.getState().enterModelWorkspace();
    assert.equal(useViewerStore.getState().sidebarActivePanel, 'changes');
  });

  it('the inspector says how to start, inside and outside the workspace', () => {
    const ui = render(<ModelInspectorPanel />);
    assert.match(ui.textContent ?? '', /Enter the Model workspace to edit/);
    act(() => { useViewerStore.getState().enterModelWorkspace(); });
    assert.match(ui.textContent ?? '', /Pick a tool in the rail, or select an element/);
  });
});

describe('Model workspace layout (#6232 M2.1)', () => {
  it('3D alone by default; a chosen layout persists per browser', () => {
    assert.equal(loadModelLayout(), '3d');
    useViewerStore.getState().setModelLayout('split');
    assert.equal(useViewerStore.getState().modelLayout, 'split');
    assert.equal(loadModelLayout(), 'split', 'a new session starts from it');
    localStorage.setItem('ifc-lite:model-layout', 'sideways');
    assert.equal(loadModelLayout(), '3d', 'an unknown value falls back');
    useViewerStore.getState().setModelLayout('3d');
  });
});

describe('Model workspace scene layer (#6232 M2.1)', () => {
  it('draws the workplane outline and origin ticks only while the workspace is open', () => {
    const { container, flush } = renderScene(<ToolOverlays />);
    flush();
    assert.equal(outlines(container).length, 0, 'nothing while viewing');
    act(() => { useViewerStore.getState().enterModelWorkspace(); });
    flush();
    const drawn = outlines(container);
    assert.equal(drawn.length, 3, 'the outline and two origin ticks');
    assert.ok(drawn.every((p) => p.style.display !== 'none' && (p.getAttribute('points') ?? '').length > 0));
    assert.match(drawn[0].getAttribute('class') ?? '', /stroke-dasharray/, 'the outline is dashed');
    act(() => { useViewerStore.getState().exitModelWorkspace(); });
    flush();
    assert.equal(outlines(container).length, 0, 'leaving clears it');
  });

  it('the onboarding hint shows in Select until the first edit, then never again', () => {
    render(<><ViewportHud /><ToolOverlays /></>);
    const hint = () => document.querySelector('[data-model-onboarding-hint]');
    act(() => { useViewerStore.getState().enterModelWorkspace(); });
    assert.match(hint()?.textContent ?? '', /W draws a wall/);
    act(() => {
      useViewerStore.getState().startCommand('wall.place');
      commandPointerMove(at(0, 0)); commandPointerDown(at(0, 0));
      commandPointerMove(at(4, 0)); commandPointerDown(at(4, 0));
    });
    act(() => { useViewerStore.getState().setActiveTool('select'); });
    assert.equal(hint(), null, 'retired by the first wall');
    assert.equal(localStorage.getItem('ifc-lite:model-hint-seen'), '1');
  });
});

describe('Workspace defaults (#6232 M2.1)', () => {
  it('wall.place builds with the wall defaults', () => {
    useViewerStore.getState().setAuthoringDims('wall', { Thickness: 0.35, Height: 2.5 });
    useViewerStore.getState().enterModelWorkspace({ command: 'wall.place' });
    commandPointerMove(at(0, 0)); commandPointerDown(at(0, 0));
    commandPointerMove(at(3, 0)); commandPointerDown(at(3, 0));
    const s = useViewerStore.getState();
    const wall = s.mutationViews.get(MODEL_ID)!.getNewEntities().find((e) => e.type.toUpperCase() === 'IFCWALL')!;
    const read = s.readWallEndpoints(MODEL_ID, wall.expressId)!;
    assert.ok(Math.abs(read.thickness - 0.35) < 1e-9, `thickness ${read.thickness}`);
    assert.ok(Math.abs(read.height - 2.5) < 1e-9, `height ${read.height}`);
    s.setAuthoringDims('wall', { Thickness: 0.2, Height: 3 });
  });

  it('type picks die with their model; dimensions outlive it', () => {
    const s = useViewerStore.getState();
    s.setAuthoringDims('slab', { Thickness: 0.25 });
    s.setAuthoringDefaults({ typeIds: { wall: { modelId: MODEL_ID, expressId: 900 }, slab: { modelId: 'other', expressId: 7 } } });
    s.removeModel(MODEL_ID);
    const after = useViewerStore.getState().authoringDefaults;
    assert.deepEqual(after.typeIds, { slab: { modelId: 'other', expressId: 7 } });
    assert.equal(after.dims.slab.Thickness, 0.25);
    useViewerStore.getState().resetViewerState();
    assert.deepEqual(useViewerStore.getState().authoringDefaults.typeIds, {}, 'a file swap drops every pick');
    useViewerStore.getState().setAuthoringDims('slab', { Thickness: 0.3 });
  });
});

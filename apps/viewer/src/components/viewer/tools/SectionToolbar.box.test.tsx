/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The Section bar's Box entry (#5513, #7545): choosing "Box" from the Add plane
 * menu adds a plane holding a box fitted to the selection (through the same
 * bounds Frame uses) or else the model; the bar then reads the box's size and
 * offers Fit while the plane-only controls (flip, distance, Cap) step aside;
 * adding a cardinal plane afterwards leaves the box plane as it was and brings
 * the plane controls back. Asserted on the OUTPUT — the store's box, the
 * rendered text, the hint — never on the wiring. Bounds here are the merged
 * model box [0,10] x [-1,3] x [0,8].
 */

import '@/test/setup-dom.js';
import '@/test/section-tool-ready.js';
import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { act } from 'react';
import { render, cleanup, click } from '@/test/render.js';
import { useViewerStore, type FederatedModel } from '@/store';
import { getDefaultSectionPlane } from '@/store/slices/sectionSlice.js';
import { fixtureModel } from '@/test/store-fixture.js';
import { addPlaneFromMenu } from '@/test/section-bar.js';
import { ViewportHud } from '../../viewport-ui/hud/ViewportHud.js';
import { ToolOverlays } from '../ToolOverlays.js';
import { SceneOverlayRoot } from '@/components/viewport-ui/scene';

const s = () => useViewerStore.getState();

function boundedModel(): FederatedModel {
  const base = fixtureModel('m');
  return {
    ...base,
    geometryResult: {
      meshes: [], totalVertices: 0, totalTriangles: 0,
      coordinateInfo: {
        originShift: { x: 0, y: 0, z: 0 },
        originalBounds: { min: { x: 0, y: -1, z: 0 }, max: { x: 10, y: 3, z: 8 } },
        shiftedBounds: { min: { x: 0, y: -1, z: 0 }, max: { x: 10, y: 3, z: 8 } },
        hasLargeCoordinates: false,
      },
    },
  } as unknown as FederatedModel;
}

beforeEach(() => {
  window.localStorage.clear();
  const model = boundedModel();
  useViewerStore.setState({
    activeTool: 'section',
    sectionPlane: getDefaultSectionPlane(),
    inactiveSectionPlanes: [],
    sectionUndo: null,
    sectionPickMode: false,
    sectionPickPreview: null,
    models: new Map([[model.id, model]]),
    activeModelId: model.id,
    geometryResult: null,
    ifcDataStore: null,
    selectedEntityId: null,
    selectedEntityIds: new Set(),
    cameraCallbacks: {},
    pointCloudAssetCount: 0,
    pointCloudPreviewStride: 1,
    drawing2DPanelVisible: false,
    floatingPanels: [],
    poppedOutIds: [],
  } as unknown as Partial<ReturnType<typeof useViewerStore.getState>>);
  // The tool opens on a known cut: one Down plane at 50 %, named A (opening the tool restores nothing, #7545).
  useViewerStore.getState().addSectionPlane('down');
});
afterEach(() => { cleanup(); window.localStorage.clear(); });

const renderTool = () => render(<><ViewportHud /><SceneOverlayRoot><ToolOverlays /></SceneOverlayRoot></>);
const bar = () => document.querySelector<HTMLElement>('[data-hud-region="top-center"] [data-tool-bar="section"]')!;
const chip = (name: string) => [...bar().querySelectorAll<HTMLButtonElement>('[role="tab"]')].find((b) => b.textContent?.trim() === name);
const button = (label: string) => [...bar().querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent?.trim() === label);
const hint = () => document.querySelector('[data-hud-region="bottom-center"]')?.textContent?.trim();

describe('Section bar: Box entry (#5513, #7545)', () => {
  it('fits the box to the model when nothing is selected, and the bar re-lays out around it', () => {
    renderTool();
    assert.equal(s().sectionPlane.box, undefined, 'no box before it is asked for');
    assert.equal(chip('B'), undefined);
    addPlaneFromMenu('Box');
    const plane = s().sectionPlane;
    assert.deepEqual(plane.box, { min: [0, -1, 0], max: [10, 3, 8] }, 'the merged model bounds');
    assert.equal(plane.enabled, true);
    assert.equal(plane.name, 'B', 'the box is a new plane; plane A is not replaced');
    assert.equal(chip('B')?.getAttribute('aria-selected'), 'true');
    assert.equal(chip('A')?.getAttribute('aria-selected'), 'false');
    assert.equal(s().inactiveSectionPlanes.length, 1);
    assert.equal(bar().querySelector('[data-testid="section-box-size"]')?.textContent?.trim(), '10.00 × 4.00 × 8.00 m');
    assert.equal(bar().querySelector('[role="spinbutton"]'), null, 'no distance field in box mode');
    assert.equal(button('Cap'), undefined, 'a box has no cap');
    assert.equal(button('Fit')?.title, 'Fit the box to the model');
    assert.equal(hint(), 'Drag a face handle to resize the box · Fit snaps it to the selection · Esc to finish');
  });

  it('fits the box to the selection through the camera callbacks\' bounds, and Fit refits after a drag', () => {
    let asked = 0;
    useViewerStore.setState({
      selectedEntityId: 42,
      selectedEntityIds: new Set([42]),
      cameraCallbacks: { selectionBounds: () => { asked++; return { min: { x: 2, y: 0, z: 1 }, max: { x: 4, y: 2.5, z: 3 } }; } },
    });
    renderTool();
    addPlaneFromMenu('Box');
    assert.equal(asked, 1);
    assert.deepEqual(s().sectionPlane.box, { min: [2, 0, 1], max: [4, 2.5, 3] });
    assert.equal(button('Fit')?.title, 'Fit the box to the selection');
    act(() => s().setSectionBoxFace('maxX', 9));
    assert.equal(bar().querySelector('[data-testid="section-box-size"]')?.textContent?.trim(), '7.00 × 2.50 × 2.00 m');
    click(button('Fit')!);
    assert.equal(asked, 2);
    assert.deepEqual(s().sectionPlane.box, { min: [2, 0, 1], max: [4, 2.5, 3] });
  });

  it('with a selection whose bounds cannot be resolved, falls back to the model', () => {
    useViewerStore.setState({ selectedEntityId: 42, cameraCallbacks: { selectionBounds: () => null } });
    renderTool();
    addPlaneFromMenu('Box');
    assert.deepEqual(s().sectionPlane.box, { min: [0, -1, 0], max: [10, 3, 8] });
  });

  it('adding a cardinal plane after a box leaves the box plane alone and brings the distance field back', () => {
    renderTool();
    addPlaneFromMenu('Box');
    addPlaneFromMenu('Front (Y)');
    assert.equal(s().sectionPlane.box, undefined, 'the new active plane is a plain cut');
    assert.equal(s().sectionPlane.axis, 'front');
    assert.equal(s().sectionPlane.name, 'C');
    assert.equal(chip('C')?.getAttribute('aria-selected'), 'true');
    assert.deepEqual(s().inactiveSectionPlanes.find((p) => p.name === 'B')?.box, { min: [0, -1, 0], max: [10, 3, 8] }, 'adding never replaces the box plane');
    assert.ok(bar().querySelector('[role="spinbutton"]'), 'the distance field is back');
    assert.ok(button('Cap'), 'Cap is back');
  });

  it('activating the box plane again brings the box controls back', () => {
    renderTool();
    addPlaneFromMenu('Box');
    addPlaneFromMenu('Front (Y)');
    click(chip('B')!);
    assert.deepEqual(s().sectionPlane.box, { min: [0, -1, 0], max: [10, 3, 8] });
    assert.equal(bar().querySelector('[data-testid="section-box-size"]')?.textContent?.trim(), '10.00 × 4.00 × 8.00 m');
    assert.equal(bar().querySelector('[role="spinbutton"]'), null, 'no distance field in box mode');
  });

  it('Cut off keeps the box and says so in the hint', () => {
    renderTool();
    addPlaneFromMenu('Box');
    click([...bar().querySelectorAll<HTMLButtonElement>('button[aria-pressed]')].find((b) => b.textContent?.trim() === 'Cut')!);
    assert.equal(s().sectionPlane.enabled, false);
    assert.deepEqual(s().sectionPlane.box, { min: [0, -1, 0], max: [10, 3, 8] });
    assert.equal(hint(), 'Cut is off · turn on Cut to clip the model');
  });
});

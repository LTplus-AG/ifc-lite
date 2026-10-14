/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Saved cuts hold the whole plane set (#7545): the planes that were cutting with their
 * names and the active one, the zoom, and the exact camera. Applying one replaces
 * everything and restores the view, not only the geometry.
 */

import '@/test/setup-dom.js';
import { beforeEach, afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { Renderer } from '@ifc-lite/renderer';
import { useViewerStore } from './index.js';
import { clearGlobalRefs, setGlobalRendererRef } from '@/hooks/useBCF.js';
import { orderedSectionPlanes } from '@/lib/section/section-plane-set';
import { DEFAULT_SECTION_ZOOM } from '@/lib/section/section-zoom-spec';
import type { CameraViewpoint } from './types.js';
import { applySavedSectionCut, saveCurrentSectionCut, useSavedSectionCuts } from './savedSectionCutsStore.js';

const state = () => useViewerStore.getState();
const VIEW_A: CameraViewpoint = { position: { x: 5, y: 6, z: 7 }, target: { x: 1, y: 2, z: 3 }, up: { x: 0, y: 1, z: 0 }, fov: 0.8, projectionMode: 'perspective' };

let applied: Array<{ viewpoint: CameraViewpoint; animate?: boolean }> = [];
let framed: Array<{ padding?: number }> = [];
let currentView: CameraViewpoint | null = VIEW_A;

/** What each plane cuts, id- and order-independent: the half-spaces and the names a user sees. */
const summary = () => orderedSectionPlanes(state().sectionPlane, state().inactiveSectionPlanes).map((p) => ({
  name: p.name, axis: p.axis, position: p.position, flipped: p.flipped, enabled: p.enabled, active: p.id === state().sectionPlane.id, box: p.box,
}));

beforeEach(() => {
  applied = []; framed = [];
  currentView = VIEW_A;
  state().resetViewerState();
  useSavedSectionCuts.setState({ cuts: [], activeCutId: null });
  useViewerStore.setState({
    sectionZoom: DEFAULT_SECTION_ZOOM,
    cameraCallbacks: {
      getViewpoint: () => currentView,
      applyViewpoint: (viewpoint, animate) => { applied.push({ viewpoint, animate }); },
      selectionBounds: () => ({ min: { x: 0, y: 0, z: 0 }, max: { x: 2, y: 2, z: 2 } }),
      frameBounds: async (_min, _max, options) => { framed.push({ padding: options?.padding }); return true; },
    },
  });
  setGlobalRendererRef({ current: { getCamera: () => ({ getSceneBounds: () => ({ min: { x: 0, y: 0, z: 0 }, max: { x: 10, y: 6, z: 4 } }) }) } as unknown as Renderer });
});
afterEach(() => clearGlobalRefs());

/** Three planes: A (down 40), B (front 60 flipped, named "East wall"), C (side 25, cut off); B active. */
function threePlanes() {
  state().setActiveTool('section');
  state().addSectionPlane('down'); state().setSectionPlanePosition(40);
  const b = state().addSectionPlane('front')!; state().setSectionPlanePosition(60); state().flipSectionPlane(); state().renameSectionPlane(b, 'East wall');
  const c = state().addSectionPlane('side')!; state().setSectionPlanePosition(25);
  state().setSectionPlaneCutting(c, false);
  state().activateSectionPlane(b);
}

describe('saving and applying a set of planes (#7545)', () => {
  it('saves the planes that cut, with names and the active one, and restores them exactly after everything changed', () => {
    threePlanes();
    const before = summary().filter((p) => p.enabled);
    const id = saveCurrentSectionCut('Set 1');
    const saved = useSavedSectionCuts.getState().cuts[0]!;
    assert.deepEqual(saved.planes.map((p) => p.axis), ['down', 'front'], 'the plane that was not cutting is not part of the cut');
    assert.equal(saved.activeIndex, 1);

    // Change everything: clear all, make something unrelated, close the tool.
    state().clearSectionPlanes();
    state().addSectionPlane('side');
    state().setSectionPlanePosition(90);
    state().setActiveTool('select');

    applySavedSectionCut(id);
    assert.deepEqual(summary(), before, 'same planes, names, positions, flips, and the same active plane');
    assert.equal(state().activeTool, 'section');
    assert.equal(state().sceneState.section.visible, true);
    assert.equal(useSavedSectionCuts.getState().activeCutId, id);
  });

  it('applying replaces the whole set, including a box and the planes that were there', () => {
    threePlanes();
    const id = saveCurrentSectionCut('Planes');
    state().addSectionPlane('side');
    state().setSectionBox({ min: [0, 0, 0], max: [1, 1, 1] });
    applySavedSectionCut(id);
    const planes = summary();
    assert.equal(planes.length, 2, 'the plane and the box added since are gone');
    assert.ok(planes.every((p) => p.box === undefined));
  });

  it('a box plane is saved as a box and comes back as one', () => {
    state().setActiveTool('section');
    state().setSectionBox({ min: [0, 0, 0], max: [4, 3, 2] });
    const id = saveCurrentSectionCut('Box');
    state().clearSectionPlanes();
    applySavedSectionCut(id);
    assert.deepEqual(state().sectionPlane.box, { min: [0, 0, 0], max: [4, 3, 2] });
    assert.equal(state().sectionPlane.enabled, true);
  });

  it('with nothing cutting, the active plane is what is saved', () => {
    state().setActiveTool('section');
    state().addSectionPlane('front');
    state().setSectionPlaneEnabled(false);
    saveCurrentSectionCut('Preview');
    assert.equal(useSavedSectionCuts.getState().cuts[0]!.planes.length, 1);
  });
});

describe('what applying does to the camera (#7545)', () => {
  it('restores the exact camera it was saved with, and does not re-frame', () => {
    threePlanes();
    const id = saveCurrentSectionCut('With view');
    currentView = { ...VIEW_A, position: { x: 99, y: 99, z: 99 } };
    applySavedSectionCut(id);
    assert.deepEqual(applied, [{ viewpoint: VIEW_A, animate: true }]);
    assert.deepEqual(framed, []);
  });

  it('with no camera saved, frames the saved zoom instead', async () => {
    threePlanes();
    state().setSectionZoom({ target: 'cut-region', margin: { kind: 'fraction', value: 0.25 } });
    currentView = null;
    const id = saveCurrentSectionCut('No camera');
    assert.deepEqual(useSavedSectionCuts.getState().cuts[0]!.zoom, { target: 'cut-region', margin: { kind: 'fraction', value: 0.25 } });
    state().setSectionZoom(DEFAULT_SECTION_ZOOM);
    applySavedSectionCut(id);
    await new Promise((r) => setTimeout(r, 0));
    assert.equal(applied.length, 0);
    assert.equal(framed.length, 1);
    assert.ok(Math.abs(framed[0]!.padding! - 1.5) < 1e-9, '25 % each side of the cut area');
  });
});

/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * What each zoom target frames (#7545), through the real store and the planes the
 * user made: the selection's bounds, the model, and the cut area, the part of the
 * model the enabled planes leave.
 */

import '@/test/setup-dom.js';
import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { Renderer } from '@ifc-lite/renderer';
import { useViewerStore } from '@/store/index.js';
import { fixtureModel } from '@/test/store-fixture.js';
import { clearGlobalRefs, setGlobalRendererRef } from '@/hooks/useBCF.js';
import { cutRegionBounds, zoomToSectionTarget } from './section-zoom.js';

const state = () => useViewerStore.getState();
/** A 10 x 6 x 4 m model with its minimum corner at the origin. */
const MODEL = { min: { x: 0, y: 0, z: 0 }, max: { x: 10, y: 6, z: 4 } };

function fakeRenderer(): Renderer {
  const camera = { getSceneBounds: () => MODEL };
  return { getCamera: () => camera } as unknown as Renderer;
}

interface Frame { min: { x: number; y: number; z: number }; max: { x: number; y: number; z: number }; padding?: number; durationMs?: number }
let frames: Frame[] = [];

beforeEach(() => {
  frames = [];
  state().resetViewerState();
  useViewerStore.setState({
    models: new Map([['m', { ...fixtureModel('m'), geometryResult: {
      meshes: [], totalVertices: 0, totalTriangles: 0,
      coordinateInfo: { originShift: { x: 0, y: 0, z: 0 }, originalBounds: MODEL, shiftedBounds: MODEL, hasLargeCoordinates: false },
    } }]]),
    cameraCallbacks: {
      selectionBounds: () => ({ min: { x: 2, y: 1, z: 0 }, max: { x: 4, y: 2, z: 1 } }),
      frameBounds: async (min, max, options) => { frames.push({ min, max, ...options }); return true; },
    },
  });
  setGlobalRendererRef({ current: fakeRenderer() });
});
afterEach(() => clearGlobalRefs());

describe('zoom targets (#7545)', () => {
  it('the selection is framed with the margin as a multiple of its largest extent', async () => {
    const done = await zoomToSectionTarget(state(), { target: 'selection', margin: { kind: 'fraction', value: 0.1 } });
    assert.equal(done, true);
    assert.deepEqual(frames[0]!.max, { x: 4, y: 2, z: 1 });
    assert.ok(Math.abs(frames[0]!.padding! - 1.2) < 1e-12);
  });

  it('the whole model is the scene bounds', async () => {
    await zoomToSectionTarget(state(), { target: 'model', margin: { kind: 'metres', value: 1 } });
    assert.deepEqual([frames[0]!.min, frames[0]!.max], [MODEL.min, MODEL.max]);
    assert.ok(Math.abs(frames[0]!.padding! - 1.2) < 1e-12, '1 m each side of a 10 m extent');
  });

  it('with no planes the cut area is the whole model', () => {
    assert.deepEqual(cutRegionBounds(state()), MODEL);
  });

  it('the cut area is what the ENABLED planes leave, whichever plane is active', async () => {
    state().setActiveTool('section');
    state().addSectionPlane('side'); // x
    state().setSectionPlanePosition(30); // keeps x <= 3
    state().addSectionPlane('down'); // y
    state().setSectionPlanePosition(50); // keeps y <= 3
    const keptBy = (active: 'x' | 'y') => {
      const region = cutRegionBounds(state())!;
      return { active, max: [region.max.x, region.max.y, region.max.z] };
    };
    const first = keptBy('y');
    assert.deepEqual(first.max.map((v) => Number(v.toFixed(6))), [3, 3, 4], 'both planes narrow the model');

    state().activateSectionPlane(state().inactiveSectionPlanes[0]!.id);
    assert.deepEqual(keptBy('x').max.map((v) => Number(v.toFixed(6))), [3, 3, 4], 'selection of the plane changes nothing');

    state().setSectionPlaneEnabled(false);
    const region = cutRegionBounds(state())!;
    assert.equal(Number(region.max.x.toFixed(6)), 10, 'a plane whose Cut is off removes nothing');
    assert.equal(Number(region.max.y.toFixed(6)), 3);

    await zoomToSectionTarget(state(), { target: 'cut-region', margin: { kind: 'fraction', value: 0 } });
    assert.equal(Number(frames[0]!.max.y.toFixed(6)), 3);
  });

  it('a section box is the cut area it frames, not the axis it carried before it was a box', () => {
    state().setActiveTool('section');
    state().addSectionPlane('down');
    state().setSectionBox({ min: [2, 1, 1], max: [6, 4, 3] });
    const region = cutRegionBounds(state())!;
    assert.deepEqual([region.min.x, region.min.y, region.min.z, region.max.x, region.max.y, region.max.z].map((v) => Number(v.toFixed(6))), [2, 1, 1, 6, 4, 3]);
  });

  it('planes that cut everything away leave nothing to frame', async () => {
    state().setActiveTool('section');
    state().addSectionPlane('side');
    state().setSectionPlanePosition(30); // x <= 3
    state().addSectionPlane('side');
    state().setSectionPlanePosition(60);
    state().flipSectionPlane(); // x >= 6
    assert.equal(cutRegionBounds(state()), null);
    assert.equal(await zoomToSectionTarget(state(), { target: 'cut-region', margin: { kind: 'fraction', value: 0.1 } }), false);
    assert.deepEqual(frames, []);
  });

  it('nothing selected, or no camera, frames nothing', async () => {
    useViewerStore.setState({ cameraCallbacks: { selectionBounds: () => null, frameBounds: async () => true } });
    assert.equal(await zoomToSectionTarget(state(), { target: 'selection', margin: { kind: 'fraction', value: 0.1 } }), false);
    useViewerStore.setState({ cameraCallbacks: {} });
    assert.equal(await zoomToSectionTarget(state(), { target: 'model', margin: { kind: 'fraction', value: 0.1 } }), false);
  });
});

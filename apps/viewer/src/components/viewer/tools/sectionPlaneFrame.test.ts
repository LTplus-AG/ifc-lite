/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The drag handle of a cardinal plane on a ROTATED building (#7545): the plane is clipped along the
 * rotated normal, so a metre of drag along it is not a metre of the axis coordinate the offset field
 * reads. The conversion is measured from the renderer's own frames.
 */

import '@/test/setup-dom.js';
import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { Renderer } from '@ifc-lite/renderer';
import { useViewerStore, type FederatedModel } from '@/store';
import { getDefaultSectionPlane } from '@/store/slices/sectionSlice.js';
import { fixtureModel } from '@/test/store-fixture.js';
import { clearGlobalRefs, setGlobalRendererRef } from '@/hooks/useBCF.js';
import * as frames from './sectionPlaneFrame.js';

// Through the namespace: the file still loads (and fails an assertion) when the function is missing.
const cardinalValuePerMetre = (): number => (frames as { cardinalValuePerMetre?: () => number }).cardinalValuePerMetre?.() ?? Number.NaN;

const BOUNDS = { min: { x: 0, y: 0, z: 0 }, max: { x: 20, y: 10, z: 8 } };

function model(): FederatedModel {
  return { ...fixtureModel('m'), geometryResult: {
    meshes: [], totalVertices: 0, totalTriangles: 0,
    coordinateInfo: { originShift: { x: 0, y: 0, z: 0 }, originalBounds: BOUNDS, shiftedBounds: BOUNDS, hasLargeCoordinates: false },
  } } as unknown as FederatedModel;
}

/** A renderer whose cut runs along a normal turned by `cos` against the axis: distance = cos * axis coordinate. */
function rotatedRenderer(cos: number): Renderer {
  return {
    getSectionPlaneFrames: (planes?: { primary: { position: number; min?: number; max?: number } | null }) => {
      const p = planes?.primary;
      if (!p) return [];
      const coordinate = (p.min ?? 0) + (p.position / 100) * ((p.max ?? 0) - (p.min ?? 0));
      return [{ id: null, primary: true, enabled: true, flipped: false, normal: [cos, 0, 0], distance: cos * coordinate, anchor: [0, 0, 0], corners: [] }];
    },
  } as unknown as Renderer;
}

beforeEach(() => {
  const m = model();
  useViewerStore.setState({ models: new Map([[m.id, m]]), sectionPlane: { ...getDefaultSectionPlane(), axis: 'side', position: 40, enabled: true, name: 'A' }, inactiveSectionPlanes: [] });
});
afterEach(() => clearGlobalRefs());

describe('cardinalValuePerMetre (#7545)', () => {
  it('is 1 for an unrotated building', () => {
    setGlobalRendererRef({ current: rotatedRenderer(1) });
    assert.ok(Math.abs(cardinalValuePerMetre() - 1) < 1e-9);
  });

  it('is 1 / cos for a building turned so the normal covers cos of the axis, wherever the plane is', () => {
    setGlobalRendererRef({ current: rotatedRenderer(0.5) });
    assert.ok(Math.abs(cardinalValuePerMetre() - 2) < 1e-9, 'a metre along the normal is 2 units of axis coordinate');
    useViewerStore.setState({ sectionPlane: { ...useViewerStore.getState().sectionPlane, position: 95 } });
    assert.ok(Math.abs(cardinalValuePerMetre() - 2) < 1e-9, 'near the top of the range too');
  });

  it('is 1 when it cannot be measured: no renderer, a face plane, a box', () => {
    assert.equal(cardinalValuePerMetre(), 1);
    setGlobalRendererRef({ current: rotatedRenderer(0.5) });
    useViewerStore.setState({ sectionPlane: { ...useViewerStore.getState().sectionPlane, box: { min: [0, 0, 0], max: [1, 1, 1] } } });
    assert.equal(cardinalValuePerMetre(), 1);
  });
});

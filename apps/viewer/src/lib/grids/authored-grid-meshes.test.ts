/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Grids authored this session are drawn (#6232 D3): one strip per axis of
 * every live overlay-created grid, on the storey's plane, and none once the
 * grid is undone or deleted.
 */

import '@/test/setup-dom.js';
import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { useViewerStore } from '@/store';
import { MODEL_ID, STOREY, UPPER_STOREY, seedModelingSession } from '@/test/modeling-session-fixture';
import { addGridIn } from '@/store/slices/mutation-curtain-grid';
import { rectangularGridAxes } from '@ifc-lite/create';
import { authoredGridMeshes } from './authored-grid-meshes.js';

const grid = (storeyId: number, x: number) => addGridIn(useViewerStore, MODEL_ID, storeyId, {
  Position: [x, 0, 0], ...rectangularGridAxes({ UOffsets: [0, 6], VOffsets: [0, 4] }), Name: 'G',
});

/** The lowest and highest render-space Y of the meshes' vertices. */
const yRange = (positions: Float32Array) => {
  const ys = Array.from({ length: positions.length / 3 }, (_, i) => positions[i * 3 + 1]);
  return [Math.min(...ys), Math.max(...ys)];
};

beforeEach(async () => { await seedModelingSession(); });
afterEach(() => { useViewerStore.getState().exitModelWorkspace(); });

describe('authoredGridMeshes (#6232 D3)', () => {
  it('draws nothing without an authored grid', () => {
    assert.deepEqual(authoredGridMeshes(useViewerStore.getState()), []);
  });

  it('draws one strip (a box, 12 triangles) per axis, at the storey of each grid', () => {
    const ground = grid(STOREY, 0);
    const upper = grid(UPPER_STOREY, 20);
    assert.ok('expressId' in ground && 'expressId' in upper);
    const [mesh] = authoredGridMeshes(useViewerStore.getState());
    // Four axes per grid, two grids.
    assert.equal(mesh.indices.length / 3, 2 * 4 * 12);
    // The ground grid sits at the floor, the upper one 3 m up.
    const [low, high] = yRange(mesh.positions);
    assert.ok(low >= 0 && low < 0.1, `lowest strip at the floor (${low})`);
    assert.ok(high > 3 && high < 3.1, `highest strip 3 m up (${high})`);
  });

  it('drops a grid that is undone', () => {
    grid(STOREY, 0);
    assert.equal(authoredGridMeshes(useViewerStore.getState()).length, 1);
    useViewerStore.getState().undo(MODEL_ID);
    assert.deepEqual(authoredGridMeshes(useViewerStore.getState()), []);
  });
});

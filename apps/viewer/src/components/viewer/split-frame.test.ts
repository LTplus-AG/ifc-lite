/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The Split tool cuts under the cursor on a storey that does not sit at the
 * model origin (#6233). The demo project's storey hangs 3 m east and 3 m
 * north; split chains are storey-local while a pick is in the model frame, so
 * picking with the model frame alone cut 3 m away from the cursor.
 *
 * The wall is authored through `addWall` (storey-local params, mesh drawn in
 * the model frame through the storey's authoring frame), and the "cursor" is
 * a point ON that mesh — exactly what a raycast returns.
 */

import { beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { useViewerStore, type FederatedModel } from '@/store';
import { SPLIT_MODEL_ID as MODEL_ID, SPLIT_STOREY as STOREY, seedSplitFixture } from '@/test/split-fixture';
import { pickToSplitLocal, splitLocalToRenderer } from './split-frame.js';

/** Renderer-frame bounds of the meshes carrying `expressId`. */
function meshBounds(expressId: number) {
  const meshes = (useViewerStore.getState().models.get(MODEL_ID) as FederatedModel).geometryResult?.meshes ?? [];
  const lo = [Infinity, Infinity, Infinity];
  const hi = [-Infinity, -Infinity, -Infinity];
  for (const m of meshes.filter((mesh) => mesh.expressId === expressId)) {
    for (let i = 0; i < m.positions.length; i += 3) {
      for (let a = 0; a < 3; a++) { lo[a] = Math.min(lo[a], m.positions[i + a]); hi[a] = Math.max(hi[a], m.positions[i + a]); }
    }
  }
  return { lo, hi };
}

describe('Split pick frame on an offset storey (#6233)', () => {
  beforeEach(() => seedSplitFixture('millimetre', [3, 3]));

  it('a pick on the authored wall projects to the cut under the cursor', () => {
    const s = useViewerStore.getState();
    const added = s.addWall(MODEL_ID, STOREY, { Start: [0, 0, 0], End: [4, 0, 0], Thickness: 0.2, Height: 2.5 });
    assert.ok('expressId' in added);
    const wall = added.expressId;

    // The mesh sits where the storey puts it: 3 m east (renderer x) of the origin.
    const { lo, hi } = meshBounds(wall);
    assert.ok(Math.abs(lo[0] - 3) < 1e-6 && Math.abs(hi[0] - 7) < 1e-6, `mesh x ${lo[0]}..${hi[0]}, want 3..7`);

    // Cursor on the mesh, 1 m along the wall: renderer x = 3 + 1.
    const cursor = { x: 4, y: 1, z: (lo[2] + hi[2]) / 2 };
    const local = pickToSplitLocal(cursor, MODEL_ID, wall);
    assert.ok(local);
    const hover = useViewerStore.getState().readWallSplitProjection(MODEL_ID, wall, [local[0], local[1], 0]);
    assert.ok(hover && Math.abs(hover.distance - 1) < 1e-6, `cut at ${hover?.distance} m, want 1 m (under the cursor)`);

    // …and the preview is drawn back under the cursor.
    const drawn = splitLocalToRenderer(hover.cutPoint, MODEL_ID, wall);
    assert.ok(drawn && Math.abs(drawn[0] - 4) < 1e-6 && Math.abs(drawn[2] - cursor.z) < 0.2, `preview at ${drawn}`);
  });
});

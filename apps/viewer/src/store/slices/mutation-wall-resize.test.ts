/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * #6233: the geometry edit surface speaks metres in a metre AND a millimetre
 * model, a wall endpoint drag is one undo step, and the dragged wall's own
 * mesh follows the resize (and its undo).
 */

import { beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { useViewerStore } from '@/store';
import { WALL, WALL_UNITS, seedRectangleWall } from '@/test/rectangle-wall-fixture';
import { newMutationBatchId } from './mutation-batch-tags.js';

type Vec3 = [number, number, number];

const store = () => useViewerStore.getState();

function assertPoint(actual: readonly number[] | null | undefined, expected: Vec3, what: string): void {
  assert.ok(actual, `${what}: no value`);
  expected.forEach((value, i) => assert.ok(Math.abs(actual[i] - value) < 1e-9, `${what}: [${actual.join(', ')}] != [${expected.join(', ')}]`));
}

/** The wall's rendered x-extent in metres, from its mesh in the model's geometry. */
function wallExtentX(): [number, number] {
  const meshes = store().models.get('ifc')!.geometryResult!.meshes.filter((m) => m.expressId === WALL);
  assert.equal(meshes.length, 1, 'exactly one wall mesh');
  const [ox] = meshes[0].origin ?? [0, 0, 0];
  const xs: number[] = [];
  for (let i = 0; i < meshes[0].positions.length; i += 3) xs.push(meshes[0].positions[i] + ox);
  return [Math.min(...xs), Math.max(...xs)];
}

/** What the viewport's removal drain does once the renderer dropped the old mesh. */
function drainRemovals(): void {
  const pending = store().pendingMeshRemovals;
  if (pending) store().pruneGeometryMeshes(pending);
  store().clearPendingMeshRemovals();
}

for (const { name, unit, scale: s } of WALL_UNITS) {
  describe(`geometry edits in a ${name} model speak metres (#6233)`, () => {
    beforeEach(() => seedRectangleWall(unit, s));

    it('reads the placement in metres and nudges by the metric distance', () => {
      assertPoint(store().readEntityPosition('ifc', WALL), [2, 1, 0], 'position');
      assert.ok(store().translateEntity('ifc', WALL, [0.5, 0, 0]).ok);
      assertPoint(store().readEntityPosition('ifc', WALL), [2.5, 1, 0], 'after a 0.5 m nudge');
      // What lands in the IFC is the file's own unit.
      assertPoint(store().undoStacks.get('ifc')!.at(-1)!.newValue as number[], [2.5 * s, 1 * s, 0], 'written point');
    });

    it('sets an absolute position given in metres', () => {
      assert.ok(store().setEntityPosition('ifc', WALL, [-5.618, 1, 0]).ok);
      assertPoint(store().readEntityPosition('ifc', WALL), [-5.618, 1, 0], 'position');
      assertPoint(store().undoStacks.get('ifc')!.at(-1)!.newValue as number[], [-5.618 * s, 1 * s, 0], 'written point');
    });

    it('an endpoint drag is one undo step, and the wall mesh follows it', () => {
      const wall = store().readWallEndpoints('ifc', WALL);
      assertPoint(wall?.start, [2, 1, 0], 'start');
      assertPoint(wall?.end, [6, 1, 0], 'end');
      assert.ok(Math.abs(wall!.thickness - 0.2) < 1e-9, 'thickness in metres');

      // Five pointer-move frames of one drag, then release.
      const batchId = newMutationBatchId();
      for (const x of [6.5, 7, 7.5, 8, 8.5]) {
        assert.ok(store().resizeWall('ifc', WALL, [2, 1, 0], [x, 1, 0], batchId).ok);
      }
      assertPoint(store().readWallEndpoints('ifc', WALL)?.end, [8.5, 1, 0], 'dragged end');
      store().refreshWallMesh('ifc', WALL);
      drainRemovals();
      const [minX, maxX] = wallExtentX();
      assert.ok(Math.abs(minX - 2) < 1e-4 && Math.abs(maxX - 8.5) < 1e-4, `mesh spans ${minX}..${maxX}, expected 2..8.5`);

      store().undo('ifc');
      assert.equal(store().undoStacks.get('ifc')!.length, 0, 'one Ctrl+Z reverts the whole drag');
      assertPoint(store().readWallEndpoints('ifc', WALL)?.end, [6, 1, 0], 'end after undo');
      drainRemovals();
      const [undoMin, undoMax] = wallExtentX();
      assert.ok(Math.abs(undoMin - 2) < 1e-4 && Math.abs(undoMax - 6) < 1e-4, `mesh spans ${undoMin}..${undoMax} after undo`);
    });
  });
}

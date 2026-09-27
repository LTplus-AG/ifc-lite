/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * #6233: the geometry edit surface speaks metres in a metre AND a millimetre
 * model, a wall endpoint drag is one undo step, and the dragged wall's own
 * mesh follows the resize (and its undo).
 *
 * The mesh comes from the re-mesh service (#6232). A scripted mesher stands
 * in for the wasm worker: it reads the wall's length off the profile in the
 * subgraph it is sent (so the EDITED data has to reach it) and answers with a
 * mesh that long. Mesh parity with the load is the wasm contract's job.
 */

import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { MeshData } from '@ifc-lite/geometry';
import type { RemeshRequest, RemeshResult } from '@ifc-lite/geometry/remesh';
import { setRemeshClientFactory } from '@/lib/remesh/remesh-service';
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

/** Wall meshes the scripted mesher returns: from x = 2 m along the profile's XDim (native units / `scale`). */
function scriptedMesher(scale: number, empty = false) {
  const requests: RemeshRequest[] = [];
  setRemeshClientFactory(async () => ({
    alive: true,
    setConfig: () => {},
    dispose: () => {},
    styleWire: async () => ({ styleIds: new Uint32Array(), styleColors: new Uint8Array(),
      materialElementIds: new Uint32Array(), materialColorCounts: new Uint32Array(), materialColors: new Uint8Array() }),
    remesh: async (request: RemeshRequest): Promise<RemeshResult> => {
      requests.push(request);
      const text = new TextDecoder().decode(request.buffer);
      const xDim = Number(/IFCRECTANGLEPROFILEDEF\(\.AREA\.,\$,#\d+,([^,]+),/.exec(text)![1]) / scale;
      const meshes: MeshData[] = empty ? [] : [{ expressId: WALL, ifcType: 'IfcWall',
        positions: new Float32Array([2, 0, 0, 2 + xDim, 0, 0, 2 + xDim, 3, 0]), normals: new Float32Array(9),
        indices: new Uint32Array([0, 1, 2]), color: [1, 1, 1, 1] } as MeshData];
      return { meshes, csgFailures: 0, ms: { prepass: 0, produce: 0 } };
    },
  }));
  return requests;
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

for (const { name, unit, scale: s } of WALL_UNITS) {
  describe(`geometry edits in a ${name} model speak metres (#6233)`, () => {
    beforeEach(() => seedRectangleWall(unit, s));
    afterEach(() => setRemeshClientFactory(null));

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

    it('an endpoint drag is one undo step, and the wall mesh follows it', async () => {
      const requests = scriptedMesher(s);
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
      assert.equal(requests.length, 0, 'the drag frames re-mesh nothing');
      store().refreshWallMesh('ifc', WALL);
      await settle();
      assert.equal(requests.length, 1, 'release re-meshes once');
      const [minX, maxX] = wallExtentX();
      assert.ok(Math.abs(minX - 2) < 1e-4 && Math.abs(maxX - 8.5) < 1e-4, `mesh spans ${minX}..${maxX}, expected 2..8.5`);

      store().undo('ifc');
      assert.equal(store().undoStacks.get('ifc')!.length, 0, 'one Ctrl+Z reverts the whole drag');
      assertPoint(store().readWallEndpoints('ifc', WALL)?.end, [6, 1, 0], 'end after undo');
      await settle();
      const [undoMin, undoMax] = wallExtentX();
      assert.ok(Math.abs(undoMin - 2) < 1e-4 && Math.abs(undoMax - 6) < 1e-4, `mesh spans ${undoMin}..${undoMax} after undo`);
    });

    it('keeps the old mesh when the resized wall cannot be rebuilt', async () => {
      scriptedMesher(s, true);
      // IfcExtrudedAreaSolid.Depth (#82, index 3) unset: the chain still
      // resolves, so the handles show, but there is no height to build from.
      store().setPositionalAttribute('ifc', 82, 3, null);
      assert.ok(store().resizeWall('ifc', WALL, [2, 1, 0], [7, 1, 0]).ok);
      await settle();
      assert.deepEqual(wallExtentX(), [2, 6], 'the wall keeps its old mesh instead of vanishing');
    });
  });
}

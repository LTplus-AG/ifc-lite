/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { MeshData } from '@ifc-lite/geometry';
import { hydratePickMeshes, planPickMeshHydration } from './pick-mesh-budget.js';

// The planner counts existing pick meshes per entity as a PREFIX of that
// entity's pieces. A failed piece followed by a created one would break that:
// the next plan would take the later piece for the missing one (#10583 review).
describe('hydratePickMeshes', () => {
  it('stops at the first failed creation so created pieces stay a prefix', () => {
    const a = { expressId: 7, positions: new Float32Array(9) } as MeshData;
    const b = { expressId: 7, positions: new Float32Array(18) } as MeshData;
    const created: MeshData[] = [];
    const scene = { getMeshDataPieces: (id: number) => (id === 7 ? [a, b] : undefined) };
    const plan = { overBudget: false, visibleExpressIds: [7], existingPieceCounts: new Map<string, number>() };

    const ok = hydratePickMeshes(scene, plan, (piece) => {
      if (piece === a) return { ok: false as const, reason: 'device-lost' as const };
      created.push(piece);
      return { ok: true as const, value: undefined };
    });

    assert.equal(ok, false);
    assert.deepEqual(created, [], 'the piece after the failure must not be created');
  });

  it('creates only the pieces past the existing prefix', () => {
    const pieces = [{ expressId: 3 }, { expressId: 3 }, { expressId: 3 }] as MeshData[];
    const scene = {
      getMeshes: () => [{ expressId: 3 }] as ReturnType<Parameters<typeof planPickMeshHydration>[0]['getMeshes']>,
      visibleMeshDataEntitiesExceed: () => false,
      getAllMeshDataExpressIds: () => [3],
      getMeshDataPieces: () => pieces,
    };
    const created: MeshData[] = [];
    const ok = hydratePickMeshes(scene, planPickMeshHydration(scene), (piece) => { created.push(piece); return { ok: true as const, value: undefined }; });
    assert.equal(ok, true);
    assert.equal(created.length, 2);
    assert.equal(created[0], pieces[1]);
    assert.equal(created[1], pieces[2]);
  });
});

/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { MeshData } from '@ifc-lite/geometry';
import type { Renderer } from '@ifc-lite/renderer';
import { releaseCpuMeshBuffers } from '@/lib/geometry-cpu-release';
import type { SceneContents } from '@ifc-lite/renderer';
import { reshapeSceneKeepingPresentInstanced } from '@/components/viewer/geometry-rebuild';
import { releasedReplaysIdle, splitReleasedForReplay } from './released-scene-replay';

const renderer = {} as Renderer;
function mesh(expressId: number): MeshData {
  return { expressId, positions: new Float32Array(9), normals: new Float32Array(9), indices: Uint32Array.from([0, 1, 2]), color: [1, 1, 1, 1] };
}
function releasedList(): MeshData[] {
  const list = [mesh(1), mesh(2)];
  releaseCpuMeshBuffers([list[1]]);
  return list;
}

describe('released scene replay (content reload)', () => {
  it('#10903 a failed replay of the same list is retried in its epoch, not left waiting for a length change', async () => {
    const list = releasedList();
    let attempts = 0;
    const unclaimed: MeshData[][] = [];
    const resident = splitReleasedForReplay(renderer, list, (gone) => unclaimed.push([...gone]), async () => ++attempts >= 2);
    assert.deepEqual(resident, [list[0]], 'only resident meshes take the normal upload');
    await releasedReplaysIdle();
    assert.equal(attempts, 2, 'the replay ran again without a new store pass');
    assert.deepEqual(unclaimed, [], 'a replay that eventually completes keeps its claim');
  });

  it('a replay that keeps failing is handed back for the next rebuild after its bounded retries', async () => {
    const list = releasedList();
    let attempts = 0;
    const unclaimed: MeshData[][] = [];
    splitReleasedForReplay(renderer, list, (gone) => unclaimed.push([...gone]), async () => { attempts++; throw new Error('backing unavailable'); });
    await releasedReplaysIdle();
    assert.equal(attempts, 3);
    assert.deepEqual(unclaimed, [[list[1]]]);
  });

  it('#10903 a reshape with no released meshes still supersedes the replay in flight, which then uploads nothing', async () => {
    const list = releasedList();
    let allowed!: () => void;
    const gate = new Promise<void>((resolve) => { allowed = resolve; });
    const uploads: string[] = [];
    const unclaimed: MeshData[][] = [];
    splitReleasedForReplay(renderer, list, (gone) => unclaimed.push([...gone]), async (_r, _m, isCurrent) => {
      await gate;
      if (!isCurrent()) return false; // replayReleasedGeometry's fence: nothing more is uploaded
      uploads.push('old model');
      return true;
    });
    // The model is replaced by a resident-only one: the reshape alone must fence the old replay.
    reshapeSceneKeepingPresentInstanced({ clearFlatGeometry: () => undefined, getInstancedModelIndices: () => [] } as unknown as SceneContents,
      undefined, [mesh(9)]);
    const replacement = [mesh(9)];
    assert.equal(splitReleasedForReplay(renderer, replacement, () => undefined), replacement, 'resident-only: nothing to replay');
    allowed();
    await releasedReplaysIdle();
    assert.deepEqual(uploads, [], 'the removed model is never uploaded into the reshaped scene');
    assert.deepEqual(unclaimed, [], 'and its keys are not unclaimed over the newer pass');
  });
});

/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The ghosting decision, tested as a decision (#2606 review).
 *
 * `scene-instanced-ghosting.test.ts` asserts the same behaviour through the
 * bytes actually written to the instance colour lane, which is the proof that
 * matters. These are here because the fast path and the forced re-apply are
 * cheaper to pin down directly than to infer from a write log, and because the
 * planner is the part that can be reasoned about without a device at all.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { planInstancedGhosting, type InstancedGhostInputs } from './instanced-ghost-plan.js';

function plan(over: Partial<InstancedGhostInputs> = {}) {
  return planInstancedGhosting({
    ghostExceptIds: new Set([1]),
    selectedIds: null,
    instancedIds: [1, 2, 3],
    current: new Set<number>(),
    ghostAlpha: 0.12,
    lastGhostAlpha: 0.12,
    dirty: false,
    ...over,
  });
}

describe('planInstancedGhosting', () => {
  it('ghosts everything outside the except-set', () => {
    const p = plan();
    assert.deepEqual([...p.next].sort(), [2, 3]);
    assert.deepEqual(p.toFade.sort(), [2, 3]);
    assert.deepEqual(p.toRestore, []);
  });

  it('treats null as no X-Ray and an empty set as ghost-everything', () => {
    assert.deepEqual([...plan({ ghostExceptIds: null }).next], []);
    assert.deepEqual([...plan({ ghostExceptIds: new Set() }).next].sort(), [1, 2, 3]);
  });

  it('exempts the selection', () => {
    assert.deepEqual([...plan({ selectedIds: new Set([2]) }).next], [3]);
  });

  it('reports no change when membership is stable', () => {
    const p = plan({ current: new Set([2, 3]) });
    assert.equal(p.changed, false);
    assert.deepEqual(p.toFade, []);
    assert.deepEqual(p.toRestore, []);
  });

  it('re-fades everything still ghosted when the bytes went dirty', () => {
    // Not just the delta: an override drop or a new shard may have overwritten
    // occurrences the membership diff considers untouched.
    const p = plan({ current: new Set([2, 3]), dirty: true });
    assert.equal(p.changed, true);
    assert.deepEqual(p.toFade.sort(), [2, 3]);
  });

  it('re-fades everything still ghosted when the alpha changes', () => {
    const p = plan({ current: new Set([2, 3]), ghostAlpha: 0.5 });
    assert.deepEqual(p.toFade.sort(), [2, 3]);
  });

  it('does not treat an alpha change as work when nothing is ghosted', () => {
    const p = plan({ ghostExceptIds: null, ghostAlpha: 0.5 });
    assert.equal(p.changed, false);
  });

  it('restores ids that left the ghost set', () => {
    const p = plan({ ghostExceptIds: new Set([1, 2]), current: new Set([2, 3]) });
    assert.deepEqual(p.toRestore, [2]);
    assert.deepEqual(p.toFade, [], 'id 3 is already faded and nothing forced a rewrite');
  });
});

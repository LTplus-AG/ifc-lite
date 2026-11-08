/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * #9296 round 3: a roof by footprint drawn in the viewer, and one edit of it,
 * are one undo step each; undo restores the previous planes and a refusal
 * never reaches the undo stack.
 */

import '@/test/setup-dom.js';
import { strict as assert } from 'node:assert';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { useViewerStore } from '@/store';
import { MODEL_ID, STOREY, seedModelingSession } from '@/test/modeling-session-fixture';
import { setRequestRemesh } from '@/lib/commands/modeling/transaction';
import { modelEditTarget } from './mutation-modelling-records.js';
import { editRoofIn } from './mutation-roof.js';

const D = Math.PI / 180;
let restore: () => void = () => {};

beforeEach(async () => {
  await seedModelingSession();
  restore = setRequestRemesh(() => {});
});
afterEach(() => restore());

const undoDepth = () => useViewerStore.getState().undoStacks.get(MODEL_ID)?.length ?? 0;
/** The roof's effective shape and type: an edit overrides the created record's attributes in place. */
const body = (roofId: number) => {
  const target = modelEditTarget(useViewerStore.getState(), MODEL_ID)!;
  const created = target.editor.getNewEntity(roofId)?.attributes ?? [];
  const edited = target.view.getPositionalMutationsForEntity(roofId);
  const attribute = (index: number) => (edited?.has(index) ? edited.get(index) : created[index]);
  return { shape: attribute(6), type: attribute(8) };
};

describe('roof by footprint in the viewer (#9296 round 3)', () => {
  it('editing one edge\'s slope is one undo step that undo reverts whole', () => {
    const added = useViewerStore.getState().addRoof(MODEL_ID, STOREY, {
      Position: [0, 0, 3], Width: 10, Depth: 8, Thickness: 0.25, EdgeSlopes: [30 * D, 30 * D, 30 * D, 30 * D],
    });
    assert.ok('expressId' in added, 'error' in added ? added.error : '');
    const roofId = added.expressId;
    const hip = body(roofId);
    assert.equal(hip.type, '.HIP_ROOF.');

    const depth = undoDepth();
    assert.deepEqual(editRoofIn(useViewerStore, MODEL_ID, roofId, { EdgeSlopes: [30 * D, 0, 30 * D, 0], Overhang: 0.5 }), { ok: true });
    assert.equal(body(roofId).type, '.GABLE_ROOF.');
    assert.notEqual(body(roofId).shape, hip.shape, 'the planes were rebuilt');
    const stack = useViewerStore.getState().undoStacks.get(MODEL_ID) ?? [];
    const tags = new Set(stack.slice(depth).map((m) => useViewerStore.getState().mutationBatchTags.get(m.id)));
    assert.equal(tags.size, 1, 'one undo step');

    useViewerStore.getState().undo(MODEL_ID);
    assert.deepEqual(body(roofId), hip, 'undo restores the hip roof');
  });

  it('a refused edit says why and leaves the undo stack alone', () => {
    const added = useViewerStore.getState().addRoof(MODEL_ID, STOREY, {
      Profile: 'polygon', OuterCurve: [[0, 0], [10, 0], [10, 8], [0, 8]], Thickness: 0.25, EdgeSlopes: [10 * D, 0, 0, 0],
    });
    assert.ok('expressId' in added);
    const depth = undoDepth();
    const outcome = editRoofIn(useViewerStore, MODEL_ID, added.expressId, { Edge: { Index: 0, Slope: 10 } });
    assert.equal(outcome.ok, false);
    assert.match(outcome.ok ? '' : outcome.reason, /slopes are radians/);
    assert.equal(undoDepth(), depth);
  });
});

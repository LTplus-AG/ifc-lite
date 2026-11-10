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
import { requiredModule } from '@/i18n/__tests__/required-module';

/** The new write path, loaded per test so a production revert fails an assertion, not the file load (#8890). */
const roof = () => requiredModule(() => import('./mutation-roof.js'), 'the viewer roof edit path exists (#9296)');

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

/** Check the real edit's journal, including absent tags rather than only distinct values. */
function assertSingleUndoBatch(depth: number): void {
  const state = useViewerStore.getState();
  const mutations = (state.undoStacks.get(MODEL_ID) ?? []).slice(depth);
  assert.ok(mutations.length > 0, 'the roof edit records mutations');
  const tags = mutations.map(mutation => state.mutationBatchTags.get(mutation.id));
  assert.ok(tags.every(tag => typeof tag === 'string' && tag.length > 0), 'every edit mutation has a real batch tag (#9356 review)');
  assert.equal(new Set(tags).size, 1, 'one undo step');
}

describe('roof by footprint in the viewer (#9296 round 3)', () => {
  it('editing one edge\'s slope is one undo step that undo reverts whole', async () => {
    const { editRoofIn } = await roof();
    const added = useViewerStore.getState().addRoof(MODEL_ID, STOREY, {
      Position: [0, 0, 3], Width: 10, Depth: 8, Thickness: 0.25, EdgeSlopes: [30 * D, 30 * D, 30 * D, 30 * D],
    });
    assert.ok('expressId' in added, 'error' in added ? added.error : '');
    const roofId = added.expressId;
    const hip = body(roofId);
    assert.equal(hip.type, '.HIP_ROOF.');

    const depth = undoDepth();
    assert.deepEqual(editRoofIn(useViewerStore, MODEL_ID, roofId, { EdgeSlopes: [30 * D, 0, 30 * D, 0], Overhang: 0.5 }), { ok: true, remesh: [roofId] });
    assert.equal(body(roofId).type, '.GABLE_ROOF.');
    assert.notEqual(body(roofId).shape, hip.shape, 'the planes were rebuilt');
    assertSingleUndoBatch(depth);

    useViewerStore.getState().undo(MODEL_ID);
    assert.deepEqual(body(roofId), hip, 'undo restores the hip roof');
  });

  it('missing tags cannot satisfy the roof single-undo-step check (#9356 review)', async () => {
    const { editRoofIn } = await roof();
    const added = useViewerStore.getState().addRoof(MODEL_ID, STOREY, {
      Position: [0, 0, 3], Width: 10, Depth: 8, Thickness: .25, EdgeSlopes: Array(4).fill(30 * D),
    });
    assert.ok('expressId' in added);
    const depth = undoDepth();
    assert.deepEqual(editRoofIn(useViewerStore, MODEL_ID, added.expressId, { EdgeSlopes: [30 * D, 0, 30 * D, 0] }), { ok: true, remesh: [added.expressId] });
    assert.equal(body(added.expressId).type, '.GABLE_ROOF.');
    assertSingleUndoBatch(depth);
    // Fault injection: keep the actual edit and undo rows, lose only their tags.
    const state = useViewerStore.getState(), tags = new Map(state.mutationBatchTags);
    for (const mutation of (state.undoStacks.get(MODEL_ID) ?? []).slice(depth)) tags.delete(mutation.id);
    useViewerStore.setState({ mutationBatchTags: tags });
    assert.throws(() => assertSingleUndoBatch(depth), /every edit mutation has a real batch tag/);
  });

  it('publishes the recorded definition with the rebuilt body (#9356 review)', async () => {
    const { editRoofIn } = await roof();
    const added = useViewerStore.getState().addRoof(MODEL_ID, STOREY, {
      Position: [0, 0, 3], Width: 10, Depth: 8, Thickness: 0.25, EdgeSlopes: [30 * D, 30 * D, 30 * D, 30 * D],
    });
    assert.ok('expressId' in added);
    const published: Array<[string, unknown]> = [];
    const original = useViewerStore.getState().mirrorPropertyEdit;
    useViewerStore.setState({ mirrorPropertyEdit: (_model, entity, pset, name, value) => {
      if (entity === added.expressId && pset === 'IfcLite_RoofFootprint') published.push([name, value]);
    } });
    try {
      assert.deepEqual(editRoofIn(useViewerStore, MODEL_ID, added.expressId, { Edge: { Index: 1, Slope: 0 }, Overhang: 0.5 }), { ok: true, remesh: [added.expressId] });
    } finally {
      useViewerStore.setState({ mirrorPropertyEdit: original });
    }
    const sent = Object.fromEntries(published);
    assert.equal(sent.Overhang, 0.5);
    assert.deepEqual(JSON.parse(String(sent.EdgeSlopes)), [30 * D, 0, 30 * D, 30 * D]);
    assert.deepEqual(Object.keys(sent).sort(), ['EdgeSlopes', 'Footprint', 'Overhang', 'Thickness']);
  });

  it('a refused edit says why and leaves the undo stack alone', async () => {
    const { editRoofIn } = await roof();
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

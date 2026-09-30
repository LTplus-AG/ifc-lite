/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** #6232: real authored graphs verify split classification and refusal
 * reporting; the command mesh tests prove shared-source geometry and Undo. */
import '@/test/setup-dom.js';
import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readHostedFill } from '@ifc-lite/create';
import { AnchorEntityReader } from '../../../../packages/create/src/in-store/resolve-anchor.js';
import { useViewerStore } from '@/store';
import { MODEL_ID, STOREY, seedModelingSession } from '@/test/modeling-session-fixture';
import { reassignWallOpenings } from './wall-opening-reassign.js';

function built(result: { expressId: number } | { error: string }): number {
  assert.ok('expressId' in result, 'error' in result ? result.error : '');
  return result.expressId;
}
async function fixture(unit: 'metre' | 'millimetre' = 'metre') {
  await seedModelingSession({ unit });
  const state = useViewerStore.getState();
  const source = built(state.addWall(MODEL_ID, STOREY, { Start: [0, 0, 0], End: [5, 0, 0], Thickness: 0.2, Height: 3 }));
  const right = built(state.addWall(MODEL_ID, STOREY, { Start: [2, 0, 0], End: [5, 0, 0], Thickness: 0.2, Height: 3 }));
  const window = (Offset: number) => built(state.addHostedFill(MODEL_ID, source,
    { kind: 'window', params: { Offset, Sill: 0.9, Width: 0.8, Height: 1.2 } }));
  const near = window(1), far = window(4);
  const store = state.models.get(MODEL_ID)!.ifcDataStore!, view = state.mutationViews.get(MODEL_ID)!, editor = state.storeEditors.get(MODEL_ID)!;
  return { store, view, editor, source, right, near, far, native: unit === 'metre' ? 1 : 1000,
    reader: new AnchorEntityReader(store, view) };
}
afterEach(() => useViewerStore.getState().exitModelWorkspace());

describe('wall split opening classification (#6232)', () => {
  for (const unit of ['metre', 'millimetre'] as const) {
    it(`${unit}: changes only the far occurrence's host and placements, keeping its identity and source points`, async () => {
      const s = await fixture(unit), before = readHostedFill(s.store, s.far, s.view)!;
      const point = s.reader.entity(before.locationPointId), near = readHostedFill(s.store, s.near, s.view);
      const summary = reassignWallOpenings(s.store, s.view, s.editor, s.source, s.source, s.right, 2 * s.native);
      assert.deepEqual([summary.toLeft, summary.toRight, summary.skipped], [0, 1, 0]);
      const after = readHostedFill(s.store, s.far, s.view)!;
      assert.deepEqual([after.hostId, after.openingId, after.fillingId, after.offset], [s.right, before.openingId, s.far, 2]);
      assert.notEqual(after.locationPointId, before.locationPointId);
      assert.deepEqual(s.reader.entity(before.locationPointId), point);
      assert.deepEqual(readHostedFill(s.store, s.near, s.view), near);
    });
  }

  it('reports an absolutely placed opening and leaves its graph unchanged', async () => {
    const s = await fixture();
    const opening = readHostedFill(s.store, s.far, s.view)!.openingId;
    const refId = (value: unknown) => typeof value === 'number' ? value : Number(String(value).slice(1));
    const placement = refId(s.reader.entity(opening)!.attributes[5]);
    s.editor.setPositionalAttribute(placement, 0, null);
    const records = s.view.getMutations(), entities = s.view.getNewEntities();
    const summary = reassignWallOpenings(s.store, s.view, s.editor, s.source, s.source, s.right, 2);
    assert.equal(summary.skipped, 1);
    assert.equal(summary.skipReasons.get('opening not placed relative to source wall'), 1);
    assert.deepEqual(s.view.getMutations(), records);
    assert.deepEqual(s.view.getNewEntities(), entities);
  });

  it('reports a missing opening reference and ignores deleted void relationships', async () => {
    const s = await fixture();
    const far = readHostedFill(s.store, s.far, s.view)!;
    const relations = [...s.reader.ids('IFCRELVOIDSELEMENT')];
    const farRel = relations.find(id => Number(String(s.reader.entity(id)!.attributes[5]).replace('#', '')) === far.openingId)!;
    s.editor.setPositionalAttribute(farRel, 5, null);
    const summary = reassignWallOpenings(s.store, s.view, s.editor, s.source, s.source, s.right, 2);
    assert.equal(summary.skipReasons.get('missing opening ref'), 1);
    s.editor.removeEntity(farRel);
    assert.equal(reassignWallOpenings(s.store, s.view, s.editor, s.source, s.source, s.right, 2).skipped, 0);
  });
});

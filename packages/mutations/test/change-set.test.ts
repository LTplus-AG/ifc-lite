/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `ChangeSetManager` had no test coverage at all before this file (round-8
 * vacuity audit, packages/mutations scope). `mergeChangeSets` sorts by
 * `mutation.timestamp` after concatenating each source change set's
 * mutations in `ids` order — that sort is exactly the kind of ordering
 * logic a lazily-written test can accidentally make unobservable by
 * feeding it a fixture that is already in timestamp order.
 */

import { describe, expect, it } from 'vitest';
import { ChangeSetManager } from '../src/change-set.js';
import type { Mutation } from '../src/types.js';

function mutation(id: string, timestamp: number, entityId = 1): Mutation {
  return {
    id,
    type: 'UPDATE_PROPERTY',
    timestamp,
    modelId: 'm1',
    entityId,
    psetName: 'Pset_Test',
    propName: 'Foo',
    oldValue: 'a',
    newValue: 'b',
  };
}

describe('ChangeSetManager', () => {
  it('creates a change set and tracks it as active', () => {
    const mgr = new ChangeSetManager();
    const cs = mgr.createChangeSet('Edits');
    expect(mgr.getActiveChangeSet()?.id).toBe(cs.id);
    expect(cs.mutations).toEqual([]);
    expect(cs.applied).toBe(false);
  });

  it('addMutation appends to the active change set', () => {
    const mgr = new ChangeSetManager();
    mgr.createChangeSet('Edits');
    mgr.addMutation(mutation('mut1', 1));
    mgr.addMutation(mutation('mut2', 2));
    const active = mgr.getActiveChangeSet();
    expect(active?.mutations.map((m) => m.id)).toEqual(['mut1', 'mut2']);
  });

  it('addMutation auto-creates a change set when none is active', () => {
    const mgr = new ChangeSetManager();
    mgr.addMutation(mutation('mut1', 1));
    // Auto-created set becomes active per createChangeSet's side effect...
    // but addMutation's own auto-create branch pushes onto the LOCAL
    // `newChangeSet` reference, not through getActiveChangeSet() again, so
    // this must actually land in the manager's stored set, not a detached
    // copy.
    const all = mgr.getAllChangeSets();
    expect(all).toHaveLength(1);
    expect(all[0].mutations.map((m) => m.id)).toEqual(['mut1']);
  });

  it('mergeChangeSets sorts merged mutations by timestamp, not by change-set/insertion order', () => {
    const mgr = new ChangeSetManager();

    // Deliberately feed mergeChangeSets a fixture where insertion order and
    // timestamp order DISAGREE, in both directions:
    //   - csA is merged first but holds the LATEST timestamp (300)
    //   - csB is merged second but holds the EARLIEST and a middle one (100, 200)
    // If mergeChangeSets ever stopped sorting (or sorted then merge order
    // won by chance), the concatenation-order result ['late300', 'early100',
    // 'mid200'] would leak through unsorted. Only a real sort by timestamp
    // recovers ['early100', 'mid200', 'late300'].
    const csA = mgr.createChangeSet('A');
    mgr.addMutation(mutation('late300', 300));

    mgr.createChangeSet('B');
    mgr.addMutation(mutation('early100', 100));
    mgr.addMutation(mutation('mid200', 200));
    const csB = mgr.getActiveChangeSet()!;

    // Sanity-check the fixture itself: concatenating in `ids` order
    // (csA then csB) is NOT already timestamp-sorted — otherwise this test
    // would pass whether or not the implementation sorts.
    const concatenatedTimestamps = [...csA.mutations, ...csB.mutations].map((m) => m.timestamp);
    expect(concatenatedTimestamps).toEqual([300, 100, 200]);
    expect(concatenatedTimestamps).not.toEqual([...concatenatedTimestamps].sort((a, b) => a - b));

    const merged = mgr.mergeChangeSets([csA.id, csB.id], 'Merged');

    expect(merged.mutations.map((m) => m.id)).toEqual(['early100', 'mid200', 'late300']);
    expect(merged.mutations.map((m) => m.timestamp)).toEqual([100, 200, 300]);
    expect(merged.name).toBe('Merged');
    expect(merged.applied).toBe(false);
    // The merged set is registered and independently retrievable.
    expect(mgr.getChangeSet(merged.id)?.id).toBe(merged.id);
  });

  it('mergeChangeSets skips unknown ids without throwing', () => {
    const mgr = new ChangeSetManager();
    const csA = mgr.createChangeSet('A');
    mgr.addMutation(mutation('m1', 1));
    const merged = mgr.mergeChangeSets([csA.id, 'does-not-exist'], 'Merged');
    expect(merged.mutations.map((m) => m.id)).toEqual(['m1']);
  });

  it('deleteChangeSet clears the active pointer only when deleting the active set', () => {
    const mgr = new ChangeSetManager();
    const csA = mgr.createChangeSet('A');
    const csB = mgr.createChangeSet('B'); // becomes active
    expect(mgr.getActiveChangeSet()?.id).toBe(csB.id);

    expect(mgr.deleteChangeSet(csA.id)).toBe(true);
    // Deleting a non-active set must not disturb the active pointer.
    expect(mgr.getActiveChangeSet()?.id).toBe(csB.id);

    expect(mgr.deleteChangeSet(csB.id)).toBe(true);
    expect(mgr.getActiveChangeSet()).toBeNull();
  });

  it('getStatistics counts distinct entities and models across all change sets', () => {
    const mgr = new ChangeSetManager();
    mgr.createChangeSet('A');
    mgr.addMutation(mutation('m1', 1, 10));
    mgr.addMutation({ ...mutation('m2', 2, 10), modelId: 'm1' }); // same entity+model as m1
    mgr.createChangeSet('B');
    mgr.addMutation({ ...mutation('m3', 3, 20), modelId: 'm2' }); // different entity+model

    const stats = mgr.getStatistics();
    expect(stats.totalChangeSets).toBe(2);
    expect(stats.totalMutations).toBe(3);
    expect(stats.affectedEntities).toBe(2); // "m1:10" and "m2:20"
    expect(stats.affectedModels).toBe(2); // "m1" and "m2"
  });
});

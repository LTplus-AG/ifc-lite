/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { describe, expect, it } from 'vitest';
import { MutablePropertyView } from './mutable-property-view.js';
import { cooperativeOverlay } from './cooperative-overlay-access.js';
import { captureCompoundInverse, type CompoundInverse } from './compound-inverse.js';
import { recordCompoundMutation, undoRecordedMutationOperations } from './compound-recording.js';

function retainedEntries(inverse: CompoundInverse): number {
  type Entry = CompoundInverse['maps'][number]['entries'][number];
  const size = (entries: readonly Entry[]): number => entries.reduce((n, entry) => n + 1
    + (entry.nested ? size(entry.nested.entries) : 0), 0);
  return inverse.maps.reduce((n, map) => n + size(map.entries), 0)
    + inverse.sets.reduce((n, set) => n + set.entries.length, 0) + inverse.history.length;
}

describe('#6232 D5 touched-entry inverses', () => {
  it('retains fixed-size edits as one property set and its indices grow', () => {
    const view = new MutablePropertyView(null, 'm');
    const entity = view.createEntity('IfcWall', ['id', null, 'Wall']).expressId;
    view.setProperty(entity, 'Pset_Growth', 'First', 0);
    const original = view.getMutations();
    const sizes: number[] = [];
    for (let i = 0; i < 24; i++) {
      const before = structuredClone(cooperativeOverlay(view).capture());
      recordCompoundMutation(view, draft => draft.setProperty(entity, 'Pset_Growth', `Value${i}`, i));
      const inverse = captureCompoundInverse(before, cooperativeOverlay(view).capture());
      expect(inverse.history).toEqual([]);
      sizes.push(retainedEntries(inverse));
    }
    expect(new Set(sizes).size).toBe(1);
    expect(sizes[0]).toBeLessThan(20);
    undoRecordedMutationOperations(view, 24, () => { throw new Error('All edits are compound'); });
    expect(view.getMutations()).toEqual(original);
    expect(view.getForEntity(entity).find(pset => pset.name === 'Pset_Growth')?.properties.map(p => p.name)).toEqual(['First']);
  });
});

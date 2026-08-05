/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * ChangeSetManager unit tests.
 *
 * `ChangeSetManager` is part of the published `@ifc-lite/mutations` surface but
 * had no test file and no caller anywhere in the repo, so every branch below
 * could be rewritten without any suite noticing. These tests pin the parts a
 * consumer actually depends on: active-set bookkeeping, id allocation on
 * import, merge ordering, and the statistics roll-up.
 */

import { describe, it, expect } from 'vitest';
import { ChangeSetManager } from '../src/change-set.js';
import type { Mutation } from '../src/types.js';

function mutation(overrides: Partial<Mutation> = {}): Mutation {
  return {
    id: 'm-1',
    type: 'SET_PROPERTY',
    timestamp: 1,
    modelId: 'model-a',
    entityId: 100,
    ...overrides,
  } as Mutation;
}

describe('ChangeSetManager', () => {
  describe('active change set bookkeeping', () => {
    it('makes a freshly created change set the active one', () => {
      const mgr = new ChangeSetManager();
      expect(mgr.getActiveChangeSet()).toBeNull();

      const cs = mgr.createChangeSet('First');
      expect(mgr.getActiveChangeSet()?.id).toBe(cs.id);
      expect(cs.applied).toBe(false);
      expect(cs.mutations).toEqual([]);
    });

    it('rejects activating an id that is not in the manager', () => {
      const mgr = new ChangeSetManager();
      expect(() => mgr.setActiveChangeSet('does-not-exist')).toThrow(
        /Change set does-not-exist not found/
      );
      // The failed call must not have moved the pointer.
      expect(mgr.getActiveChangeSet()).toBeNull();
    });

    it('accepts null to clear the active change set', () => {
      const mgr = new ChangeSetManager();
      mgr.createChangeSet('First');
      mgr.setActiveChangeSet(null);
      expect(mgr.getActiveChangeSet()).toBeNull();
    });

    it('clears the active pointer when the active change set is deleted', () => {
      const mgr = new ChangeSetManager();
      const cs = mgr.createChangeSet('First');

      expect(mgr.deleteChangeSet(cs.id)).toBe(true);
      // A stale pointer here would make the next addMutation() write into a
      // change set that no longer exists in the map — the mutation would be
      // silently lost on save.
      expect(mgr.getActiveChangeSet()).toBeNull();

      mgr.addMutation(mutation());
      const active = mgr.getActiveChangeSet();
      expect(active).not.toBeNull();
      expect(mgr.getChangeSet(active!.id)?.mutations).toHaveLength(1);
    });

    it('leaves the active pointer alone when a different change set is deleted', () => {
      const mgr = new ChangeSetManager();
      const first = mgr.createChangeSet('First');
      const second = mgr.createChangeSet('Second');

      expect(mgr.deleteChangeSet(first.id)).toBe(true);
      expect(mgr.getActiveChangeSet()?.id).toBe(second.id);
      expect(mgr.deleteChangeSet(first.id)).toBe(false);
    });
  });

  describe('addMutation', () => {
    it('stores the mutation in the auto-created change set when none is active', () => {
      const mgr = new ChangeSetManager();
      const m = mutation({ id: 'auto-1' });

      mgr.addMutation(m);

      const active = mgr.getActiveChangeSet();
      expect(active?.name).toBe('Unsaved Changes');
      // The auto-create branch must still record the mutation that triggered
      // it; dropping it loses the user's first edit.
      expect(active?.mutations).toEqual([m]);
      expect(mgr.getAllChangeSets()).toHaveLength(1);
      expect(mgr.getStatistics().totalMutations).toBe(1);
    });

    it('appends to the existing active change set in call order', () => {
      const mgr = new ChangeSetManager();
      mgr.createChangeSet('Batch');
      mgr.addMutation(mutation({ id: 'a' }));
      mgr.addMutation(mutation({ id: 'b' }));

      expect(mgr.getActiveChangeSet()?.mutations.map((m) => m.id)).toEqual(['a', 'b']);
      expect(mgr.getAllChangeSets()).toHaveLength(1);
    });
  });

  describe('mergeChangeSets', () => {
    it('orders merged mutations by timestamp across the source sets', () => {
      const mgr = new ChangeSetManager();
      const late = mgr.createChangeSet('Late');
      late.mutations.push(mutation({ id: 'late-30', timestamp: 30 }));
      late.mutations.push(mutation({ id: 'late-10', timestamp: 10 }));

      const early = mgr.createChangeSet('Early');
      early.mutations.push(mutation({ id: 'early-20', timestamp: 20 }));

      const merged = mgr.mergeChangeSets([late.id, early.id], 'Merged');

      // Concatenation order would be 30, 10, 20 — the sort is what puts the
      // edits back into the order the user made them, which is what replay
      // and undo depend on.
      expect(merged.mutations.map((m) => m.id)).toEqual(['late-10', 'early-20', 'late-30']);
      expect(merged.name).toBe('Merged');
      expect(merged.applied).toBe(false);
      expect(mgr.getChangeSet(merged.id)?.id).toBe(merged.id);
    });

    it('skips unknown ids and returns an empty set when none resolve', () => {
      const mgr = new ChangeSetManager();
      const merged = mgr.mergeChangeSets(['nope'], 'Empty');
      expect(merged.mutations).toEqual([]);
    });
  });

  describe('export / import round trip', () => {
    it('throws when exporting an unknown change set', () => {
      const mgr = new ChangeSetManager();
      expect(() => mgr.exportChangeSet('missing')).toThrow(/Change set missing not found/);
    });

    it('exports a versioned envelope containing the change set', () => {
      const mgr = new ChangeSetManager();
      const cs = mgr.createChangeSet('Export me');
      cs.mutations.push(mutation({ id: 'x' }));

      const parsed = JSON.parse(mgr.exportChangeSet(cs.id));
      expect(parsed.version).toBe(1);
      expect(parsed.changeSet.name).toBe('Export me');
      expect(parsed.changeSet.mutations.map((m: Mutation) => m.id)).toEqual(['x']);
    });

    it('assigns a fresh id on import so re-importing cannot overwrite the original', () => {
      const mgr = new ChangeSetManager();
      const original = mgr.createChangeSet('Original');
      original.mutations.push(mutation({ id: 'x' }));
      mgr.markApplied(original.id);

      const json = mgr.exportChangeSet(original.id);
      const imported = mgr.importChangeSet(json);

      expect(imported.id).not.toBe(original.id);
      // Both must still be addressable — a reused id would silently replace
      // the change set already in the manager.
      expect(mgr.getChangeSet(original.id)?.name).toBe('Original');
      expect(mgr.getChangeSet(imported.id)?.name).toBe('Original');
      expect(mgr.getAllChangeSets()).toHaveLength(2);
      expect(imported.mutations.map((m) => m.id)).toEqual(['x']);
    });

    it('resets applied to false on import even when the payload says applied', () => {
      const mgr = new ChangeSetManager();
      const original = mgr.createChangeSet('Applied one');
      mgr.markApplied(original.id);
      expect(mgr.getChangeSet(original.id)?.applied).toBe(true);

      const imported = mgr.importChangeSet(mgr.exportChangeSet(original.id));

      // The import target has not applied these mutations yet; carrying the
      // flag over would make the manager think the edits are already in the
      // model and skip them.
      expect(imported.applied).toBe(false);
    });

    it('rejects a payload without a changeSet field', () => {
      const mgr = new ChangeSetManager();
      expect(() => mgr.importChangeSet('{"version":1}')).toThrow(/Invalid change set format/);
    });
  });

  describe('getStatistics', () => {
    it('counts an entity id in two different models as two affected entities', () => {
      const mgr = new ChangeSetManager();
      const cs = mgr.createChangeSet('Cross-model');
      cs.mutations.push(mutation({ id: 'a', modelId: 'model-a', entityId: 100 }));
      cs.mutations.push(mutation({ id: 'b', modelId: 'model-b', entityId: 100 }));
      // Same entity touched twice in one model must still count once.
      cs.mutations.push(mutation({ id: 'c', modelId: 'model-a', entityId: 100 }));

      expect(mgr.getStatistics()).toEqual({
        totalChangeSets: 1,
        totalMutations: 3,
        affectedEntities: 2,
        affectedModels: 2,
      });
    });

    it('reports zeroes for an empty manager and after clear()', () => {
      const mgr = new ChangeSetManager();
      expect(mgr.getStatistics()).toEqual({
        totalChangeSets: 0,
        totalMutations: 0,
        affectedEntities: 0,
        affectedModels: 0,
      });

      mgr.addMutation(mutation());
      mgr.clear();
      expect(mgr.getStatistics().totalChangeSets).toBe(0);
      expect(mgr.getActiveChangeSet()).toBeNull();
    });

    it('sums mutations across every change set, not just the active one', () => {
      const mgr = new ChangeSetManager();
      const first = mgr.createChangeSet('First');
      first.mutations.push(mutation({ id: 'a', entityId: 1 }));
      const second = mgr.createChangeSet('Second');
      second.mutations.push(mutation({ id: 'b', entityId: 2 }));

      const stats = mgr.getStatistics();
      expect(stats.totalChangeSets).toBe(2);
      expect(stats.totalMutations).toBe(2);
      expect(stats.affectedEntities).toBe(2);
    });
  });

  describe('renameChangeSet / markApplied', () => {
    it('renames in place and is a no-op for an unknown id', () => {
      const mgr = new ChangeSetManager();
      const cs = mgr.createChangeSet('Before');
      mgr.renameChangeSet(cs.id, 'After');
      expect(mgr.getChangeSet(cs.id)?.name).toBe('After');

      expect(() => mgr.renameChangeSet('missing', 'X')).not.toThrow();
      expect(mgr.getAllChangeSets()).toHaveLength(1);
    });

    it('marks only the addressed change set as applied', () => {
      const mgr = new ChangeSetManager();
      const first = mgr.createChangeSet('First');
      const second = mgr.createChangeSet('Second');

      mgr.markApplied(first.id);
      expect(mgr.getChangeSet(first.id)?.applied).toBe(true);
      expect(mgr.getChangeSet(second.id)?.applied).toBe(false);
    });
  });
});

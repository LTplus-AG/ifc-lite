/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `foldedTypeCounts`, `foldedEntityCount` and `pendingMutationsField` had no
 * direct tests — `overlay.test.ts` drives them indirectly through real tool
 * calls over a parsed IFC file, which cannot isolate the arithmetic from the
 * parser and tool-dispatch layers around it. These tests build a fake
 * `IfcDataStore`/`PendingOverlay` pair instead.
 *
 * Fixtures use at least three types with distinct counts (not one type, and
 * not every type sharing the same count), a type with ALL of its store
 * entities deleted (an empty group after the fold — a subtraction bug that
 * clamps at 0 would look identical to one that doesn't unless a group
 * actually reaches 0), and a created entity both of an existing type (must
 * merge into the same row, not open a second one) and of a brand-new type
 * (must open a row `store.entityIndex.byType` never had).
 */

import { describe, expect, it } from 'vitest';
import type { IfcDataStore } from '@ifc-lite/parser';
import { foldedTypeCounts, foldedEntityCount, pendingMutationsField, type PendingOverlay, type CreatedEntity } from './overlay.js';

function fakeStore(byType: Record<string, number[]>, entityCount?: number): IfcDataStore {
  const byTypeMap = new Map(Object.entries(byType));
  const byId = new Map<number, unknown>();
  for (const ids of byTypeMap.values()) for (const id of ids) byId.set(id, { modelId: 'm', expressId: id });
  return {
    entityIndex: { byType: byTypeMap, byId },
    entityCount: entityCount ?? [...byTypeMap.values()].reduce((s, ids) => s + ids.length, 0),
  } as unknown as IfcDataStore;
}

function fakeCreated(ifcType: string, expressId: number): CreatedEntity {
  return { expressId, ifcType, globalId: '', attributes: [] };
}

function fakeOverlay(opts: { deleted?: number[]; createdAll?: CreatedEntity[]; pendingMutations?: number }): PendingOverlay {
  return {
    deleted: new Set(opts.deleted ?? []),
    createdAll: opts.createdAll ?? [],
    pendingMutations: opts.pendingMutations ?? 0,
  } as unknown as PendingOverlay;
}

describe('foldedTypeCounts', () => {
  it('reports each store type\'s own count, with three distinct group sizes', () => {
    const store = fakeStore({ IFCWALL: [1, 2, 3], IFCSLAB: [4, 5], IFCDOOR: [6] });
    const counts = foldedTypeCounts(store, null);
    expect(counts.get('IFCWALL')).toBe(3);
    expect(counts.get('IFCSLAB')).toBe(2);
    expect(counts.get('IFCDOOR')).toBe(1);
  });

  it('subtracts tombstoned ids from their type — down to 0 for a fully-deleted type, not negative', () => {
    const store = fakeStore({ IFCWALL: [1, 2, 3], IFCSLAB: [4, 5] });
    // All of IFCSLAB's ids are deleted: an empty group after the fold. A
    // mutant that subtracted the *number of deletions* globally instead of
    // per-type would leave IFCSLAB positive or drive IFCWALL negative.
    const overlay = fakeOverlay({ deleted: [4, 5] });
    const counts = foldedTypeCounts(store, overlay);
    expect(counts.get('IFCSLAB')).toBe(0);
    expect(counts.get('IFCWALL')).toBe(3); // untouched — the subtraction must be scoped per type
  });

  it('a partial delete only removes the deleted ids, not the whole type', () => {
    const store = fakeStore({ IFCWALL: [1, 2, 3] });
    const overlay = fakeOverlay({ deleted: [2] });
    expect(foldedTypeCounts(store, overlay).get('IFCWALL')).toBe(2);
  });

  it('a created entity of an existing type merges into that row instead of opening a second one', () => {
    const store = fakeStore({ IFCWALL: [1, 2] });
    const overlay = fakeOverlay({ createdAll: [fakeCreated('IfcWall', 100)] });
    const counts = foldedTypeCounts(store, overlay);
    expect(counts.get('IFCWALL')).toBe(3);
    expect(counts.size).toBe(1); // no second 'IfcWall' / 'IFCWALL' row
  });

  it('a created entity of a brand-new type opens its own row', () => {
    const store = fakeStore({ IFCWALL: [1] });
    const overlay = fakeOverlay({ createdAll: [fakeCreated('IfcColumn', 200)] });
    const counts = foldedTypeCounts(store, overlay);
    expect(counts.get('IFCWALL')).toBe(1);
    expect(counts.get('IFCCOLUMN')).toBe(1);
  });

  it('combines deletes and creates in the same fold', () => {
    const store = fakeStore({ IFCWALL: [1, 2, 3], IFCSLAB: [4] });
    const overlay = fakeOverlay({ deleted: [1], createdAll: [fakeCreated('IfcSlab', 400), fakeCreated('IfcBeam', 401)] });
    const counts = foldedTypeCounts(store, overlay);
    expect(counts.get('IFCWALL')).toBe(2); // 3 - 1
    expect(counts.get('IFCSLAB')).toBe(2); // 1 + 1
    expect(counts.get('IFCBEAM')).toBe(1); // new
  });
});

describe('foldedEntityCount', () => {
  it('returns the store count unchanged when there is no overlay', () => {
    const store = fakeStore({ IFCWALL: [1, 2, 3] }, 3);
    expect(foldedEntityCount(store, null)).toBe(3);
  });

  it('adds queued creates and subtracts deletes of store entities', () => {
    const store = fakeStore({ IFCWALL: [1, 2, 3] }, 3);
    const overlay = fakeOverlay({ deleted: [1], createdAll: [fakeCreated('IfcWall', 100), fakeCreated('IfcSlab', 101)] });
    // 3 (store) + 2 (created) - 1 (deleted store entity) = 4
    expect(foldedEntityCount(store, overlay)).toBe(4);
  });

  it('does not double-subtract a created-then-deleted entity (#2012)', () => {
    const store = fakeStore({ IFCWALL: [1, 2] }, 2);
    // Entity 100 was created this session and then deleted: it is absent
    // from createdAll (the overlay never re-adds a deleted create) AND its id
    // is not in the store, so the tombstone must not count against the total.
    const overlay = fakeOverlay({ deleted: [100], createdAll: [] });
    expect(foldedEntityCount(store, overlay)).toBe(2); // unchanged — not 1
  });
});

describe('pendingMutationsField', () => {
  it('is empty when every overlay is null', () => {
    expect(pendingMutationsField(null, null)).toEqual({});
  });

  it('sums pendingMutations across multiple non-null overlays with distinct counts', () => {
    const a = fakeOverlay({ pendingMutations: 2 });
    const b = fakeOverlay({ pendingMutations: 5 });
    expect(pendingMutationsField(a, b)).toEqual({ pendingMutations: 7 });
  });

  it('still sums when only SOME of several overlays are null (e.g. one side of a diff has no edits)', () => {
    // `model_diff` calls this with a base-side and head-side overlay, either
    // of which can be a plain read with no queued edits. An `every` vs `some`
    // mix-up here answers "nothing queued" as soon as ANY side is null,
    // silently dropping the other side's real pendingMutations count.
    const edited = fakeOverlay({ pendingMutations: 3 });
    expect(pendingMutationsField(null, edited)).toEqual({ pendingMutations: 3 });
    expect(pendingMutationsField(edited, null)).toEqual({ pendingMutations: 3 });
  });

  it('reports a present overlay with zero queued edits as 0, not omitted', () => {
    const zero = fakeOverlay({ pendingMutations: 0 });
    expect(pendingMutationsField(zero)).toEqual({ pendingMutations: 0 });
  });
});

// SPDX-License-Identifier: MPL-2.0
/* This Source Code Form is subject to the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { describe, expect, it, vi } from 'vitest';
import { NewEntityMap } from './new-entity-map.js';
import { MutablePropertyView } from './mutable-property-view.js';
import { recordCompoundMutation, undoRecordedMutationOperations } from './compound-recording.js';
import { PropertyValueType } from '@ifc-lite/data';
import { StoreEditor } from './store-editor.js';

describe('session-scale authoring #8452', () => {
  it('does not visit unrelated entity payloads when appending or recording an edit', () => {
    const view = new MutablePropertyView(null, 'scale');
    const editor = new StoreEditor({ entityIndex: { byId: new Map() } }, view);
    let visits = 0;
    for (let i = 0; i < 5000; i++) {
      const coordinates = [i, 0, 0];
      Object.defineProperty(coordinates, 0, { enumerable: true, get() { visits++; return i; } });
      view.createEntity('IfcCartesianPoint', [coordinates]);
    }
    visits = 0;
    const point = recordCompoundMutation(view, draft => new StoreEditor({ entityIndex: { byId: new Map() } }, draft)
      .runAtomic(e => e.addEntity('IfcCartesianPoint', [[1, 2, 3]])));
    // Counts actual payload reads, not elapsed time. The old snapshot envelope
    // reads all 5000 payloads repeatedly, even for a no-op or one new record.
    expect(visits).toBe(0);
    expect(editor.getNewEntity(point.expressId)?.attributes).toEqual([[1, 2, 3]]);
    expect(view.getMutationCount()).toBe(5001);
    undoRecordedMutationOperations(view, 1, () => { throw new Error('Expected compound inverse'); });
    expect(editor.hasEntity(point.expressId)).toBe(false);
    expect(view.getMutationCount()).toBe(5000);
  });

  it('preserves class buckets and order through nested sparse commits and failed drafts', () => {
    const view = new MutablePropertyView(null, 'scale');
    const a = view.createEntity('IfcWall', []), b = view.createEntity('IfcColumn', []);
    view.runAtomic(outer => {
      outer.runAtomic(inner => inner.createEntity('IfcWall', []));
      expect([...outer.getNewEntitiesOfType('IFCWALL')].map(e => e.expressId)).toEqual([a.expressId, 3]);
      expect(() => outer.runAtomic(inner => { inner.deleteEntity(a.expressId); throw new Error('stop'); })).toThrow('stop');
    });
    expect(view.getNewEntities().map(e => e.expressId)).toEqual([a.expressId, b.expressId, 3]);
    expect([...view.getNewEntitiesOfType('IfcWall')].map(e => e.expressId)).toEqual([a.expressId, 3]);
  });
});

it('entity-scoped effective changes equal the full diff under edits and deletion #8452', () => {
  const view = new MutablePropertyView(null, 'scope');
  const a = view.createEntity('IfcWall', []), b = view.createEntity('IfcColumn', []);
  view.setAttribute(a.expressId, 'Name', 'A');
  view.setAttribute(b.expressId, 'Name', 'B');
  view.setPositionalAttribute(a.expressId, 2, 'Renamed', true);
  for (const id of [a.expressId, b.expressId]) {
    view.createPropertySet(id, 'Pset_Test', [{ name: 'Code', value: 'x', type: PropertyValueType.String }]);
    view.deletePropertySet(id, 'Other');
    expect(view.getEffectiveChanges(id)).toEqual(view.getEffectiveChanges().filter(change => change.entityId === id));
  }
  view.deleteEntity(a.expressId);
  expect(view.getEffectiveChanges(a.expressId)).toEqual([]);
  expect(view.getEffectiveChanges(b.expressId)).toEqual(view.getEffectiveChanges().filter(change => change.entityId === b.expressId));
});


it('nested snapshot previews compare sparse history exactly #8452', () => {
  const view = new MutablePropertyView(null, 'preview');
  const entity = view.createEntity('IfcWall', ['guid', null, 'Wall']);
  view.runAtomic(draft => {
    const prepared = draft.prepareAtomic(preview => preview.setPositionalAttribute(entity.expressId, 2, 'Preview'));
    prepared.validate();
    expect(draft.getPositionalMutationsForEntity(entity.expressId)).toBeNull();
    prepared.commit();
  });
  expect(view.getPositionalMutationsForEntity(entity.expressId)?.get(2)).toBe('Preview');
});

it('sparse success and failure preserve ordinary writer behavior across mixed edits #8452', () => {
  const make = () => {
    const view = new MutablePropertyView(null, 'mixed');
    for (let i = 0; i < 6; i++) view.createEntity('IfcWall', [`guid${i}`, null, `Wall ${i}`]);
    return view;
  };
  const expected = make(), actual = make();
  const read = (view: MutablePropertyView) => ({
    entities: view.getNewEntities().map(({ creationId: _creationId, ...row }) => row),
    // Independently-created virtual sets have different generated identities.
    properties: Array.from({ length: 6 }, (_, i) => view.getForEntity(i + 1).map(({ globalId: _globalId, ...set }) => set)),
    attributes: Array.from({ length: 6 }, (_, i) => view.getAttributeMutationsForEntity(i + 1)),
    positional: Array.from({ length: 6 }, (_, i) => view.getPositionalMutationsForEntity(i + 1)),
    changes: view.getEffectiveChanges(), next: view.peekNextExpressId(), count: view.getMutationCount(),
  });
  let seed = 8452;
  for (let step = 0; step < 32; step++) {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    const id = seed % 6 + 1, n = step;
    const edit = (view: MutablePropertyView) => {
      view.setAttribute(id, 'Name', `Edit ${n}`);
      view.setPositionalAttribute(id, 2, `Position ${n}`, n % 2 === 0);
      view.setProperty(id, 'Pset_Mixed', `P${n % 3}`, n);
      if (n % 4 === 0) view.deletePropertySet(id, 'Old');
      if (n % 5 === 0) view.createEntity('IfcCartesianPoint', [[n, 0, 0]]);
    };
    const before = structuredClone(read(actual));
    expect(() => actual.runAtomic(draft => { edit(draft); throw new Error('abort'); })).toThrow('abort');
    expect(read(actual)).toEqual(before);
    edit(expected);
    actual.runAtomic(draft => draft.runAtomic(edit));
    expect(read(actual)).toEqual(read(expected));
  }
});

it('compound inverse restores forgotten tail records in original order #8452', () => {
  const view = new MutablePropertyView(null, 'order');
  for (let i = 0; i < 4; i++) view.createEntity('IfcCartesianPoint', [[i, 0, 0]]);
  recordCompoundMutation(view, draft => {
    draft.deleteEntity(4);
    draft.deleteEntity(2);
    draft.deleteEntity(3);
    draft.createEntity('IfcCartesianPoint', [[9, 0, 0]]);
  });
  undoRecordedMutationOperations(view, 1, () => { throw new Error('Expected compound inverse'); });
  expect(view.getNewEntities().map(e => e.expressId)).toEqual([1, 2, 3, 4]);
});


it('draft reference lookup does not rebuild an index per previously read record #8452', () => {
  const view = new MutablePropertyView(null, 'draft-index');
  for (let i = 0; i < 2000; i++) view.createEntity('IfcCartesianPoint', [[i, 0, 0]]);
  const axis = view.createEntity('IfcAxis2Placement3D', ['#1', null, null]);
  view.runAtomic(draft => {
    draft.getNewEntities(); // A planner has already read the session.
    const writes = vi.spyOn(NewEntityMap.prototype, 'set');
    try {
      expect([...draft.getNewEntitiesReferencing(1)].map(row => row.expressId)).toEqual([axis.expressId]);
      expect(writes.mock.calls.length).toBeLessThanOrEqual(1);
    } finally { writes.mockRestore(); }
  });
});


it('compound recording rejects allocator-only edits without journal records #8452', () => {
  const view = new MutablePropertyView(null, 'allocator');
  expect(() => recordCompoundMutation(view, draft => draft.setExpressIdWatermark(100))).toThrow('must record its mutations');
  expect(view.peekNextExpressId()).toBe(1);
});

it('typed override candidates follow writes, retypes, rollback and delete restoration #8452', () => {
  const view = new MutablePropertyView(null, 'override-index');
  const relation = view.createEntity('IfcRelAggregates', []);
  const id = relation.expressId, types = ['IFCRELAGGREGATES'];
  const candidates = () => view.getAttributeOverrideEntityIds(types).sort((a, b) => a - b);
  expect(candidates()).toEqual([]);
  view.setPositionalAttribute(id, 4, ['#99'], true);
  view.setAttribute(99, 'Name', 'Source edit', undefined, true);
  expect(candidates()).toEqual([id, 99]); // Source records remain conservative candidates.
  expect(() => view.runAtomic(draft => {
    draft.setEntityType(id, 'IfcCartesianPoint');
    expect(draft.getAttributeOverrideEntityIds(types)).toEqual([99]);
    throw new Error('rollback');
  })).toThrow('rollback');
  expect(candidates()).toEqual([id, 99]);
  recordCompoundMutation(view, draft => draft.setEntityType(id, 'IfcCartesianPoint'));
  expect(candidates()).toEqual([99]);
  undoRecordedMutationOperations(view, 1, () => { throw new Error('Expected compound inverse'); });
  expect(candidates()).toEqual([id, 99]);
  view.deleteEntity(id);
  expect(candidates()).toEqual([99]);
  view.restoreNewEntity(relation);
  expect(candidates()).toEqual([id, 99]);
  view.removePositionalMutation(id, 4);
  expect(candidates()).toEqual([99]);
  view.clear();
  expect(candidates()).toEqual([]);
});

it('override reference candidates track source and created retargets without numeric coordinates #8452', () => {
  const view = new MutablePropertyView(null, 'override-refs');
  const relation = view.createEntity('IfcRelAggregates', []), id = relation.expressId;
  view.setPositionalAttribute(id, 5, [['#90']], true);
  view.setAttribute(77, 'Unit', '#90', undefined, true);
  view.setPositionalAttribute(78, 0, [90, 0, 0], true);
  expect(view.getAttributeOverrideReferenceCandidates(90)).toEqual([id, 77]);
  view.runAtomic(draft => {
    draft.setPositionalAttribute(id, 5, ['#91'], true);
    expect(draft.getAttributeOverrideReferenceCandidates(90)).toEqual([77]);
    expect(draft.getAttributeOverrideReferenceCandidates(91)).toEqual([id]);
  });
  view.removePositionalMutation(id, 5);
  view.removeAttributeMutation(77, 'Unit');
  expect(view.getAttributeOverrideReferenceCandidates(90)).toEqual([]);
  expect(view.getAttributeOverrideReferenceCandidates(91)).toEqual([]);
});

it('reference queries follow in-place draft attributes and retained array aliases #8452 review', () => {
  const view = new MutablePropertyView(null, 'in-place');
  const relation = view.createEntity('IfcRelAggregates', ['guid', null, null, null, '#1', []]);
  view.runAtomic(draft => {
    const row = draft.getNewEntity(relation.expressId)!;
    const attributes = row.attributes;
    attributes[4] = ['#42'];
    expect([...draft.getNewEntitiesReferencing(42)].map(e => e.expressId)).toEqual([relation.expressId]);
    // No second getter: the same escaped array can be edited again.
    attributes[4] = ['#43'];
    expect([...draft.getNewEntitiesReferencing(42)]).toEqual([]);
    expect([...draft.getNewEntitiesReferencing(43)].map(e => e.expressId)).toEqual([relation.expressId]);
    expect(structuredClone(row).attributes[4]).toEqual(['#43']);
  });
  expect([...view.getNewEntitiesReferencing(43)].map(e => e.expressId)).toEqual([relation.expressId]);
});

it('read-only borrows are frozen copies, so a write through one cannot bypass the index #8452', () => {
  const view = new MutablePropertyView(null, 'borrow-write');
  const relation = view.createEntity('IfcRelAggregates', ['guid', null, null, null, '#1', ['#2']]);
  const [row] = view.readNewEntities();
  const related = row!.attributes[5] as string[];
  // A borrowed alias used to be the stored array itself: the edit landed in the
  // overlay while the reference buckets still named #2.
  expect(() => { related[0] = '#42'; }).toThrow(TypeError);
  expect(() => { (row!.attributes as unknown[])[4] = '#42'; }).toThrow(TypeError);
  expect(view.getNewEntity(relation.expressId)?.attributes[5]).toEqual(['#2']);
  expect([...view.getNewEntitiesReferencing(42)]).toEqual([]);
  expect(view.readNewEntity(relation.expressId)?.attributes).toEqual(['guid', null, null, null, '#1', ['#2']]);
});

it('a transaction scan of the session neither copies nor compares unmodified rows #8452', () => {
  const view = new MutablePropertyView(null, 'draft-scan');
  for (let i = 0; i < 3000; i++) view.createEntity('IfcCartesianPoint', [[i, 0, 0]]);
  const clones = vi.spyOn(globalThis, 'structuredClone');
  try {
    view.runAtomic(draft => {
      expect(draft.readNewEntities()).toHaveLength(3000);
      expect([...draft.readNewEntitiesOfType('IfcCartesianPoint')]).toHaveLength(3000);
      expect(draft.readNewEntity(7)?.attributes).toEqual([[6, 0, 0]]);
      draft.createEntity('IfcCartesianPoint', [[1, 2, 3]]);
    });
    // Each unmodified row read through the draft used to be cloned into it,
    // then compared again when the transaction finished.
    expect(clones.mock.calls.length).toBeLessThan(20);
  } finally { clones.mockRestore(); }
  expect(view.getNewEntityCount()).toBe(3001);
  expect(view.hasNewEntity(3001)).toBe(true);
});

it('borrows inside a transaction see draft edits, deletions and inserts #8452', () => {
  const view = new MutablePropertyView(null, 'draft-borrow');
  const a = view.createEntity('IfcWall', ['a', null, 'A']), b = view.createEntity('IfcWall', ['b', null, 'B']);
  view.runAtomic(draft => {
    draft.getNewEntity(a.expressId)!.attributes[2] = 'A2';
    draft.deleteEntity(b.expressId);
    const c = draft.createEntity('IfcWall', ['c', null, 'C']);
    expect(draft.readNewEntities().map(row => row.attributes[2])).toEqual(['A2', 'C']);
    expect([...draft.readNewEntitiesOfType('IFCWALL')].map(row => row.expressId)).toEqual([a.expressId, c.expressId]);
    expect(draft.readNewEntity(b.expressId)).toBeNull();
  });
  expect(view.readNewEntities().map(row => row.attributes[2])).toEqual(['A2', 'C']);
});

it('the express-id watermark scans a store once, not once per editor, and rescans on growth #8452', () => {
  const byId = new Map<number, unknown>([[10, {}], [20, {}]]);
  const keys = vi.spyOn(byId, 'keys');
  const store = { entityIndex: { byId } } as unknown as ConstructorParameters<typeof StoreEditor>[0];
  for (let i = 0; i < 25; i++) new StoreEditor(store, new MutablePropertyView(null, `w${i}`));
  expect(keys).toHaveBeenCalledTimes(1);
  byId.set(30, {});
  const view = new MutablePropertyView(null, 'grown');
  const editor = new StoreEditor(store, view);
  expect(keys).toHaveBeenCalledTimes(2);
  expect(editor.addEntity('IfcCartesianPoint', [[0, 0, 0]]).expressId).toBe(31);
  // Same size, different ids: the allocation guard still forces a rescan.
  byId.delete(10); byId.set(32, {});
  const sameSize = new MutablePropertyView(null, 'same-size');
  sameSize.setExpressIdWatermark(31);
  expect(new StoreEditor(store, sameSize).addEntity('IfcCartesianPoint', [[0, 0, 0]]).expressId).toBe(33);
});

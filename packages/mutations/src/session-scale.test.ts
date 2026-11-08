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

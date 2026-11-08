/* This Source Code Form is subject to the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { describe, expect, it } from 'vitest';
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

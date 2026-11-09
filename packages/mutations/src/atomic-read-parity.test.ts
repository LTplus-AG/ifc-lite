// SPDX-License-Identifier: MPL-2.0
/* This Source Code Form is subject to the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { expect, it } from 'vitest';
import { MutablePropertyView } from './mutable-property-view.js';
import { StoreEditor } from './store-editor.js';

function fingerprint(view: MutablePropertyView) {
  return structuredClone({ revision: view.getMutationRevision(), next: view.peekNextExpressId(),
    entities: view.getNewEntities(), mutations: view.getMutations(), changes: view.getEffectiveChanges() });
}

for (const mode of ['sparse', 'prepared'] as const) {
  it(`#9411 ${mode} drafts preserve untouched read fingerprints across nested transactions`, () => {
    const view = new MutablePropertyView(null, 'review');
    const point = view.createEntity('IfcCartesianPoint', [[1, 2, 3]]);
    view.setPositionalAttribute(point.expressId, 0, [4, 5, 6]);
    view.setEntityType(point.expressId, 'IfcDirection', null, point.type);
    const before = fingerprint(view);
    const edit = (draft: MutablePropertyView) => {
      expect(fingerprint(draft)).toEqual(before);
      draft.runAtomic(nested => {
        expect(fingerprint(nested)).toEqual(before);
        nested.setPositionalAttribute(point.expressId, 0, [7, 8, 9]);
        expect(nested.getMutationRevision()).toBeGreaterThan(before.revision);
      });
    };
    if (mode === 'sparse') view.runAtomic(edit);
    else {
      const prepared = view.prepareAtomic(edit);
      expect(fingerprint(view)).toEqual(before);
      prepared.commit();
    }
    expect(view.getPositionalMutationsForEntity(point.expressId)?.get(0)).toEqual([7, 8, 9]);
    expect(view.getMutationRevision()).toBeGreaterThan(before.revision);
  });
}

it('#9411 constructing an editor preserves a reviewed model revision but still seeds safe IDs', () => {
  const view = new MutablePropertyView(null, 'first-edit');
  const before = view.getMutationRevision();
  const held = view.prepareAtomic(() => null);
  const editor = new StoreEditor({ entityIndex: { byId: new Map([
    [100, { expressId: 100, type: 'IFCWALL', byteOffset: 0, byteLength: 1, lineNumber: 1 }],
  ]) } }, view);
  expect(view.getMutationRevision()).toBe(before);
  // Allocator changes still conflict with a held publication (including one
  // which contains no IFC edits), without pretending source content changed.
  expect(() => held.commit()).toThrow('overlay changed');
  editor.runAtomic(draft => {
    expect(view.getMutationRevision()).toBe(before);
    expect(draft.addEntity('IfcCartesianPoint', [[1, 2, 3]]).expressId).toBe(101);
  });
  expect(view.getMutationRevision()).toBeGreaterThan(before);
});

it('#9411 reference candidates include numeric references before and inside a sparse draft', () => {
  const view = new MutablePropertyView(null, 'numeric-ref');
  view.createEntity('IfcCartesianPoint', [[100, 200, 300]]);
  const rel = view.createEntity('IfcRelDefinesByProperties', ['rel', null, null, null, [100], 200]);
  const check = (draft: MutablePropertyView) => {
    expect([...draft.getNewEntitiesReferencing(100)].map(row => row.expressId)).toEqual([rel.expressId]);
    expect([...draft.getNewEntitiesReferencing(200)].map(row => row.expressId)).toEqual([rel.expressId]);
    expect([...draft.getNewEntitiesReferencing(300)]).toEqual([]);
  };
  check(view);
  view.runAtomic(draft => {
    check(draft);
    draft.setPositionalAttribute(rel.expressId, 4, [300]);
    draft.setAttribute(rel.expressId, 'RelatingPropertyDefinition', 400);
    for (const id of [300, 400]) {
      expect(draft.getAttributeOverrideReferenceCandidates(id)).toEqual([rel.expressId]);
      expect(draft.getAttributeOverrideEntityIds(['IfcRelDefinesByProperties'], id)).toEqual([rel.expressId]);
    }
  });
  for (const id of [300, 400]) expect(view.getAttributeOverrideReferenceCandidates(id)).toEqual([rel.expressId]);
});

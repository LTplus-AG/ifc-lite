/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'vitest';
import { PropertyValueType, QuantityType } from '@ifc-lite/data';
import { MutablePropertyView } from '../src/index.js';
import { collectEffectiveChanges, type EffectiveChangesSnapshot, type EffectiveChangesResolvers } from '../src/effective-changes.js';
import { propertyKey, quantityKey, type PropertyMutation, type QuantityMutation } from '../src/types.js';

/** Empty snapshot — every test overrides only the fields it needs. */
function emptySnapshot(): EffectiveChangesSnapshot {
  return {
    attributeMutations: new Map(),
    positionalAttrMutations: new Map(),
    typeMutations: new Map(),
    newPsets: new Map(),
    deletedPsets: new Set(),
    newQsets: new Map(),
    deletedQsets: new Set(),
    propertyKeysByEntity: new Map(),
    propertyMutations: new Map(),
    quantityKeysByEntity: new Map(),
    quantityMutations: new Map(),
    newEntities: new Map(),
    tombstones: new Set(),
    forgottenCreatedEntities: new Set(),
  };
}

const noopResolvers: EffectiveChangesResolvers = {
  attributeExtractor: null,
  resolveBaseEntityId: (entityId) => entityId,
  getBasePropertiesForEntity: () => [],
  getBaseQuantitiesForEntity: () => [],
};

describe('collectEffectiveChanges (pure function, no MutablePropertyView needed)', () => {
  it('is empty for an empty snapshot', () => {
    expect(collectEffectiveChanges(emptySnapshot(), noopResolvers)).toEqual([]);
  });

  it('reports entity create / delete directly from the snapshot', () => {
    const snapshot: EffectiveChangesSnapshot = {
      ...emptySnapshot(),
      newEntities: new Map([[9, { expressId: 9, type: 'IfcSpace', attributes: [] }]]),
      tombstones: new Set([4]),
    };

    expect(collectEffectiveChanges(snapshot, noopResolvers)).toEqual([
      { entityId: 4, kind: 'entity-deleted' },
      { entityId: 9, kind: 'entity-added', newValue: 'IfcSpace' },
    ]);
  });

  it('drops ALL rows for a forgotten-created entity, unlike a tombstoned one', () => {
    // Entity 1 was overlay-created, had a pset added, and was then deleted —
    // `deleteEntity` forgets a created entity (removes it from `newEntities`)
    // rather than tombstoning it, so there is no `entity-deleted` row either:
    // the entity never existed as far as any consumer downstream of the
    // overlay is concerned.
    const snapshot: EffectiveChangesSnapshot = {
      ...emptySnapshot(),
      newPsets: new Map([[1, new Map([['Pset_X', {
        name: 'Pset_X',
        globalId: 'new_1',
        properties: [{ name: 'A', type: PropertyValueType.Label, value: 'x' }],
      }]])]]),
      forgottenCreatedEntities: new Set([1]),
    };

    expect(collectEffectiveChanges(snapshot, noopResolvers)).toEqual([]);
  });
});

describe('MutablePropertyView.getEffectiveChanges (issue #1915) — enumeration behaviour', () => {
  it('is empty on a fresh view', () => {
    const view = new MutablePropertyView(null, 'model-1');
    expect(view.getEffectiveChanges()).toEqual([]);
  });

  it('reports a new property set as a single pset-added row, not one row per property', () => {
    const view = new MutablePropertyView(null, 'model-1');
    view.createPropertySet(5, 'Pset_New', [
      { name: 'A', value: 'x', type: PropertyValueType.Label },
      { name: 'B', value: 'y', type: PropertyValueType.Label },
    ]);

    expect(view.getEffectiveChanges()).toEqual([
      { entityId: 5, kind: 'pset-added', setName: 'Pset_New' },
    ]);
  });

  it('reports a deleted property set as a single pset-deleted row', () => {
    const view = new MutablePropertyView(null, 'model-1');
    view.setOnDemandExtractor((entityId) => entityId === 7 ? [{
      name: 'Pset_Base',
      globalId: 'base-guid',
      properties: [
        { name: 'Status', type: PropertyValueType.Label, value: 'Original' },
        { name: 'Other', type: PropertyValueType.Label, value: 'X' },
      ],
    }] : []);

    view.deletePropertySet(7, 'Pset_Base');

    expect(view.getEffectiveChanges()).toEqual([
      { entityId: 7, kind: 'pset-deleted', setName: 'Pset_Base' },
    ]);
  });

  it('reports an attribute mutation, deriving previousValue from the attribute extractor', () => {
    const view = new MutablePropertyView(null, 'model-1');
    view.setAttributeExtractor((entityId, attrName) => (entityId === 42 && attrName === 'Name' ? 'Old Name' : null));

    view.setAttribute(42, 'Name', 'New Name');

    expect(view.getEffectiveChanges()).toEqual([
      { entityId: 42, kind: 'attribute', name: 'Name', previousValue: 'Old Name', newValue: 'New Name' },
    ]);
  });

  it('reports a retype as a type change with previous/new class', () => {
    const view = new MutablePropertyView(null, 'model-1');
    view.setEntityType(3, 'IfcColumn', null, 'IfcBuildingElementProxy');

    expect(view.getEffectiveChanges()).toEqual([
      { entityId: 3, kind: 'type', previousValue: 'IfcBuildingElementProxy', newValue: 'IfcColumn' },
    ]);
  });

  it('reports created and deleted entities', () => {
    const view = new MutablePropertyView(null, 'model-1');
    view.setExpressIdWatermark(100);
    const created = view.createEntity('IfcSpace', ['guid', null, 'New Space']);
    view.deleteEntity(200);

    expect(view.getEffectiveChanges()).toEqual([
      { entityId: created.expressId, kind: 'entity-added', newValue: 'IfcSpace' },
      { entityId: 200, kind: 'entity-deleted' },
    ]);
  });

  it('drops a tombstoned entity\'s other overlay rows, keeping only entity-deleted', () => {
    const view = new MutablePropertyView(null, 'model-1');
    view.setOnDemandExtractor((entityId) => entityId === 7 ? [{
      name: 'Pset_Base',
      globalId: 'base-guid',
      properties: [
        { name: 'Status', type: PropertyValueType.Label, value: 'Original' },
      ],
    }] : []);

    // Edit a base entity's property, then delete the entity — the exporter
    // (`step-exporter.ts`) drops the property edit for a tombstoned entity,
    // so the review list must agree rather than showing a superseded row.
    view.setProperty(7, 'Pset_Base', 'Status', 'Changed', PropertyValueType.Label);
    view.deleteEntity(7);

    expect(view.getEffectiveChanges()).toEqual([
      { entityId: 7, kind: 'entity-deleted' },
    ]);
  });

  it('is deterministically ordered by entityId, then kind, then name', () => {
    const view = new MutablePropertyView(null, 'model-1');
    view.setOnDemandExtractor((entityId) => entityId === 1 ? [{
      name: 'Pset',
      globalId: 'g',
      properties: [
        { name: 'Z', type: PropertyValueType.Label, value: 'z0' },
        { name: 'A', type: PropertyValueType.Label, value: 'a0' },
      ],
    }] : []);
    view.setAttribute(5, 'Name', 'B');
    view.setProperty(1, 'Pset', 'Z', 'z', PropertyValueType.Label);
    view.setProperty(1, 'Pset', 'A', 'a', PropertyValueType.Label);
    view.setAttribute(1, 'Name', 'A');

    const changes = view.getEffectiveChanges();
    expect(changes.map(c => `${c.entityId}:${c.kind}:${c.name ?? ''}`)).toEqual([
      '1:attribute:Name',
      '1:property:A',
      '1:property:Z',
      '5:attribute:Name',
    ]);
  });

  it('drops an overlay-created entity\'s rows entirely once it is deleted (issue: forgotten, not tombstoned)', () => {
    // `deleteEntity` on an overlay-created entity FORGETS it (removes it from
    // `newEntities`) rather than tombstoning it — see the doc on `deleteEntity`.
    // The tombstone filter at the end of `collectEffectiveChanges` only ever
    // sees tombstones, so without separate tracking a pset/property/quantity
    // row added before the delete would survive the filter even though the
    // entity it belongs to will never be exported.
    const view = new MutablePropertyView(null, 'model-1');
    view.setExpressIdWatermark(0);
    const created = view.createEntity('IfcSpace', ['guid', null, 'New Space']);
    view.setProperty(created.expressId, 'Pset_X', 'A', 'v', PropertyValueType.Label);

    // Sanity: before the delete, both the entity-added and pset-added rows show up.
    expect(view.getEffectiveChanges()).toEqual([
      { entityId: created.expressId, kind: 'entity-added', newValue: 'IfcSpace' },
      { entityId: created.expressId, kind: 'pset-added', setName: 'Pset_X' },
    ]);

    view.deleteEntity(created.expressId);

    // The entity-added row is gone (expected — deleteEntity forgets it). The
    // pset-added row must be gone too: the entity was never actually created
    // as far as the export is concerned, so a pending "add Pset_X" row is a
    // review-vs-export divergence.
    expect(view.getEffectiveChanges()).toEqual([]);
  });

  it('restores a forgotten-created entity\'s rows on undo (restoreNewEntity)', () => {
    // The forgotten-entity fix must survive undo/redo: `restoreNewEntity` is
    // the paired call the undo stack uses to bring a forgotten created entity
    // back after DELETE_ENTITY is undone. Its rows must reappear exactly as
    // they were before the delete.
    const view = new MutablePropertyView(null, 'model-1');
    view.setExpressIdWatermark(0);
    const created = view.createEntity('IfcSpace', ['guid', null, 'New Space']);
    view.setProperty(created.expressId, 'Pset_X', 'A', 'v', PropertyValueType.Label);

    view.deleteEntity(created.expressId);
    expect(view.getEffectiveChanges()).toEqual([]);

    view.restoreNewEntity(created);

    expect(view.getEffectiveChanges()).toEqual([
      { entityId: created.expressId, kind: 'entity-added', newValue: 'IfcSpace' },
      { entityId: created.expressId, kind: 'pset-added', setName: 'Pset_X' },
    ]);
  });
});

describe('getModifiedEntityCount / hasChanges must agree with getEffectiveChanges (forgotten-created blind spot)', () => {
  it('does not count a create->edit->delete entity: zero effective rows, zero count, hasChanges false', () => {
    const view = new MutablePropertyView(null, 'model-1');
    view.setExpressIdWatermark(0);
    const created = view.createEntity('IfcSpace', ['guid', null, 'New Space']);
    view.setAttribute(created.expressId, 'Name', 'Edited Space');
    view.setProperty(created.expressId, 'Pset_X', 'A', 'v', PropertyValueType.Label);

    view.deleteEntity(created.expressId);

    // The entity contributes nothing to the export.
    expect(view.getEffectiveChanges()).toEqual([]);
    // ...so it must not be counted as modified either.
    expect(view.getModifiedEntityCount()).toBe(0);
    expect(view.hasChanges(created.expressId)).toBe(false);
  });

  it('restores both the effective rows AND the count/hasChanges on restoreNewEntity (undo round-trip)', () => {
    const view = new MutablePropertyView(null, 'model-1');
    view.setExpressIdWatermark(0);
    const created = view.createEntity('IfcSpace', ['guid', null, 'New Space']);
    view.setAttribute(created.expressId, 'Name', 'Edited Space');

    view.deleteEntity(created.expressId);
    expect(view.getModifiedEntityCount()).toBe(0);
    expect(view.hasChanges(created.expressId)).toBe(false);

    view.restoreNewEntity(created);

    expect(view.getEffectiveChanges().length).toBeGreaterThan(0);
    expect(view.getModifiedEntityCount()).toBe(1);
    expect(view.hasChanges(created.expressId)).toBe(true);
  });

  it('regression: a tombstoned SOURCE entity (not overlay-created) still counts as modified', () => {
    const view = new MutablePropertyView(null, 'model-1');
    view.setProperty(7, 'Pset_Base', 'Status', 'Changed', PropertyValueType.Label);
    view.deleteEntity(7);

    // A tombstoned source entity still produces an entity-deleted row.
    expect(view.getEffectiveChanges()).toEqual([{ entityId: 7, kind: 'entity-deleted' }]);
    expect(view.getModifiedEntityCount()).toBe(1);
    expect(view.hasChanges(7)).toBe(true);
  });
});

describe('deleteEntity purges a forgotten-created entity\'s overlay rows (maintainer finding on #1967)', () => {
  // The review dialog is not the only reader of the overlay: `StepExporter`
  // builds its property/quantity work list from `getMutations()` (the
  // append-only history) and reads `getForEntity()` / `getQuantitiesForEntity()`
  // directly off `newPsets` / `newQsets` — neither of which the #1915
  // review-side filter touches. Leaving a create->edit->delete entity's rows
  // in those structures meant the exporter would still emit an
  // IFCPROPERTYSET + IFCRELDEFINESBYPROPERTIES pointing at an expressId that
  // was never actually created — a dangling reference the review dialog hid
  // rather than caught. The fix has to purge at the source (`deleteEntity`),
  // not just filter the review's own enumeration.
  it('removes property, quantity, and attribute history/overlay entries for a create->edit->delete entity', () => {
    const view = new MutablePropertyView(null, 'model-1');
    view.setQuantityExtractor(() => []);
    view.setExpressIdWatermark(0);
    const created = view.createEntity('IfcSpace', ['guid', null, 'New Space']);
    const id = created.expressId;
    view.setAttribute(id, 'Name', 'Edited Space');
    view.setProperty(id, 'Pset_X', 'A', 'v', PropertyValueType.Label);
    view.createQuantitySet(id, 'Qto_X', [{ name: 'Area', value: 12, quantityType: QuantityType.Area }]);

    // Sanity: before delete, the exporter's readers see the entity's data.
    expect(view.getForEntity(id).length).toBeGreaterThan(0);
    expect(view.getQuantitiesForEntity(id).length).toBeGreaterThan(0);
    expect(view.getMutations().some(m => m.entityId === id && m.psetName === 'Pset_X')).toBe(true);
    expect(view.getMutations().some(m => m.entityId === id && m.psetName === 'Qto_X')).toBe(true);

    view.deleteEntity(id);

    // Every reader — not just getEffectiveChanges() — must agree the entity
    // never existed: nothing left for the exporter to dangle-reference.
    expect(view.getForEntity(id)).toEqual([]);
    expect(view.getQuantitiesForEntity(id)).toEqual([]);
    expect(view.getMutations().some(m => m.entityId === id && m.psetName === 'Pset_X')).toBe(false);
    expect(view.getMutations().some(m => m.entityId === id && m.psetName === 'Qto_X')).toBe(false);
    expect(view.getAttributeMutationsForEntity(id)).toEqual([]);
    expect(view.getEffectiveChanges()).toEqual([]);
    expect(view.getModifiedEntityCount()).toBe(0);
  });

  it('restores the purged rows on restoreNewEntity — the undo round trip', () => {
    const view = new MutablePropertyView(null, 'model-1');
    view.setQuantityExtractor(() => []);
    view.setExpressIdWatermark(0);
    const created = view.createEntity('IfcSpace', ['guid', null, 'New Space']);
    const id = created.expressId;
    view.setAttribute(id, 'Name', 'Edited Space');
    view.setProperty(id, 'Pset_X', 'A', 'v', PropertyValueType.Label);
    view.createQuantitySet(id, 'Qto_X', [{ name: 'Area', value: 12, quantityType: QuantityType.Area }]);

    view.deleteEntity(id);
    expect(view.getForEntity(id)).toEqual([]);

    view.restoreNewEntity(created);

    // Rows, overlay reads, AND history are all back — not just the count.
    expect(view.getForEntity(id).length).toBeGreaterThan(0);
    expect(view.getQuantitiesForEntity(id).length).toBeGreaterThan(0);
    expect(view.getMutations().some(m => m.entityId === id && m.psetName === 'Pset_X')).toBe(true);
    expect(view.getMutations().some(m => m.entityId === id && m.psetName === 'Qto_X')).toBe(true);
    expect(view.getAttributeMutationsForEntity(id)).toEqual([{ name: 'Name', value: 'Edited Space' }]);
    expect(view.getModifiedEntityCount()).toBe(1);
  });
});

describe('newPsets / newQsets empty-map cleanup (maintainer finding 2(b) on #1967)', () => {
  it('deleting the only property of an auto-created pset clears the entity out of newPsets entirely', () => {
    const view = new MutablePropertyView(null, 'model-1');
    view.setOnDemandExtractor(() => []);
    // Pset_New doesn't exist anywhere yet -> auto-created into newPsets.
    view.setProperty(5, 'Pset_New', 'A', 'v', PropertyValueType.Label);
    expect(view.getModifiedEntityCount()).toBe(1);

    view.deleteProperty(5, 'Pset_New', 'A');

    // The property is gone and so is the pset — nothing left to report or count.
    expect(view.getEffectiveChanges()).toEqual([]);
    expect(view.getForEntity(5)).toEqual([]);
    expect(view.getModifiedEntityCount()).toBe(0);
    expect(view.hasChanges(5)).toBe(false);
  });

  it('deleting the only quantity of an auto-created qset clears the entity out of newQsets entirely', () => {
    const view = new MutablePropertyView(null, 'model-1');
    view.setQuantityExtractor(() => []);
    view.createQuantitySet(5, 'Qto_New', [{ name: 'Area', value: 10, quantityType: QuantityType.Area }]);
    expect(view.getModifiedEntityCount()).toBe(1);

    view.removeQuantityMutation(5, 'Qto_New', 'Area');

    expect(view.getEffectiveChanges()).toEqual([]);
    expect(view.getQuantitiesForEntity(5)).toEqual([]);
    expect(view.getModifiedEntityCount()).toBe(0);
    expect(view.hasChanges(5)).toBe(false);
  });
});

describe('collectQuantityChanges coverage (previously zero — maintainer finding on #1967)', () => {
  it('reports a new quantity set as a single qset-added row', () => {
    const view = new MutablePropertyView(null, 'model-1');
    view.createQuantitySet(9, 'Qto_New', [
      { name: 'Area', value: 12, quantityType: QuantityType.Area },
      { name: 'Volume', value: 36, quantityType: QuantityType.Volume },
    ]);

    expect(view.getEffectiveChanges()).toEqual([
      { entityId: 9, kind: 'qset-added', setName: 'Qto_New' },
    ]);
  });

  it('reports a quantity edit on a base qset, deriving previousValue from the base extractor', () => {
    const view = new MutablePropertyView(null, 'model-1');
    view.setQuantityExtractor((entityId) => entityId === 11 ? [{
      name: 'Qto_Base',
      quantities: [{ name: 'Area', type: QuantityType.Area, value: 10 }],
    }] : []);

    view.setQuantity(11, 'Qto_Base', 'Area', 99, QuantityType.Area);

    expect(view.getEffectiveChanges()).toEqual([
      { entityId: 11, kind: 'quantity', setName: 'Qto_Base', name: 'Area', previousValue: '10', newValue: '99' },
    ]);
  });

  it('reports a deleted quantity set as a single qset-deleted row (pure function — no MutablePropertyView setter exists yet)', () => {
    // Unlike pset deletes (`deletePropertySet`), `MutablePropertyView` has no
    // public qset-delete method — `deletedQsets` is read by `getQuantitiesForEntity`
    // / `hasPendingChanges` / `collectSetLevelChanges` but nothing populates it.
    // Exercise the enumeration directly against the snapshot shape so this row
    // kind has coverage even though the view can't produce it yet.
    const snapshot = emptySnapshot();
    (snapshot.deletedQsets as Set<string>).add('12:Qto_Base');

    expect(collectEffectiveChanges(snapshot, noopResolvers)).toEqual([
      { entityId: 12, kind: 'qset-deleted', setName: 'Qto_Base' },
    ]);
  });
});

describe('repeated edits and no-extractor fallback (maintainer-requested coverage on #1967)', () => {
  it('reports only the latest edit for A -> B -> C on the same field, previousValue from the original base', () => {
    const view = new MutablePropertyView(null, 'model-1');
    view.setAttributeExtractor((entityId, attrName) => (entityId === 1 && attrName === 'Name' ? 'A' : null));

    view.setAttribute(1, 'Name', 'B');
    view.setAttribute(1, 'Name', 'C');

    expect(view.getEffectiveChanges()).toEqual([
      { entityId: 1, kind: 'attribute', name: 'Name', previousValue: 'A', newValue: 'C' },
    ]);
  });

  it('falls back to the mutation\'s own oldValue when no attribute extractor is registered', () => {
    const view = new MutablePropertyView(null, 'model-1');
    // No setAttributeExtractor call.
    view.setAttribute(1, 'Name', 'New Name', 'Old Name');

    expect(view.getEffectiveChanges()).toEqual([
      { entityId: 1, kind: 'attribute', name: 'Name', previousValue: 'Old Name', newValue: 'New Name' },
    ]);
  });
});

describe('fully-undone edits are not reported as no-op rows (maintainer finding on #1967)', () => {
  it('drops an attribute edit whose overlay was reverted back to the base value via undo', () => {
    const view = new MutablePropertyView(null, 'model-1');
    view.setAttributeExtractor((entityId, attrName) => (entityId === 1 && attrName === 'Name' ? 'Original' : null));

    view.setAttribute(1, 'Name', 'Edited');
    expect(view.getEffectiveChanges()).toEqual([
      { entityId: 1, kind: 'attribute', name: 'Name', previousValue: 'Original', newValue: 'Edited' },
    ]);

    // Undo re-applies the inverse with skipHistory, landing the overlay back
    // at the base value — previousValue === newValue now, so this is a no-op.
    view.setAttribute(1, 'Name', 'Original', undefined, true);
    expect(view.getEffectiveChanges()).toEqual([]);
    expect(view.getModifiedEntityCount()).toBe(0);
  });
});

describe('badge-vs-dialog agreement (maintainer finding 2 on #1967)', () => {
  /**
   * Finding 2 was `getModifiedEntityCount()` (the toolbar badge) silently
   * diverging from the set of entities `getEffectiveChanges()` (the review
   * dialog) actually lists — the badge stayed amber while the dialog denied
   * any changes existed. This is a property that must hold at every overlay
   * state, not just once on a happy path, so it is asserted as one reusable
   * check driven through several shapes below rather than a single equality.
   */
  function assertBadgeAgreesWithDialog(view: MutablePropertyView): void {
    const distinctIds = new Set(view.getEffectiveChanges().map((c) => c.entityId));
    expect(view.getModifiedEntityCount()).toBe(distinctIds.size);
  }

  it('holds across create->edit->delete, an emptied auto-created pset, a tombstoned source entity, a fully-undone edit, and their mix', () => {
    const view = new MutablePropertyView(null, 'model-1');
    view.setExpressIdWatermark(0);
    view.setOnDemandExtractor(() => []);
    view.setAttributeExtractor((entityId, attrName) =>
      entityId === 30 && attrName === 'Name' ? 'Original' : null,
    );

    assertBadgeAgreesWithDialog(view); // empty overlay

    // Shape 1: create -> edit -> delete. `deleteEntity` forgets the created
    // entity entirely, so it must contribute nothing to either side.
    const created = view.createEntity('IfcSpace', ['guid', null, 'New Space']);
    view.setAttribute(created.expressId, 'Name', 'Edited');
    view.setProperty(created.expressId, 'Pset_X', 'A', 'v', PropertyValueType.Label);
    assertBadgeAgreesWithDialog(view);
    view.deleteEntity(created.expressId);
    assertBadgeAgreesWithDialog(view);

    // Shape 2: a property whose auto-created pset is then emptied. The
    // newPsets entry must be cleaned up, not left as a phantom count.
    view.setProperty(10, 'Pset_New', 'A', 'v', PropertyValueType.Label);
    assertBadgeAgreesWithDialog(view);
    view.deleteProperty(10, 'Pset_New', 'A');
    assertBadgeAgreesWithDialog(view);

    // Shape 3: a tombstoned SOURCE (not overlay-created) entity — this one
    // legitimately keeps contributing an entity-deleted row on both sides.
    view.setProperty(20, 'Pset_Base', 'Status', 'Changed', PropertyValueType.Label);
    assertBadgeAgreesWithDialog(view);
    view.deleteEntity(20);
    assertBadgeAgreesWithDialog(view);

    // Shape 4: a fully-undone edit — overlay reverted back to the base value.
    view.setAttribute(30, 'Name', 'Edited');
    assertBadgeAgreesWithDialog(view);
    view.setAttribute(30, 'Name', 'Original', undefined, true);
    assertBadgeAgreesWithDialog(view);

    // The mix: all four shapes landed in the same overlay simultaneously.
    // Only entity 20's tombstone should still be visible to either side —
    // pin the concrete number, not just the invariant, so this test can't
    // pass by both sides being vacuously equal (e.g. both always 0).
    expect(view.getModifiedEntityCount()).toBe(1);
    expect(new Set(view.getEffectiveChanges().map((c) => c.entityId))).toEqual(new Set([20]));
    assertBadgeAgreesWithDialog(view);
  });
});

describe('a quantity on a newly created entity (maintainer finding on #1967)', () => {
  it('collapses into entity-added + qset-added, with no per-quantity previousValue invented', () => {
    const view = new MutablePropertyView(null, 'model-1');
    view.setExpressIdWatermark(0);
    const created = view.createEntity('IfcSpace', ['guid', null, 'New Space']);

    view.createQuantitySet(created.expressId, 'Qto_New', [
      { name: 'Area', value: 12, quantityType: QuantityType.Area },
    ]);

    expect(view.getEffectiveChanges()).toEqual([
      { entityId: created.expressId, kind: 'entity-added', newValue: 'IfcSpace' },
      { entityId: created.expressId, kind: 'qset-added', setName: 'Qto_New' },
    ]);
  });
});

describe('undo -> redo of a repeated edit keeps previousValue at the base value (maintainer-requested coverage on #1967)', () => {
  it('previousValue stays the original base across edit A->B->C, undo back to B, and redo forward to C', () => {
    // Mirrors mutationSlice.ts's real UPDATE_ATTRIBUTE undo/redo call shape:
    // both pass skipHistory=true and leave `oldValue` undefined, relying on
    // the attribute extractor (always registered in production — see
    // configureMutationView.ts / sdk/adapters/mutation-view.ts) to re-derive
    // previousValue from the true base rather than a stale mutation.oldValue.
    const view = new MutablePropertyView(null, 'model-1');
    view.setAttributeExtractor((entityId, attrName) => (entityId === 1 && attrName === 'Name' ? 'A' : null));

    view.setAttribute(1, 'Name', 'B');
    view.setAttribute(1, 'Name', 'C');
    expect(view.getEffectiveChanges()).toEqual([
      { entityId: 1, kind: 'attribute', name: 'Name', previousValue: 'A', newValue: 'C' },
    ]);

    // Undo: back to B.
    view.setAttribute(1, 'Name', 'B', undefined, true);
    expect(view.getEffectiveChanges()).toEqual([
      { entityId: 1, kind: 'attribute', name: 'Name', previousValue: 'A', newValue: 'B' },
    ]);

    // Redo: forward to C again.
    view.setAttribute(1, 'Name', 'C', undefined, true);
    expect(view.getEffectiveChanges()).toEqual([
      { entityId: 1, kind: 'attribute', name: 'Name', previousValue: 'A', newValue: 'C' },
    ]);
  });
});

describe('EffectiveChangesResolvers with no extractors registered (maintainer-requested coverage on #1967)', () => {
  it('derives previousValue from base pset/qset data and the mutation\'s own oldValue when attributeExtractor is null', () => {
    const resolvers: EffectiveChangesResolvers = {
      attributeExtractor: null,
      resolveBaseEntityId: (entityId) => entityId,
      getBasePropertiesForEntity: (entityId) =>
        entityId === 1
          ? [{
            name: 'Pset_Base',
            globalId: 'base-guid',
            properties: [{ name: 'Status', type: PropertyValueType.Label, value: 'Original' }],
          }]
          : [],
      getBaseQuantitiesForEntity: (entityId) =>
        entityId === 1
          ? [{ name: 'Qto_Base', quantities: [{ name: 'Area', type: QuantityType.Area, value: 10 }] }]
          : [],
    };

    const propKey = propertyKey(1, 'Pset_Base', 'Status');
    const qtyKey = quantityKey(1, 'Qto_Base', 'Area');

    const snapshot: EffectiveChangesSnapshot = {
      ...emptySnapshot(),
      attributeMutations: new Map([['1:attr:Name', { attribute: 'Name', value: 'New Name', oldValue: 'Old Name' }]]),
      propertyKeysByEntity: new Map([[1, new Set([propKey])]]),
      propertyMutations: new Map<string, PropertyMutation>([[propKey, { operation: 'SET', value: 'Changed' }]]),
      quantityKeysByEntity: new Map([[1, new Set([qtyKey])]]),
      quantityMutations: new Map<string, QuantityMutation>([[qtyKey, { operation: 'SET', value: 99 }]]),
    };

    // Every row resolves sensibly off the stub base data / mutation.oldValue
    // fallback — no throw, and no previousValue invented out of thin air.
    expect(collectEffectiveChanges(snapshot, resolvers)).toEqual([
      { entityId: 1, kind: 'attribute', name: 'Name', previousValue: 'Old Name', newValue: 'New Name' },
      { entityId: 1, kind: 'property', setName: 'Pset_Base', name: 'Status', previousValue: 'Original', newValue: 'Changed' },
      { entityId: 1, kind: 'quantity', setName: 'Qto_Base', name: 'Area', previousValue: '10', newValue: '99' },
    ]);
  });

  it('leaves previousValue undefined, rather than inventing one, for an attribute mutation with no extractor and no recorded oldValue', () => {
    const snapshot: EffectiveChangesSnapshot = {
      ...emptySnapshot(),
      attributeMutations: new Map([['1:attr:Name', { attribute: 'Name', value: 'New Name' }]]),
    };

    expect(collectEffectiveChanges(snapshot, noopResolvers)).toEqual([
      { entityId: 1, kind: 'attribute', name: 'Name', previousValue: undefined, newValue: 'New Name' },
    ]);
  });
});

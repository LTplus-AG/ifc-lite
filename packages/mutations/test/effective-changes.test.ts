/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'vitest';
import { PropertyValueType } from '@ifc-lite/data';
import { MutablePropertyView } from '../src/index.js';
import { collectEffectiveChanges, type EffectiveChangesSnapshot, type EffectiveChangesResolvers } from '../src/effective-changes.js';

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

/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'vitest';
import { PropertyValueType, QuantityType } from '@ifc-lite/data';
import { BulkQueryEngine, MutablePropertyView } from '../src/index.js';

describe('MutablePropertyView', () => {
  it('creates a new property set automatically and returns mutated values', () => {
    const view = new MutablePropertyView(null, 'model-1');
    view.setOnDemandExtractor(() => []);

    view.setProperty(42, 'Pset_Custom', 'Code', 'A-01', PropertyValueType.Label);

    expect(view.getPropertyValue(42, 'Pset_Custom', 'Code')).toBe('A-01');
    expect(view.getForEntity(42)).toMatchObject([
      {
        name: 'Pset_Custom',
        properties: [
          {
            name: 'Code',
            type: PropertyValueType.Label,
            value: 'A-01',
          },
        ],
      },
    ]);
  });

  it('deletes an existing property from the overlaid view', () => {
    const view = new MutablePropertyView(null, 'model-1');
    view.setOnDemandExtractor((entityId) => entityId === 7 ? [{
      name: 'Pset_Base',
      globalId: 'base-guid',
      properties: [
        { name: 'Status', type: PropertyValueType.Label, value: 'Existing' },
      ],
    }] : []);

    view.deleteProperty(7, 'Pset_Base', 'Status');

    expect(view.getPropertyValue(7, 'Pset_Base', 'Status')).toBeNull();
    expect(view.getForEntity(7)).toEqual([]);
  });

  it('treats a null/unset property as present, not absent (issue #1107)', () => {
    // A bSDD Boolean is added unset (value null) so we never pick a value for
    // the user. Such a property still EXISTS — null must not be read as absent.
    const view = new MutablePropertyView(null, 'model-1');
    view.setOnDemandExtractor(() => []);

    const created = view.setProperty(9, 'Pset_WallCommon', 'Combustible', null, PropertyValueType.Boolean);
    expect(created.type).toBe('CREATE_PROPERTY');
    expect(view.getForEntity(9)).toMatchObject([
      {
        name: 'Pset_WallCommon',
        properties: [{ name: 'Combustible', type: PropertyValueType.Boolean, value: null }],
      },
    ]);

    // Editing an existing-but-unset property is an UPDATE (not a CREATE), so a
    // later undo restores the prior unset state instead of deleting the property.
    const edited = view.setProperty(9, 'Pset_WallCommon', 'Combustible', true, PropertyValueType.Boolean);
    expect(edited.type).toBe('UPDATE_PROPERTY');
    expect(edited.oldValue).toBeNull();

    // The unset property is still deletable — the trash button is not a no-op.
    const fresh = new MutablePropertyView(null, 'model-1');
    fresh.setOnDemandExtractor(() => []);
    fresh.setProperty(9, 'Pset_WallCommon', 'Combustible', null, PropertyValueType.Boolean);
    expect(fresh.deleteProperty(9, 'Pset_WallCommon', 'Combustible')).not.toBeNull();
    expect(fresh.getForEntity(9)).toEqual([]);
  });

  describe('setQuantity oldValue/type on a base quantity (undo correctness, #2297 shape)', () => {
    it('carries the base value as oldValue on the first edit of an existing quantity', () => {
      // `apps/viewer`'s undo handler only replays `mutation.oldValue` for
      // UPDATE_QUANTITY when it is non-null (`mutationSlice.ts`): if the
      // first edit of an already-existing base quantity reports
      // `oldValue: null` instead of the true prior value, undo silently
      // does nothing — the mutation stays applied. Unlike `setProperty`,
      // which resolves `oldValue` via `getPropertyValue()` (base data +
      // overlay), `setQuantity` must resolve the same way rather than only
      // consulting an existing overlay mutation.
      const view = new MutablePropertyView(null, 'model-1');
      view.setQuantityExtractor((entityId) => entityId === 11 ? [{
        name: 'Qto_Base',
        quantities: [{ name: 'Area', type: QuantityType.Area, value: 10 }],
      }] : []);

      const mutation = view.setQuantity(11, 'Qto_Base', 'Area', 99, QuantityType.Area);

      expect(mutation.type).toBe('UPDATE_QUANTITY');
      expect(mutation.oldValue).toBe(10);
    });

    it('classifies a brand-new quantity added to an existing base qset as CREATE, not UPDATE', () => {
      // `qsetExistsInBase` alone doesn't mean THIS quantity existed — adding
      // a never-before-seen quantity name to an existing qset must report
      // CREATE_QUANTITY (undo removes the mutation outright) rather than
      // UPDATE_QUANTITY with a null oldValue (undo would try, and fail, to
      // restore a "prior" value that never existed).
      const view = new MutablePropertyView(null, 'model-1');
      view.setQuantityExtractor((entityId) => entityId === 11 ? [{
        name: 'Qto_Base',
        quantities: [{ name: 'Area', type: QuantityType.Area, value: 10 }],
      }] : []);

      const mutation = view.setQuantity(11, 'Qto_Base', 'Volume', 42, QuantityType.Volume);

      expect(mutation.type).toBe('CREATE_QUANTITY');
      expect(mutation.oldValue).toBeNull();
    });

    it('still reports UPDATE with the overlay value on a second edit (control)', () => {
      const view = new MutablePropertyView(null, 'model-1');
      view.setQuantityExtractor((entityId) => entityId === 11 ? [{
        name: 'Qto_Base',
        quantities: [{ name: 'Area', type: QuantityType.Area, value: 10 }],
      }] : []);

      view.setQuantity(11, 'Qto_Base', 'Area', 99, QuantityType.Area);
      const second = view.setQuantity(11, 'Qto_Base', 'Area', 123, QuantityType.Area);

      expect(second.type).toBe('UPDATE_QUANTITY');
      expect(second.oldValue).toBe(99);
    });
  });

  describe('entity aliases (duplicate flow)', () => {
    it('routes base property reads to the source entity when aliased', () => {
      const view = new MutablePropertyView(null, 'model-1');
      view.setOnDemandExtractor((entityId) => entityId === 100 ? [{
        name: 'Pset_WallCommon',
        globalId: 'wall-guid',
        properties: [
          { name: 'FireRating', type: PropertyValueType.Label, value: 'REI 60' },
        ],
      }] : []);

      // Without an alias, the duplicate (id 200) has no base props.
      expect(view.getForEntity(200)).toEqual([]);

      // After aliasing, the duplicate inherits the source's psets.
      view.setEntityAlias(200, 100);
      expect(view.getForEntity(200)).toMatchObject([
        {
          name: 'Pset_WallCommon',
          properties: [
            { name: 'FireRating', value: 'REI 60' },
          ],
        },
      ]);
    });

    it('keeps overrides scoped to the duplicate id, not the source', () => {
      const view = new MutablePropertyView(null, 'model-1');
      view.setOnDemandExtractor((entityId) => entityId === 100 ? [{
        name: 'Pset_WallCommon',
        globalId: 'wall-guid',
        properties: [
          { name: 'FireRating', type: PropertyValueType.Label, value: 'REI 60' },
        ],
      }] : []);

      view.setEntityAlias(200, 100);

      // Edit on the duplicate.
      view.setProperty(200, 'Pset_WallCommon', 'FireRating', 'REI 120', PropertyValueType.Label);

      // Source's view of FireRating is unchanged.
      expect(view.getPropertyValue(100, 'Pset_WallCommon', 'FireRating')).toBe('REI 60');
      // Duplicate's view shows the override.
      expect(view.getPropertyValue(200, 'Pset_WallCommon', 'FireRating')).toBe('REI 120');
    });

    it('clears the alias when sourceId is null', () => {
      const view = new MutablePropertyView(null, 'model-1');
      view.setEntityAlias(200, 100);
      expect(view.getEntityAlias(200)).toBe(100);
      view.setEntityAlias(200, null);
      expect(view.getEntityAlias(200)).toBeNull();
    });

    it('refuses self-aliases (no-op)', () => {
      const view = new MutablePropertyView(null, 'model-1');
      view.setEntityAlias(42, 42);
      expect(view.getEntityAlias(42)).toBeNull();
    });
  });
});

describe('BulkQueryEngine', () => {
  it('selects by GlobalId and applies property mutations', () => {
    const strings = ['guid-wall-a', 'guid-wall-b', 'Wall Alpha', 'Wall Beta'];
    const view = new MutablePropertyView(null, 'model-1');
    view.setOnDemandExtractor(() => []);

    const entities = {
      count: 2,
      expressId: new Int32Array([1, 2]),
      typeEnum: new Uint32Array([10, 10]),
      globalId: new Int32Array([0, 1]),
      name: new Int32Array([2, 3]),
    } as any;

    const engine = new BulkQueryEngine(
      entities,
      view,
      null,
      null,
      { get: (idx: number) => strings[idx] },
    );

    const preview = engine.preview({
      select: { globalIds: ['guid-wall-b'] },
      action: {
        type: 'SET_PROPERTY',
        psetName: 'Pset_Bulk',
        propName: 'Zone',
        value: 'B',
        valueType: PropertyValueType.Label,
      },
    });

    expect(preview.matchedEntityIds).toEqual([2]);

    const result = engine.execute({
      select: { entityTypes: [10], namePattern: 'Wall' },
      action: {
        type: 'SET_PROPERTY',
        psetName: 'Pset_Bulk',
        propName: 'Zone',
        value: 'North',
        valueType: PropertyValueType.Label,
      },
    });

    expect(result.success).toBe(true);
    expect(result.affectedEntityCount).toBe(2);
    expect(view.getPropertyValue(1, 'Pset_Bulk', 'Zone')).toBe('North');
    expect(view.getPropertyValue(2, 'Pset_Bulk', 'Zone')).toBe('North');
  });
});

describe('MutablePropertyView.hasPendingChanges', () => {
  it('is false on a fresh view and true once an overlay edit is recorded', () => {
    const view = new MutablePropertyView(null, 'model-1');
    view.setOnDemandExtractor(() => []);
    expect(view.hasPendingChanges()).toBe(false);

    view.setProperty(1, 'Pset_Test', 'Foo', 'bar', PropertyValueType.Label);
    expect(view.hasPendingChanges()).toBe(true);
  });

  it('returns to false after clear()', () => {
    const view = new MutablePropertyView(null, 'model-1');
    view.createPropertySet(1, 'Pset_New', [{ name: 'A', value: 'x', type: PropertyValueType.Label }]);
    expect(view.hasPendingChanges()).toBe(true);

    view.clear();
    expect(view.hasPendingChanges()).toBe(false);
  });

  it('tracks the current overlay footprint, not append-only history', () => {
    const view = new MutablePropertyView(null, 'model-1');
    view.setOnDemandExtractor(() => []);
    view.setProperty(1, 'Pset_Test', 'Foo', 'bar', PropertyValueType.Label);
    // History only grows; the overlay footprint is what gates the export bake.
    expect(view.getMutations().length).toBeGreaterThan(0);
    expect(view.hasPendingChanges()).toBe(true);
  });

  it('reports a type-only (retype) edit so merged export does not drop it', () => {
    const view = new MutablePropertyView(null, 'model-1');
    expect(view.hasPendingChanges()).toBe(false);

    view.setEntityType(1, 'IfcColumn');
    expect(view.hasPendingChanges()).toBe(true);
  });
});

describe('MutablePropertyView.getModifiedEntityCount / hasChanges (issue #1915)', () => {
  it('agrees with hasPendingChanges() after an undo that only clears the overlay entry', () => {
    // Exactly what undoing a freshly-created attribute mutation does
    // (mutationSlice.ts): the overlay entry is removed, but mutationHistory
    // (append-only) still holds the original record.
    const view = new MutablePropertyView(null, 'model-1');
    view.setAttribute(42, 'Name', 'Edited');
    expect(view.getModifiedEntityCount()).toBe(1);
    expect(view.hasChanges()).toBe(true);
    expect(view.hasChanges(42)).toBe(true);

    view.removeAttributeMutation(42, 'Name');

    expect(view.hasPendingChanges()).toBe(false);
    expect(view.getModifiedEntityCount()).toBe(0);
    expect(view.hasChanges()).toBe(false);
    expect(view.hasChanges(42)).toBe(false);
    // mutationHistory itself is untouched (append-only) — the discrepancy
    // this fix closes.
    expect(view.getMutations().length).toBe(1);
  });

  it('counts distinct entities, not distinct mutations', () => {
    const view = new MutablePropertyView(null, 'model-1');
    view.setOnDemandExtractor(() => []);
    view.setProperty(1, 'Pset1', 'Prop1', 'a', PropertyValueType.Label);
    view.setProperty(1, 'Pset1', 'Prop2', 'b', PropertyValueType.Label);
    view.setAttribute(2, 'Name', 'Two');

    expect(view.getModifiedEntityCount()).toBe(2);
  });
});

// The enumeration itself (`collectEffectiveChanges`, extracted into
// `effective-changes.ts` to keep this file from growing past the AGENTS.md
// module-split guideline) is covered in `effective-changes.test.ts`. This
// integration test stays here because it's specifically about
// `MutablePropertyView`'s own undo/redo behaviour — `setProperty(..., true)`
// with `skipHistory` — agreeing with `getEffectiveChanges()`'s base-value
// resolution, not about the enumeration logic in isolation.
describe('MutablePropertyView.getEffectiveChanges (issue #1915)', () => {
  it('reports the true original value across an undo -> redo cycle, not a stale history entry', () => {
    const view = new MutablePropertyView(null, 'model-1');
    view.setOnDemandExtractor((entityId) => entityId === 7 ? [{
      name: 'Pset_Base',
      globalId: 'base-guid',
      properties: [
        { name: 'Status', type: PropertyValueType.Label, value: 'Original' },
      ],
    }] : []);

    // Edit.
    view.setProperty(7, 'Pset_Base', 'Status', 'Edited', PropertyValueType.Label);
    expect(view.getEffectiveChanges()).toEqual([
      {
        entityId: 7,
        kind: 'property',
        setName: 'Pset_Base',
        name: 'Status',
        previousValue: 'Original',
        newValue: 'Edited',
      },
    ]);

    // Undo: revert the overlay to the original value (mirrors mutationSlice's
    // undo, which re-applies the inverse with skipHistory rather than
    // popping mutationHistory).
    view.setProperty(7, 'Pset_Base', 'Status', 'Original', PropertyValueType.Label, undefined, true);
    // previousValue still comes from the base extractor, not from the now-stale
    // history entry — so it resolves to 'Original' — same as newValue. That
    // makes this a no-op edit: the user undid it, so the review must not list
    // a "Status Original -> Original" row for a change that no longer exists
    // (maintainer finding on #1967 — a fully-undone edit was rendering as a
    // phantom no-op row).
    expect(view.getEffectiveChanges()).toEqual([]);

    // Redo: re-apply the edit.
    view.setProperty(7, 'Pset_Base', 'Status', 'Edited', PropertyValueType.Label, undefined, true);
    expect(view.getEffectiveChanges()).toEqual([
      {
        entityId: 7,
        kind: 'property',
        setName: 'Pset_Base',
        name: 'Status',
        previousValue: 'Original',
        newValue: 'Edited',
      },
    ]);
  });
});

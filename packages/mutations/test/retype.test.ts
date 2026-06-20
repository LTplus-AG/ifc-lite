/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { afterEach, describe, expect, it } from 'vitest';
import {
  MutablePropertyView,
  StoreEditor,
  BulkQueryEngine,
  setEntityTypeNormalizer,
  type BulkAction,
  type MutationEntityRef,
  type MutationStoreShape,
} from '../src/index.js';

function makeStore(maxId: number, type = 'IFCBUILDINGELEMENTPROXY'): MutationStoreShape {
  const byId = new Map<number, MutationEntityRef>();
  for (let id = 1; id <= maxId; id++) {
    byId.set(id, { expressId: id, type, byteOffset: 0, byteLength: 1, lineNumber: id });
  }
  return { entityIndex: { byId } };
}

afterEach(() => {
  // The normaliser is module-global — reset so tests don't leak into each other.
  setEntityTypeNormalizer(null);
});

describe('StoreEditor.setEntityType', () => {
  it('records a retype intent for an existing entity', () => {
    const store = makeStore(10);
    const view = new MutablePropertyView(null, 'm1');
    const editor = new StoreEditor(store, view);

    const ok = editor.setEntityType(5, 'IfcColumn');

    expect(ok).toBe(true);
    const mut = view.getEntityTypeMutation(5);
    expect(mut).not.toBeNull();
    expect(mut!.newType).toBe('IfcColumn');
    expect(mut!.oldType).toBe('IFCBUILDINGELEMENTPROXY');
    expect(mut!.predefinedType).toBeNull();
  });

  it('carries an optional PredefinedType', () => {
    const store = makeStore(3);
    const view = new MutablePropertyView(null, 'm1');
    const editor = new StoreEditor(store, view);

    editor.setEntityType(2, 'IfcColumn', { predefinedType: 'PILASTER' });

    expect(view.getEntityTypeMutation(2)!.predefinedType).toBe('PILASTER');
  });

  it('returns false for an unknown expressId', () => {
    const store = makeStore(3);
    const view = new MutablePropertyView(null, 'm1');
    const editor = new StoreEditor(store, view);

    expect(editor.setEntityType(999, 'IfcColumn')).toBe(false);
    expect(view.getEntityTypeMutation(999)).toBeNull();
  });

  it('rejects an empty or non-IFC type', () => {
    const store = makeStore(3);
    const view = new MutablePropertyView(null, 'm1');
    const editor = new StoreEditor(store, view);

    expect(() => editor.setEntityType(1, '')).toThrow(/cannot be empty/);
    expect(() => editor.setEntityType(1, 'Column')).toThrow(/not a recognizable IFC entity name/);
  });

  it('normalizes via the configured registry resolver', () => {
    setEntityTypeNormalizer((t) => (t.toUpperCase() === 'IFCCOLUMN' ? 'IfcColumn' : ''));
    const store = makeStore(3);
    const view = new MutablePropertyView(null, 'm1');
    const editor = new StoreEditor(store, view);

    editor.setEntityType(1, 'IFCCOLUMN');
    expect(view.getEntityTypeMutation(1)!.newType).toBe('IfcColumn');

    // A name the resolver doesn't know is rejected.
    expect(() => editor.setEntityType(2, 'IfcNotAThing')).toThrow(/not in the IFC schema registry/);
  });
});

describe('MutablePropertyView.setEntityType', () => {
  it('counts as a change and surfaces in the mutation history', () => {
    const view = new MutablePropertyView(null, 'm1');
    view.setEntityType(7, 'IfcBeam', null, 'IfcBuildingElementProxy');

    expect(view.hasChanges(7)).toBe(true);
    expect(view.getModifiedEntityCount()).toBe(1);
    const history = view.getMutationsForEntity(7);
    expect(history).toHaveLength(1);
    expect(history[0].type).toBe('UPDATE_ENTITY_TYPE');
    expect(history[0].entityType).toBe('IfcBeam');
  });

  it('retypes a freshly-created overlay entity via the overlay (authored type preserved)', () => {
    const view = new MutablePropertyView(null, 'm1');
    view.setExpressIdWatermark(10);
    const created = view.createEntity('IfcBuildingElementProxy', ['guid', '$', "'P'", '$', '$', '#1', '$', '$', '$']);

    view.setEntityType(created.expressId, 'IfcColumn');

    // The NewEntity keeps its AUTHORED type (attributes stay in that layout);
    // the overlay typeMutation carries the effective class. This keeps undo a
    // clean revert and lets the exporter re-lay-out from the authored layout.
    expect(view.getNewEntity(created.expressId)!.type).toBe('IfcBuildingElementProxy');
    expect(view.getEntityTypeMutation(created.expressId)!.newType).toBe('IfcColumn');
    expect(view.getEntityTypeMutation(created.expressId)!.oldType).toBe('IfcBuildingElementProxy');
  });

  it('rejects an invalid type keyword at the view boundary (bulk path safety)', () => {
    const view = new MutablePropertyView(null, 'm1');
    expect(() => view.setEntityType(1, 'Column')).toThrow(/not a recognizable IFC entity name/);
    expect(() => view.setEntityType(1, '')).toThrow(/is required/);
    expect(() => view.setEntityType(1, '   ')).toThrow(/cannot be empty/);
    expect(view.getEntityTypeMutation(1)).toBeNull();
  });

  it('preserves the original type across repeated retypes (sticky oldType)', () => {
    const view = new MutablePropertyView(null, 'm1');
    view.setExpressIdWatermark(10);
    const created = view.createEntity('IfcBuildingElementProxy', ['g', '$', "'P'", '$', '$', '$', '$', '$', '$']);

    view.setEntityType(created.expressId, 'IfcColumn');
    view.setEntityType(created.expressId, 'IfcBeam');

    const mut = view.getEntityTypeMutation(created.expressId)!;
    expect(mut.newType).toBe('IfcBeam');
    // oldType must remain the ORIGINAL authored class, not the intermediate one,
    // so export re-lays-out from the attributes' true layout.
    expect(mut.oldType).toBe('IfcBuildingElementProxy');
  });

  it('getTypeMutations returns a defensive copy', () => {
    const view = new MutablePropertyView(null, 'm1');
    view.setEntityType(3, 'IfcColumn');
    const copy = view.getTypeMutations();
    copy.delete(3);
    expect(view.getEntityTypeMutation(3)).not.toBeNull();
  });

  it('clear() drops retype intents', () => {
    const view = new MutablePropertyView(null, 'm1');
    view.setEntityType(3, 'IfcColumn');
    view.clear();
    expect(view.getEntityTypeMutation(3)).toBeNull();
    expect(view.hasChanges()).toBe(false);
  });

  it('replays through exportMutations → importMutations', () => {
    const a = new MutablePropertyView(null, 'm1');
    a.setEntityType(4, 'IfcMember', 'MULLION', 'IfcBuildingElementProxy');
    const json = a.exportMutations();

    const b = new MutablePropertyView(null, 'm1');
    b.importMutations(json);

    const mut = b.getEntityTypeMutation(4);
    expect(mut).not.toBeNull();
    expect(mut!.newType).toBe('IfcMember');
    expect(mut!.predefinedType).toBe('MULLION');
  });
});

describe('BulkAction SET_ENTITY_TYPE', () => {
  it('applies a retype to a selected entity', () => {
    const view = new MutablePropertyView(null, 'm1');
    // Minimal EntityTable stub — the engine only needs count + expressId here.
    const entities = { count: 1, expressId: [42] } as unknown as ConstructorParameters<typeof BulkQueryEngine>[0];
    const engine = new BulkQueryEngine(entities, view);

    const action: BulkAction = { type: 'SET_ENTITY_TYPE', entityType: 'IfcColumn', predefinedType: 'COLUMN' };
    const result = engine.execute({ select: { expressIds: [42] }, action });

    expect(result.affectedEntityCount).toBe(1);
    const mut = view.getEntityTypeMutation(42);
    expect(mut!.newType).toBe('IfcColumn');
    expect(mut!.predefinedType).toBe('COLUMN');
  });

  it('surfaces an invalid type keyword as an error instead of recording it', () => {
    const view = new MutablePropertyView(null, 'm1');
    const entities = { count: 1, expressId: [42] } as unknown as ConstructorParameters<typeof BulkQueryEngine>[0];
    const engine = new BulkQueryEngine(entities, view);

    const action: BulkAction = { type: 'SET_ENTITY_TYPE', entityType: 'Column' };
    const result = engine.execute({ select: { expressIds: [42] }, action });

    expect(result.success).toBe(false);
    expect(result.affectedEntityCount).toBe(0);
    expect(view.getEntityTypeMutation(42)).toBeNull();
  });
});

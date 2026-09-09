/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { describe, expect, it } from 'vitest';
import { PropertyValueType, QuantityType } from '@ifc-lite/data';
import { MutablePropertyView } from './mutable-property-view.js';
import { StoreEditor } from './store-editor.js';
import type { IfcAttributeValue } from './types.js';

function fixture() {
  const view = new MutablePropertyView(null, 'model');
  const editor = new StoreEditor({ entityIndex: { byId: new Map() } }, view);
  const item = editor.addEntity('IfcTriangulatedFaceSet', ['#9', null, false, [[1, 2, 3]], null]);
  view.setProperty(item.expressId, 'Existing', 'Note', 'keep', PropertyValueType.String);
  view.setQuantity(item.expressId, 'Existing', 'Area', 12, QuantityType.Area);
  return { view, editor, item: item.expressId };
}

describe('atomic overlay editing #4243', () => {
  it('prepares without changing live exports/history/allocator and publishes once', () => {
    const { view, editor } = fixture();
    const next = view.peekNextExpressId();
    const count = view.getMutations().length;
    const prepared = view.prepareAtomic(draft => new StoreEditor({ entityIndex: { byId: new Map() } }, draft)
      .addEntity('IfcImageTexture', [true, true, null, null, null, 'new.png']));
    expect(editor.getNewEntity(next)).toBeNull();
    expect(view.peekNextExpressId()).toBe(next);
    expect(view.getMutations()).toHaveLength(count);
    prepared.validate();
    prepared.commit();
    expect(editor.getNewEntity(next)?.attributes[5]).toBe('new.png');
    expect(view.getMutations()).toHaveLength(count + 1);
    editor.addEntity('IfcColourRgb', [null, 0, 1, 0]);
    prepared.commit(); // Does not re-adopt an old snapshot over the later edit.
    expect(editor.getNewEntity(next + 1)).not.toBeNull();
  });

  it('refuses a stale prepared draft after ordinary, skip-history and nested edits', () => {
    for (const editKind of ['ordinary', 'skip-history', 'nested'] as const) {
      const { view, editor, item } = fixture();
      const prepared = view.prepareAtomic(draft => draft.setPositionalAttribute(item, 2, true));
      if (editKind === 'ordinary') editor.addEntity('IfcColourRgb', [null, 1, 0, 0]);
      else if (editKind === 'skip-history') view.setPositionalAttribute(item, 2, false, true);
      else editor.getNewEntity(item)!.attributes[2] = true;
      const actual = structuredClone({ entities: editor.getNewEntities(), history: view.getMutations(),
        positional: view.getPositionalMutationsForEntity(item), next: view.peekNextExpressId() });
      expect(() => prepared.validate()).toThrow('overlay changed');
      expect(() => prepared.commit()).toThrow('overlay changed');
      expect({ entities: editor.getNewEntities(), history: view.getMutations(),
        positional: view.getPositionalMutationsForEntity(item), next: view.peekNextExpressId() }).toEqual(actual);
    }
  });

  it('does not erase a reentrant edit made directly to the original view', () => {
    const { view, editor, item } = fixture();
    expect(() => view.prepareAtomic(draft => {
      draft.setPositionalAttribute(item, 2, true);
      editor.addEntity('IfcColourRgb', [null, 1, 0, 0]);
    })).toThrow('overlay changed');
    expect(editor.getNewEntities()).toHaveLength(2);
    expect(view.getPositionalMutationsForEntity(item)).toBeNull();
  });

  it('rolls back a failed external publication including history/allocator, but never erases later edits', () => {
    const { view, editor, item } = fixture();
    const before = structuredClone({ entities: editor.getNewEntities(), history: view.getMutations(), next: view.peekNextExpressId() });
    const transaction = view.prepareAtomic(draft => {
      draft.deleteEntity(item);
      new StoreEditor({ entityIndex: { byId: new Map() } }, draft).addEntity('IfcColourRgb', [null, 0, 0, 1]);
    });
    transaction.commit();
    transaction.rollback();
    transaction.rollback();
    expect({ entities: editor.getNewEntities(), history: view.getMutations(), next: view.peekNextExpressId() }).toEqual(before);
    const newer = view.prepareAtomic(draft => draft.setPositionalAttribute(item, 2, true));
    newer.commit();
    editor.addEntity('IfcColourRgb', [null, 0, 1, 0]);
    expect(() => newer.rollback()).toThrow('changed after');
    expect(editor.getNewEntities()).toHaveLength(2);
    expect(view.getPositionalMutationsForEntity(item)?.get(2)).toBe(true);
  });

  it('rejects rollback after nested or skip-history edits to published maps', () => {
    for (const nested of [true, false]) {
      const { view, editor, item } = fixture();
      const transaction = view.prepareAtomic(draft => draft.setPositionalAttribute(item, 2, true));
      transaction.commit();
      if (nested) editor.getNewEntity(item)!.attributes[2] = true;
      else view.setPositionalAttribute(item, 2, false, true);
      const changed = structuredClone({ entities: editor.getNewEntities(), positional: view.getPositionalMutationsForEntity(item) });
      expect(() => transaction.rollback()).toThrow('changed after');
      expect({ entities: editor.getNewEntities(), positional: view.getPositionalMutationsForEntity(item) }).toEqual(changed);
    }
  });

  it('cannot recommit a rolled-back transaction', () => {
    const { view, item } = fixture();
    const transaction = view.prepareAtomic(draft => draft.setPositionalAttribute(item, 2, true));
    transaction.commit();
    transaction.rollback();
    expect(() => transaction.commit()).toThrow('rolled back');
    expect(view.getPositionalMutationsForEntity(item)).toBeNull();
  });

  it('resolves live source/deferred/created IDs and refuses removed or invalid IDs', () => {
    const view = new MutablePropertyView(null, 'model');
    const editor = new StoreEditor({ entityIndex: { byId: new Map([[10, { expressId: 10, byteOffset: 0, byteLength: 1, lineNumber: 1, type: 'IFCWALL' }]]) },
      deferredEntityIndex: new Map([[20, { expressId: 20, byteOffset: 1, byteLength: 1, lineNumber: 2, type: 'IFCWALL' }]]) }, view);
    expect(editor.hasEntity(10)).toBe(true);
    expect(editor.hasEntity(20)).toBe(true);
    const created = editor.addEntity('IfcColourRgb', [null, 1, 0, 0]);
    expect(editor.hasEntity(created.expressId)).toBe(true);
    editor.removeEntity(created.expressId);
    editor.removeEntity(10);
    expect(editor.hasEntity(created.expressId)).toBe(false);
    expect(editor.hasEntity(10)).toBe(false);
    for (const id of [0, -1, 1.5, NaN, Infinity, 999]) expect(editor.hasEntity(id)).toBe(false);
  });

  it('publishes a texture entity graph and its item edit together, never intermediate records', () => {
    const { view, editor, item } = fixture();
    const created = editor.runAtomic(draft => {
      const texture = draft.addEntity('IfcImageTexture', [true, true, '.DIFFUSE.', null, null, 'textures/image.png']);
      const uv = draft.addEntity('IfcTextureVertexList', [[[0, 0], [1, 0], [0, 1]]]);
      const map = draft.addEntity('IfcIndexedTriangleTextureMap', [[`#${texture.expressId}`], `#${item}`, `#${uv.expressId}`, [[1, 2, 3]]]);
      draft.setPositionalAttribute(item, 2, true);
      expect(editor.getNewEntities()).toHaveLength(1);
      expect(view.getPositionalMutationsForEntity(item)).toBeNull();
      return { texture, uv, map };
    });
    expect(editor.getNewEntities()).toHaveLength(4);
    expect(editor.getNewEntity(created.map.expressId)?.attributes).toEqual([
      [`#${created.texture.expressId}`], `#${item}`, `#${created.uv.expressId}`, [[1, 2, 3]],
    ]);
    expect(view.getPositionalMutationsForEntity(item)?.get(2)).toBe(true);
  });

  it('preserves entities, dependent properties/quantities, history and allocator after failure', () => {
    const { view, editor, item } = fixture();
    const before = structuredClone({ entities: editor.getNewEntities(), history: view.getMutations(),
      properties: view.getForEntity(item), quantities: view.getQuantitiesForEntity(item) });
    const next = view.peekNextExpressId();
    expect(() => editor.runAtomic(draft => {
      draft.removeEntity(item);
      draft.addEntity('IfcImageTexture', [true, true, null, null, null, 'new.png']);
      throw new Error('failed prepared edit');
    })).toThrow('failed prepared edit');
    expect({ entities: editor.getNewEntities(), history: view.getMutations(),
      properties: view.getForEntity(item), quantities: view.getQuantitiesForEntity(item) }).toEqual(before);
    expect(view.peekNextExpressId()).toBe(next);
    expect(editor.addEntity('IfcColourRgb', [null, 1, 0, 0]).expressId).toBe(next);
  });

  it('detaches escaped draft editors and nested attribute arrays after success', () => {
    const { editor, item } = fixture();
    let escaped: StoreEditor | undefined;
    const attributes = [[0, 0], [1, 0], [0, 1]];
    const uv = editor.runAtomic(draft => {
      escaped = draft;
      return draft.addEntity('IfcTextureVertexList', [attributes]);
    });
    attributes[0][0] = 99;
    escaped?.removeEntity(item);
    escaped?.setPositionalAttribute(uv.expressId, 0, [[88, 88]]);
    expect(editor.getNewEntity(item)).not.toBeNull();
    expect(editor.getNewEntity(uv.expressId)?.attributes).toEqual([[[0, 0], [1, 0], [0, 1]]]);
  });

  it('discards asynchronous drafts including writes occurring after rejection', async () => {
    const { editor } = fixture();
    let finish: (() => void) | undefined;
    const gate = new Promise<void>(resolve => { finish = resolve; });
    let operation: Promise<void> | undefined;
    expect(() => editor.runAtomic(draft => {
      operation = (async () => {
        draft.addEntity('IfcColourRgb', [null, 1, 0, 0]);
        await gate;
        draft.addEntity('IfcColourRgb', [null, 0, 1, 0]);
      })();
      return operation;
    })).toThrow('must be synchronous');
    finish?.();
    await operation;
    expect(editor.getNewEntities()).toHaveLength(1);
  });

  it('compares cyclic escaped values without cloning or losing nested edit detection #4243', () => {
    const { view, editor, item } = fixture();
    const cycle: IfcAttributeValue[] = [1];
    cycle.push(cycle);
    // SDK getters expose mutable values: validation must inspect the current
    // graph, including cycles, instead of trusting history or object identity.
    editor.getNewEntity(item)!.attributes[3] = cycle;
    const prepared = view.prepareAtomic(draft => draft.setPositionalAttribute(item, 2, true));
    prepared.validate();
    cycle[0] = 2;
    expect(() => prepared.validate()).toThrow('overlay changed');
    expect(() => prepared.commit()).toThrow('overlay changed');
    expect(view.getPositionalMutationsForEntity(item)).toBeNull();
    expect(editor.getNewEntity(item)!.attributes[3]).toBe(cycle);
  });

  it('retains detached cyclic publication and refuses rollback over escaped changes #4243', () => {
    const { view, editor, item } = fixture();
    const cycle: IfcAttributeValue[] = [1];
    cycle.push(cycle);
    let escaped: MutablePropertyView | undefined;
    const transaction = view.prepareAtomic(draft => {
      escaped = draft;
      draft.setPositionalAttribute(item, 3, cycle, true);
    });
    transaction.commit();
    cycle[0] = 8;
    escaped!.setPositionalAttribute(item, 2, true, true);
    const published = view.getPositionalMutationsForEntity(item)!.get(3) as IfcAttributeValue[];
    expect(published[0]).toBe(1);
    expect(published[1]).toBe(published);
    expect(view.getPositionalMutationsForEntity(item)!.has(2)).toBe(false);
    published[0] = 9;
    expect(() => transaction.rollback()).toThrow('changed after');
    expect(view.getPositionalMutationsForEntity(item)!.get(3)).toBe(published);
    expect(published[0]).toBe(9);
  });

});

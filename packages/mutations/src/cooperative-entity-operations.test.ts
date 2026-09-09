/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { describe, expect, it } from 'vitest';
import { PropertyValueType, QuantityType } from '@ifc-lite/data';
import { MutablePropertyView } from './mutable-property-view.js';
import { StoreEditor } from './store-editor.js';
import type { EntityOperation } from './cooperative-operation-types.js';
import type { IfcAttributeValue, MutationStoreShape, MutationEntityRef } from './types.js';

function fixture() {
  const byId = new Map<number, MutationEntityRef>();
  const store: MutationStoreShape = { entityIndex: { byId } };
  const view = new MutablePropertyView(null, 'm');
  const editor = new StoreEditor(store, view);
  const item = editor.addEntity('IfcTriangulatedFaceSet', ['#9', null, false, [[1, 2, 3]], null]).expressId;
  const next = view.peekNextExpressId();
  const values = Array.from({ length: 3000 }, (_, i) => [i / 100, -i / 100]);
  const operations: EntityOperation[] = [
    { kind: 'create', expressId: next, type: 'IfcTextureVertexList', attributes: [values] },
    { kind: 'setPositionalAttribute', expressId: item, index: 2, value: true },
  ];
  return { store, byId, view, editor, item, next, values, operations };
}
const quick = { maxSliceMs: Number.MIN_VALUE, yieldTask: async () => undefined };

describe('cooperative owned entity preparation #4243', () => {
  it('yields within a single large value, preserves the live model until commit, and publishes once', async () => {
    const { view, editor, item, next, operations } = fixture();
    const history = view.getMutations().length;
    let yields = 0;
    const prepared = await editor.prepareEntityOperations(operations, {
      maxSliceMs: Number.MIN_VALUE,
      yieldTask: async () => {
        yields++;
        expect(editor.getNewEntity(next)).toBeNull();
        expect(view.peekNextExpressId()).toBe(next);
        expect(view.getMutations()).toHaveLength(history);
      },
    });
    expect(yields).toBeGreaterThan(10);
    expect(prepared.effects).toHaveLength(2);
    prepared.validate();
    prepared.commit();
    expect(editor.getNewEntity(next)?.attributes).toEqual(operations[0].kind === 'create' ? operations[0].attributes : []);
    expect(view.getPositionalMutationsForEntity(item)?.get(2)).toBe(true);
    const count = view.getMutations().length;
    prepared.commit();
    expect(view.getMutations()).toHaveLength(count);
  });

  it('the default scheduler lets a host task run before preparation completes', async () => {
    const { editor, operations } = fixture();
    let taskRan = false;
    const preparation = editor.prepareEntityOperations(operations, { maxSliceMs: 0.01 });
    const timer = setTimeout(() => { taskRan = true; }, 0);
    try {
      const prepared = await preparation;
      expect(taskRan).toBe(true);
      prepared.dispose();
    } finally { clearTimeout(timer); }
  });

  it('detects caller input changes after an earlier copy slice and after preparation completes', async () => {
    for (const afterReady of [false, true]) {
      const { editor, view, next, values, operations } = fixture();
      let changed = false;
      if (!afterReady) {
        await expect(editor.prepareEntityOperations(operations, { maxSliceMs: Number.MIN_VALUE, yieldTask: async () => {
          if (!changed) { changed = true; values[0][0] = 987; }
        } })).rejects.toThrow('operation inputs changed');
      } else {
        const prepared = await editor.prepareEntityOperations(operations, quick);
        values[0][0] = 987;
        expect(() => prepared.commit()).toThrow('operation inputs changed');
      }
      expect(editor.getNewEntity(next)).toBeNull();
      expect(view.peekNextExpressId()).toBe(next);
    }
  });

  it('rejects ordinary, skip-history and escaped SDK writes after a coherent original snapshot', async () => {
    for (const kind of ['ordinary', 'skip-history', 'escaped'] as const) {
      const { editor, view, item, next, operations } = fixture();
      const prepared = await editor.prepareEntityOperations(operations, quick);
      if (kind === 'ordinary') editor.setPositionalAttribute(item, 2, false);
      if (kind === 'skip-history') view.setPositionalAttribute(item, 2, false, true);
      if (kind === 'escaped') editor.getNewEntity(item)!.attributes[2] = true;
      const actual = structuredClone({ entities: editor.getNewEntities(), positional: view.getPositionalMutationsForEntity(item), history: view.getMutations() });
      expect(() => prepared.validate()).toThrow('overlay changed');
      expect(() => prepared.commit()).toThrow('overlay changed');
      expect({ entities: editor.getNewEntities(), positional: view.getPositionalMutationsForEntity(item), history: view.getMutations() }).toEqual(actual);
      expect(editor.getNewEntity(next)).toBeNull();
    }
  });

  it('rejects an escaped SDK change to a value already visited during overlay capture', async () => {
    const { editor, view, item, values } = fixture();
    editor.getNewEntity(item)!.attributes[3] = values;
    let changed = false;
    await expect(editor.prepareEntityOperations([
      { kind: 'setPositionalAttribute', expressId: item, index: 2, value: true },
    ], { maxSliceMs: Number.MIN_VALUE, yieldTask: async () => {
      if (!changed) { changed = true; values[0][0] = 321; }
    } })).rejects.toThrow('overlay changed');
    expect(values[0][0]).toBe(321);
    expect(view.getPositionalMutationsForEntity(item)).toBeNull();
  });

  it('cancels at deterministic copy boundaries without changing history or allocator', async () => {
    for (const cancelAt of [1, 3, 10, 30]) {
      const { editor, view, next, operations } = fixture();
      const history = structuredClone(view.getMutations());
      const abort = new AbortController();
      let yields = 0;
      await expect(editor.prepareEntityOperations(operations, { signal: abort.signal,
        maxSliceMs: Number.MIN_VALUE, yieldTask: async () => { if (++yields === cancelAt) abort.abort(); },
      })).rejects.toMatchObject({ name: 'AbortError' });
      expect(view.peekNextExpressId()).toBe(next);
      expect(view.getMutations()).toEqual(history);
      expect(editor.getNewEntity(next)).toBeNull();
    }
  });

  it('abort settles a preparation even when its scheduler never resolves', async () => {
    const { editor, operations } = fixture();
    const abort = new AbortController();
    await expect(editor.prepareEntityOperations(operations, { signal: abort.signal,
      maxSliceMs: Number.MIN_VALUE, yieldTask: () => { abort.abort(); return new Promise<void>(() => undefined); },
    })).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('preserves aliases, cycles, sparse undefined slots and negative zero without result/publication aliases', async () => {
    const { editor, view, next } = fixture();
    const cycle: IfcAttributeValue[] = [-0];
    cycle.push(cycle);
    const sparse: IfcAttributeValue[] = new Array(3);
    sparse[1] = cycle;
    Object.defineProperty(sparse, '2', { value: undefined, enumerable: true, writable: true, configurable: true });
    const operations: EntityOperation[] = [{ kind: 'create', expressId: next, type: 'IfcTextureVertexList', attributes: [cycle, cycle, sparse] }];
    const prepared = await editor.prepareEntityOperations(operations, quick);
    const effect = prepared.effects[0];
    if (effect.kind !== 'create') throw new Error('Missing creation effect');
    (effect.entity.attributes[0] as IfcAttributeValue[])[0] = 9;
    prepared.mutations[0].attributeName = 'caller-owned-record';
    prepared.commit();
    const attributes = editor.getNewEntity(next)!.attributes;
    expect(attributes[0]).toBe(attributes[1]);
    const publishedCycle = attributes[0] as IfcAttributeValue[];
    expect(publishedCycle[1]).toBe(publishedCycle);
    expect(Object.is(publishedCycle[0], -0)).toBe(true);
    expect(Object.hasOwn(attributes[2] as object, '0')).toBe(false);
    expect(Object.hasOwn(attributes[2] as object, '2')).toBe(true);
    expect((attributes[2] as IfcAttributeValue[])[2]).toBeUndefined();
    expect((attributes[2] as IfcAttributeValue[]).length).toBe(3);
    expect(view.getMutations().at(-1)?.attributeName).toBe('IfcTextureVertexList');
    prepared.rollback();
    expect(editor.getNewEntity(next)).toBeNull();
  });

  it('keeps a rollback checkpoint detached from live escaped values and refuses to erase them', async () => {
    const { editor, view, next, operations } = fixture();
    const prepared = await editor.prepareEntityOperations(operations, quick);
    prepared.commit();
    (editor.getNewEntity(next)!.attributes[0] as number[][])[0][0] = 77;
    expect(() => prepared.rollback()).toThrow('changed after');
    expect((editor.getNewEntity(next)!.attributes[0] as number[][])[0][0]).toBe(77);
    expect(view.peekNextExpressId()).toBe(next + 1);
  });

  it('discards partial operations, budget failures and disposed preparations', async () => {
    const { editor, view, item, next, operations } = fixture();
    await expect(editor.prepareEntityOperations([...operations, { kind: 'remove', expressId: 99999 }], quick)).rejects.toThrow('missing IFC entity');
    expect(editor.getNewEntity(next)).toBeNull();
    expect(view.getPositionalMutationsForEntity(item)).toBeNull();
    for (const limits of [{ maxWork: 50 }, { maxBytes: 64 }]) {
      await expect(editor.prepareEntityOperations(operations, { ...quick, ...limits })).rejects.toThrow('budget');
    }
    const prepared = await editor.prepareEntityOperations(operations, quick);
    prepared.dispose(); prepared.dispose();
    expect(() => prepared.commit()).toThrow('disposed');
    expect(view.peekNextExpressId()).toBe(next);
  });

  it('restores removed entities, property/quantity maps and history after rollback', async () => {
    const { editor, view, item, operations } = fixture();
    view.setProperty(item, 'Pset', 'Name', 'retain', PropertyValueType.String);
    view.setQuantity(item, 'Qto', 'Area', 12, QuantityType.Area);
    const before = structuredClone({ entities: editor.getNewEntities(), properties: view.getForEntity(item),
      quantities: view.getQuantitiesForEntity(item), history: view.getMutations(), next: view.peekNextExpressId() });
    const prepared = await editor.prepareEntityOperations([...operations, { kind: 'remove', expressId: item }], quick);
    prepared.commit();
    expect(editor.getNewEntity(item)).toBeNull();
    prepared.rollback(); prepared.rollback();
    expect({ entities: editor.getNewEntities(), properties: view.getForEntity(item), quantities: view.getQuantitiesForEntity(item),
      history: view.getMutations(), next: view.peekNextExpressId() }).toEqual(before);
  });

  it('checks late source hydration and abort between ready and commit', async () => {
    for (const kind of ['index', 'abort']) {
      const { editor, byId, next, operations } = fixture();
      const abort = new AbortController();
      const prepared = await editor.prepareEntityOperations(operations, { ...quick, signal: abort.signal });
      if (kind === 'abort') abort.abort();
      else byId.set(999, { expressId: 999, type: 'IFCWALL', byteOffset: 0, byteLength: 1, lineNumber: 1 });
      expect(() => prepared.commit()).toThrow(kind === 'abort' ? 'cancelled' : 'source index changed');
      expect(editor.getNewEntity(next)).toBeNull();
    }
  });
});

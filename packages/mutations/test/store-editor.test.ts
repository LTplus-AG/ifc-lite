/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'vitest';
import {
  MutablePropertyView,
  StoreEditor,
  OVERLAY_BYTE_OFFSET,
  type MutationEntityRef,
  type MutationStoreShape,
} from '../src/index.js';

function makeStore(maxId: number, deferredIds?: number[]): MutationStoreShape {
  const byId = new Map<number, MutationEntityRef>();
  for (let id = 1; id <= maxId; id++) {
    byId.set(id, { expressId: id, type: 'IFCWALL', byteOffset: 0, byteLength: 1, lineNumber: id });
  }
  if (deferredIds && deferredIds.length > 0) {
    const deferred = new Map<number, MutationEntityRef>();
    for (const id of deferredIds) {
      deferred.set(id, { expressId: id, type: 'IFCPROPERTYSINGLEVALUE', byteOffset: 0, byteLength: 1, lineNumber: id });
    }
    return { entityIndex: { byId }, deferredEntityIndex: deferred };
  }
  return { entityIndex: { byId } };
}

describe('StoreEditor', () => {
  it('addEntity allocates an expressId above the existing watermark', () => {
    const store = makeStore(10);
    const view = new MutablePropertyView(null, 'm1');
    const editor = new StoreEditor(store, view);

    const ref = editor.addEntity('IFCRECTANGLEPROFILEDEF', ['.AREA.', null, '#34', 0.6, 0.4]);

    expect(ref.expressId).toBe(11);
    expect(ref.type).toBe('IFCRECTANGLEPROFILEDEF');
    expect(ref.byteOffset).toBe(OVERLAY_BYTE_OFFSET);
    expect(ref.byteLength).toBe(0);

    expect(editor.getNewEntities()).toHaveLength(1);
    expect(editor.getNewEntity(11)?.attributes).toEqual(['.AREA.', null, '#34', 0.6, 0.4]);
  });

  // Regression: github.com/LTplus-AG/ifc-lite/issues/1110 (PR review)
  // On huge files the parser defers property atoms out of byId; a deferred atom
  // can sit ABOVE max(byId). The overlay id watermark must clear it, or a new
  // entity reuses that id and the exporter emits two #ID= definitions for it.
  it('addEntity allocates above deferred property atoms sitting beyond max(byId)', () => {
    // byId max = 10, but a deferred atom occupies #25.
    const store = makeStore(10, [25]);
    const view = new MutablePropertyView(null, 'm1');
    const editor = new StoreEditor(store, view);

    const ref = editor.addEntity('IFCDIRECTION', [[0, 0, 1]]);

    // Must clear the deferred atom at #25, not collide at #11.
    expect(ref.expressId).toBe(26);
  });

  it('addEntity continues allocating monotonically across calls', () => {
    const store = makeStore(5);
    const view = new MutablePropertyView(null, 'm1');
    const editor = new StoreEditor(store, view);

    const a = editor.addEntity('IFCCARTESIANPOINT', [[0, 0, 0]]);
    const b = editor.addEntity('IFCCARTESIANPOINT', [[1, 0, 0]]);
    const c = editor.addEntity('IFCDIRECTION', [[0, 0, 1]]);

    expect([a.expressId, b.expressId, c.expressId]).toEqual([6, 7, 8]);
  });

  it('removeEntity tombstones existing AND overlay-created entities (#2012)', () => {
    const store = makeStore(3);
    const view = new MutablePropertyView(null, 'm1');
    const editor = new StoreEditor(store, view);

    expect(editor.removeEntity(2)).toBe(true);
    expect(view.isDeleted(2)).toBe(true);

    // A created entity is dropped from the new-entity list, so it is emitted
    // nowhere — and tombstoned, so `isDeleted` tells the truth about it. It
    // used to be only forgotten, which made every downstream "was this
    // deleted" guard answer false for an entity that no longer exists.
    const created = editor.addEntity('IFCDIRECTION', [[1, 0, 0]]);
    expect(editor.removeEntity(created.expressId)).toBe(true);
    expect(editor.getNewEntity(created.expressId)).toBeNull();
    expect(view.isDeleted(created.expressId)).toBe(true);
  });

  it('restoreNewEntity lifts the tombstone as well (#2012)', () => {
    const store = makeStore(3);
    const view = new MutablePropertyView(null, 'm1');
    const editor = new StoreEditor(store, view);

    const created = editor.addEntity('IFCDIRECTION', [[1, 0, 0]]);
    const stashed = view.getNewEntity(created.expressId)!;
    editor.removeEntity(created.expressId);
    view.restoreNewEntity(stashed);

    expect(view.isDeleted(created.expressId)).toBe(false);
    expect(view.getNewEntity(created.expressId)).not.toBeNull();
  });

  it('removeEntity returns false for unknown ids', () => {
    const store = makeStore(2);
    const view = new MutablePropertyView(null, 'm1');
    const editor = new StoreEditor(store, view);

    expect(editor.removeEntity(999)).toBe(false);
  });

  it('setPositionalAttribute records the override under the entity id', () => {
    const store = makeStore(50);
    const view = new MutablePropertyView(null, 'm1');
    const editor = new StoreEditor(store, view);

    editor.setPositionalAttribute(35, 3, 0.6);
    editor.setPositionalAttribute(35, 4, 0.4);

    const positional = view.getPositionalMutationsForEntity(35);
    expect(positional?.get(3)).toBe(0.6);
    expect(positional?.get(4)).toBe(0.4);
  });

  it('setPositionalAttribute rejects negative or non-integer indices', () => {
    const view = new MutablePropertyView(null, 'm1');
    expect(() => view.setPositionalAttribute(1, -1, 0)).toThrow();
    expect(() => view.setPositionalAttribute(1, 1.5, 0)).toThrow();
  });

  it('clear() resets the entity overlay and the id allocator', () => {
    const store = makeStore(4);
    const view = new MutablePropertyView(null, 'm1');
    const editor = new StoreEditor(store, view);

    editor.addEntity('IFCCARTESIANPOINT', [[0, 0, 0]]);
    editor.removeEntity(1);
    view.clear();

    expect(view.getNewEntities()).toEqual([]);
    expect(view.isDeleted(1)).toBe(false);
    // Watermark is reset; first add starts back at 1 unless re-seeded.
    expect(view.peekNextExpressId()).toBe(1);
  });

  // Regression: previously the editor latched `seeded=true` once, so after
  // `view.clear()` the next addEntity would allocate from 1 and collide with
  // existing source ids. Re-seeding on every add prevents this.
  it('addEntity after view.clear() re-seeds and avoids id collisions', () => {
    const store = makeStore(10);
    const view = new MutablePropertyView(null, 'm1');
    const editor = new StoreEditor(store, view);

    view.clear();
    const ref = editor.addEntity('IFCCARTESIANPOINT', [[0, 0, 0]]);

    expect(ref.expressId).toBe(11);
    expect(ref.expressId).toBeGreaterThan(10);
  });

  it('addEntity rejects empty / non-string / non-IFC type names', () => {
    const store = makeStore(5);
    const view = new MutablePropertyView(null, 'm1');
    const editor = new StoreEditor(store, view);

    // empty string
    expect(() => editor.addEntity('', [])).toThrow(/empty/);
    // whitespace-only string also counts as empty
    expect(() => editor.addEntity('   ', [])).toThrow(/empty/);
    // non-string
    expect(() => editor.addEntity(undefined as unknown as string, [])).toThrow(/string/);
    // not an IFC name
    expect(() => editor.addEntity('Wall', [])).toThrow(/IFC entity name/);
    expect(() => editor.addEntity('SomeRandomThing', [])).toThrow(/IFC entity name/);
  });

  it('addEntity accepts both PascalCase and UPPERCASE IFC names', () => {
    const store = makeStore(5);
    const view = new MutablePropertyView(null, 'm1');
    const editor = new StoreEditor(store, view);
    expect(() => editor.addEntity('IfcWall', [])).not.toThrow();
    expect(() => editor.addEntity('IFCRECTANGLEPROFILEDEF', [])).not.toThrow();
  });

  // Regression: github.com/LTplus-AG/ifc-lite/issues/4239
  // The watermark is seeded once at construction from a scan of
  // store.entityIndex.byId. If the store grows afterward (lazy index
  // hydration finishing late, or a federated merge adding entities) without
  // StoreEditor being reconstructed, the next addEntity() must notice the
  // collision and refresh the watermark — or it hands out an id that's
  // already taken, producing two records with the same STEP id on export.
  it('addEntity refreshes a stale watermark when the store grows after construction (#4239)', () => {
    const store = makeStore(10);
    const view = new MutablePropertyView(null, 'm1');
    const editor = new StoreEditor(store, view);

    // Grow the store's byId AFTER construction — this is what a late
    // hydration or federated merge looks like. StoreEditor's watermark
    // (seeded at 10, the max at construction time) doesn't know id 11
    // now exists.
    // `makeStore` builds a real Map; `MutationEntityByIdIndex` deliberately
    // exposes only the read methods, so reach the concrete map to grow it.
    (store.entityIndex.byId as Map<number, MutationEntityRef>).set(11, {
      expressId: 11,
      type: 'IFCWALL',
      byteOffset: 0,
      byteLength: 1,
      lineNumber: 11,
    });

    const ref = editor.addEntity('IFCDIRECTION', [[0, 0, 1]]);

    // Without the guard, addEntity would silently hand back id 11 again —
    // a duplicate STEP entity number. The guard must notice the collision
    // against the now-grown byId and reallocate above it.
    expect(ref.expressId).not.toBe(11);
    expect(ref.expressId).toBeGreaterThan(11);

    // The new entity must not be recorded under the id that the
    // pre-existing (post-hydration) store entity #11 already owns.
    expect(editor.getNewEntity(11)).toBeNull();
  });

  // Companion ordinary-path check: when the store does NOT grow after
  // construction, the guard's `if` is false and the watermark from
  // construction stands untouched — addEntity must still return 11. This
  // proves the test above discriminates the guard's specific collision
  // condition rather than failing for any unrelated reason.
  it('addEntity returns the expected next id when the store does not grow after construction', () => {
    const store = makeStore(10);
    const view = new MutablePropertyView(null, 'm1');
    const editor = new StoreEditor(store, view);

    const ref = editor.addEntity('IFCDIRECTION', [[0, 0, 1]]);

    expect(ref.expressId).toBe(11);
  });

  it('addEntity routes through a registered normalizer (canonical name + registry check)', async () => {
    const { setEntityTypeNormalizer } = await import('../src/store-editor.js');
    const store = makeStore(5);
    const view = new MutablePropertyView(null, 'm1');
    const editor = new StoreEditor(store, view);
    // Normalizer that accepts only IFCWALL / IfcWall and reports
    // canonical PascalCase. Returning "" signals "not in registry".
    setEntityTypeNormalizer((t) => {
      const upper = t.toUpperCase();
      if (upper === 'IFCWALL') return 'IfcWall';
      return '';
    });
    try {
      const ref = editor.addEntity('IFCWALL', []);
      expect(ref.type).toBe('IfcWall');
      expect(() => editor.addEntity('IfcWal', [])).toThrow(/registry/);
    } finally {
      setEntityTypeNormalizer(null);
    }
  });
});

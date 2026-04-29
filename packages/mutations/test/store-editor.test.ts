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

function makeStore(maxId: number): MutationStoreShape {
  const byId = new Map<number, MutationEntityRef>();
  for (let id = 1; id <= maxId; id++) {
    byId.set(id, { expressId: id, type: 'IFCWALL', byteOffset: 0, byteLength: 1, lineNumber: id });
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

  it('addEntity continues allocating monotonically across calls', () => {
    const store = makeStore(5);
    const view = new MutablePropertyView(null, 'm1');
    const editor = new StoreEditor(store, view);

    const a = editor.addEntity('IFCCARTESIANPOINT', [[0, 0, 0]]);
    const b = editor.addEntity('IFCCARTESIANPOINT', [[1, 0, 0]]);
    const c = editor.addEntity('IFCDIRECTION', [[0, 0, 1]]);

    expect([a.expressId, b.expressId, c.expressId]).toEqual([6, 7, 8]);
  });

  it('removeEntity tombstones existing entities and forgets new ones', () => {
    const store = makeStore(3);
    const view = new MutablePropertyView(null, 'm1');
    const editor = new StoreEditor(store, view);

    expect(editor.removeEntity(2)).toBe(true);
    expect(view.isDeleted(2)).toBe(true);

    const created = editor.addEntity('IFCDIRECTION', [[1, 0, 0]]);
    expect(editor.removeEntity(created.expressId)).toBe(true);
    expect(editor.getNewEntity(created.expressId)).toBeNull();
    expect(view.isDeleted(created.expressId)).toBe(false);
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

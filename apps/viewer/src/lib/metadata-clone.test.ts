/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { cloneElementMetadata } from './metadata-clone.js';

/**
 * Stubs mirror the ones in placement-edit.test.ts. The metadata
 * clone walks `dataStore.entityIndex.byType` to find relationships,
 * so the stub data store carries that index. The store editor
 * surfaces overlay entities + accepts positional writes; the
 * mutable property view returns no extra positional overrides.
 */

interface OverlayEntity {
  expressId: number;
  type: string;
  attributes: unknown[];
}

class StubStoreEditor {
  private overlay = new Map<number, OverlayEntity>();
  private positional = new Map<number, Map<number, unknown>>();
  constructor(initial: OverlayEntity[]) {
    for (const e of initial) this.overlay.set(e.expressId, e);
  }
  getNewEntity(id: number): OverlayEntity | null {
    return this.overlay.get(id) ?? null;
  }
  setPositionalAttribute(id: number, index: number, value: unknown): void {
    let entry = this.positional.get(id);
    if (!entry) {
      entry = new Map();
      this.positional.set(id, entry);
    }
    entry.set(index, value);
    const ent = this.overlay.get(id);
    if (ent) ent.attributes[index] = value;
  }
}

class StubView {
  getPositionalMutationsForEntity(): null {
    return null;
  }
}

function makeStore(byType: Map<string, number[]>) {
  return {
    source: new Uint8Array(),
    entityIndex: { byId: new Map(), byType },
  } as unknown as Parameters<typeof cloneElementMetadata>[0];
}

describe('metadata-clone', () => {
  it('appends targets to IfcRelDefinesByProperties RelatedObjects', () => {
    const rel: OverlayEntity = {
      expressId: 50,
      type: 'IFCRELDEFINESBYPROPERTIES',
      attributes: ['guid', null, null, null, [100], 200],
    };
    const editor = new StubStoreEditor([rel]);
    const view = new StubView() as unknown as Parameters<typeof cloneElementMetadata>[1];
    const store = makeStore(
      new Map([['IFCRELDEFINESBYPROPERTIES', [50]]]),
    );
    const result = cloneElementMetadata(
      store,
      view,
      editor as unknown as Parameters<typeof cloneElementMetadata>[2],
      100,
      [101, 102],
    );
    assert.strictEqual(result.relationshipsTouched, 1);
    assert.deepStrictEqual(editor.getNewEntity(50)?.attributes[4], [100, 101, 102]);
  });

  it('preserves overlay #X string refs when appending', () => {
    const rel: OverlayEntity = {
      expressId: 51,
      type: 'IFCRELASSOCIATESCLASSIFICATION',
      // Mix of #X-string refs (overlay-style) — additions should
      // pick up the same form so the exporter doesn't choke.
      attributes: ['guid', null, null, null, ['#100', '#101'], '#999'],
    };
    const editor = new StubStoreEditor([rel]);
    const view = new StubView() as unknown as Parameters<typeof cloneElementMetadata>[1];
    const store = makeStore(
      new Map([['IFCRELASSOCIATESCLASSIFICATION', [51]]]),
    );
    cloneElementMetadata(
      store,
      view,
      editor as unknown as Parameters<typeof cloneElementMetadata>[2],
      100,
      [200, 201],
    );
    assert.deepStrictEqual(editor.getNewEntity(51)?.attributes[4], ['#100', '#101', '#200', '#201']);
  });

  it('skips relationships whose RelatedObjects do not include the source', () => {
    const rel: OverlayEntity = {
      expressId: 52,
      type: 'IFCRELDEFINESBYPROPERTIES',
      attributes: ['guid', null, null, null, [42, 43], 999],
    };
    const editor = new StubStoreEditor([rel]);
    const view = new StubView() as unknown as Parameters<typeof cloneElementMetadata>[1];
    const store = makeStore(
      new Map([['IFCRELDEFINESBYPROPERTIES', [52]]]),
    );
    const result = cloneElementMetadata(
      store,
      view,
      editor as unknown as Parameters<typeof cloneElementMetadata>[2],
      100,
      [200],
    );
    assert.strictEqual(result.relationshipsTouched, 0);
    // Unchanged.
    assert.deepStrictEqual(editor.getNewEntity(52)?.attributes[4], [42, 43]);
  });

  it('is idempotent for targets already present', () => {
    const rel: OverlayEntity = {
      expressId: 53,
      type: 'IFCRELDEFINESBYPROPERTIES',
      attributes: ['guid', null, null, null, [100, 101], 999],
    };
    const editor = new StubStoreEditor([rel]);
    const view = new StubView() as unknown as Parameters<typeof cloneElementMetadata>[1];
    const store = makeStore(
      new Map([['IFCRELDEFINESBYPROPERTIES', [53]]]),
    );
    // Source = 100 (already in list). Add 101 (also already in list)
    // and 102 (new). Only 102 should land.
    cloneElementMetadata(
      store,
      view,
      editor as unknown as Parameters<typeof cloneElementMetadata>[2],
      100,
      [101, 102],
    );
    assert.deepStrictEqual(editor.getNewEntity(53)?.attributes[4], [100, 101, 102]);
  });

  it('returns zero touches when the source has no relationships', () => {
    const editor = new StubStoreEditor([]);
    const view = new StubView() as unknown as Parameters<typeof cloneElementMetadata>[1];
    const store = makeStore(new Map());
    const result = cloneElementMetadata(
      store,
      view,
      editor as unknown as Parameters<typeof cloneElementMetadata>[2],
      100,
      [200],
    );
    assert.strictEqual(result.relationshipsTouched, 0);
  });

  it('handles multiple relationship types in one call', () => {
    const pset: OverlayEntity = {
      expressId: 60,
      type: 'IFCRELDEFINESBYPROPERTIES',
      attributes: ['guid', null, null, null, [100], 999],
    };
    const type: OverlayEntity = {
      expressId: 61,
      type: 'IFCRELDEFINESBYTYPE',
      attributes: ['guid', null, null, null, [100], 888],
    };
    const editor = new StubStoreEditor([pset, type]);
    const view = new StubView() as unknown as Parameters<typeof cloneElementMetadata>[1];
    const store = makeStore(
      new Map([
        ['IFCRELDEFINESBYPROPERTIES', [60]],
        ['IFCRELDEFINESBYTYPE', [61]],
      ]),
    );
    const result = cloneElementMetadata(
      store,
      view,
      editor as unknown as Parameters<typeof cloneElementMetadata>[2],
      100,
      [200],
    );
    assert.strictEqual(result.relationshipsTouched, 2);
    assert.deepStrictEqual(editor.getNewEntity(60)?.attributes[4], [100, 200]);
    assert.deepStrictEqual(editor.getNewEntity(61)?.attributes[4], [100, 200]);
  });

  it('no-ops with empty target list', () => {
    const rel: OverlayEntity = {
      expressId: 70,
      type: 'IFCRELDEFINESBYPROPERTIES',
      attributes: ['guid', null, null, null, [100], 999],
    };
    const editor = new StubStoreEditor([rel]);
    const view = new StubView() as unknown as Parameters<typeof cloneElementMetadata>[1];
    const store = makeStore(
      new Map([['IFCRELDEFINESBYPROPERTIES', [70]]]),
    );
    const result = cloneElementMetadata(
      store,
      view,
      editor as unknown as Parameters<typeof cloneElementMetadata>[2],
      100,
      [],
    );
    assert.strictEqual(result.relationshipsTouched, 0);
    assert.deepStrictEqual(editor.getNewEntity(70)?.attributes[4], [100]);
  });
});

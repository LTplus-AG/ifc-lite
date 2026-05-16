/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import {
  resolvePlacementChain,
  translateProduct,
  setProductPosition,
} from './placement-edit.js';

/**
 * The placement-edit helpers walk overlay-first via
 * `editor.getNewEntity`, then fall back to the source buffer. We
 * exercise the overlay path here without needing a real parsed IFC
 * file: a stub `StoreEditor` returns hand-crafted overlay entities,
 * a stub `MutablePropertyView` tracks positional overrides, and the
 * `IfcDataStore` shim's `entityIndex.byId` stays empty so the source
 * branch is never hit.
 *
 * The fixture mirrors what `@ifc-lite/create`'s `addColumnToStore`
 * produces — an IfcColumn with placement chain
 *   #100 IfcColumn ─► #99 IfcLocalPlacement
 *                       └─► #98 IfcAxis2Placement3D
 *                              └─► #97 IfcCartesianPoint([1, 2, 3])
 */

type AttrList = unknown[];
interface OverlayEntity {
  expressId: number;
  type: string;
  attributes: AttrList;
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
    // Mirror onto the overlay entity so subsequent reads via
    // `getNewEntity` reflect the write (the real StoreEditor does the
    // same through the MutablePropertyView).
    const ent = this.overlay.get(id);
    if (ent) ent.attributes[index] = value;
  }
}

class StubView {
  private positional = new Map<number, Map<number, unknown>>();
  getPositionalMutationsForEntity(id: number): Map<number, unknown> | null {
    return this.positional.get(id) ?? null;
  }
  /** Helper for the "previously-mutated coords read back" case. */
  setPositionalForTest(id: number, index: number, value: unknown): void {
    let entry = this.positional.get(id);
    if (!entry) {
      entry = new Map();
      this.positional.set(id, entry);
    }
    entry.set(index, value);
  }
}

function makeFixture() {
  // IfcCartesianPoint at #97 with Coordinates = [1, 2, 3]
  const point: OverlayEntity = {
    expressId: 97,
    type: 'IFCCARTESIANPOINT',
    attributes: [[1, 2, 3]],
  };
  // IfcAxis2Placement3D at #98: Location=#97, Axis=null, RefDirection=null
  const axis: OverlayEntity = {
    expressId: 98,
    type: 'IFCAXIS2PLACEMENT3D',
    attributes: [97, null, null],
  };
  // IfcLocalPlacement at #99: PlacementRelTo=null, RelativePlacement=#98
  const local: OverlayEntity = {
    expressId: 99,
    type: 'IFCLOCALPLACEMENT',
    attributes: [null, 98],
  };
  // IfcColumn at #100: [GlobalId, OwnerHistory, Name, Description,
  //   ObjectType, ObjectPlacement=#99, Representation, Tag]
  const column: OverlayEntity = {
    expressId: 100,
    type: 'IFCCOLUMN',
    attributes: ['guid', null, 'Column-1', null, null, 99, null, null],
  };
  return { point, axis, local, column };
}

const dataStoreStub = {
  source: new Uint8Array(),
  entityIndex: { byId: new Map() },
} as unknown as Parameters<typeof resolvePlacementChain>[0];

describe('placement-edit', () => {
  it('resolves the full chain for an overlay column', () => {
    const { point, axis, local, column } = makeFixture();
    const editor = new StubStoreEditor([point, axis, local, column]) as unknown as Parameters<typeof resolvePlacementChain>[2];
    const view = new StubView() as unknown as Parameters<typeof resolvePlacementChain>[1];
    const chain = resolvePlacementChain(dataStoreStub, view, editor, 100);
    assert.ok(chain);
    assert.strictEqual(chain.localPlacementId, 99);
    assert.strictEqual(chain.axisPlacementId, 98);
    assert.strictEqual(chain.cartesianPointId, 97);
    assert.deepStrictEqual(chain.coordinates, [1, 2, 3]);
  });

  it('returns null when ObjectPlacement is missing', () => {
    const { point, axis, local } = makeFixture();
    const broken: OverlayEntity = {
      expressId: 200,
      type: 'IFCCOLUMN',
      attributes: ['guid', null, 'Broken', null, null, null, null, null], // no placement
    };
    const editor = new StubStoreEditor([point, axis, local, broken]) as unknown as Parameters<typeof resolvePlacementChain>[2];
    const view = new StubView() as unknown as Parameters<typeof resolvePlacementChain>[1];
    assert.strictEqual(resolvePlacementChain(dataStoreStub, view, editor, 200), null);
  });

  it('translateProduct writes the new coordinates', () => {
    const { point, axis, local, column } = makeFixture();
    const editor = new StubStoreEditor([point, axis, local, column]);
    const view = new StubView();
    const result = translateProduct(
      dataStoreStub,
      view as unknown as Parameters<typeof translateProduct>[1],
      editor as unknown as Parameters<typeof translateProduct>[2],
      100,
      [0.5, -1, 2],
    );
    assert.ok(result.ok);
    assert.deepStrictEqual(result.newCoordinates, [1.5, 1, 5]);
    // Read back via a fresh resolve to confirm the overlay reflects the write.
    const chain = resolvePlacementChain(
      dataStoreStub,
      view as unknown as Parameters<typeof resolvePlacementChain>[1],
      editor as unknown as Parameters<typeof resolvePlacementChain>[2],
      100,
    );
    assert.ok(chain);
    assert.deepStrictEqual(chain.coordinates, [1.5, 1, 5]);
  });

  it('translateProduct accumulates over multiple calls', () => {
    const { point, axis, local, column } = makeFixture();
    const editor = new StubStoreEditor([point, axis, local, column]);
    const view = new StubView();
    translateProduct(
      dataStoreStub,
      view as unknown as Parameters<typeof translateProduct>[1],
      editor as unknown as Parameters<typeof translateProduct>[2],
      100,
      [1, 0, 0],
    );
    const second = translateProduct(
      dataStoreStub,
      view as unknown as Parameters<typeof translateProduct>[1],
      editor as unknown as Parameters<typeof translateProduct>[2],
      100,
      [0, 1, 0],
    );
    assert.ok(second.ok);
    assert.deepStrictEqual(second.newCoordinates, [2, 3, 3]);
  });

  it('setProductPosition replaces rather than adds', () => {
    const { point, axis, local, column } = makeFixture();
    const editor = new StubStoreEditor([point, axis, local, column]);
    const view = new StubView();
    const result = setProductPosition(
      dataStoreStub,
      view as unknown as Parameters<typeof setProductPosition>[1],
      editor as unknown as Parameters<typeof setProductPosition>[2],
      100,
      [10, 20, 30],
    );
    assert.ok(result.ok);
    assert.deepStrictEqual(result.newCoordinates, [10, 20, 30]);
  });

  it('honours positional mutation overrides on the IfcCartesianPoint', () => {
    const { point, axis, local, column } = makeFixture();
    const editor = new StubStoreEditor([point, axis, local, column]) as unknown as Parameters<typeof resolvePlacementChain>[2];
    const view = new StubView();
    // Pre-mutate the point's Coordinates to simulate a prior edit.
    view.setPositionalForTest(97, 0, [9, 9, 9]);
    const chain = resolvePlacementChain(
      dataStoreStub,
      view as unknown as Parameters<typeof resolvePlacementChain>[1],
      editor,
      100,
    );
    assert.ok(chain);
    assert.deepStrictEqual(chain.coordinates, [9, 9, 9]);
  });

  it('treats 2D coordinates as having Z=0', () => {
    const point: OverlayEntity = {
      expressId: 50,
      type: 'IFCCARTESIANPOINT',
      attributes: [[5, 10]],
    };
    const axis: OverlayEntity = {
      expressId: 51,
      type: 'IFCAXIS2PLACEMENT3D',
      attributes: [50, null, null],
    };
    const local: OverlayEntity = {
      expressId: 52,
      type: 'IFCLOCALPLACEMENT',
      attributes: [null, 51],
    };
    const wall: OverlayEntity = {
      expressId: 53,
      type: 'IFCWALL',
      attributes: ['guid', null, 'Wall', null, null, 52, null, null],
    };
    const editor = new StubStoreEditor([point, axis, local, wall]) as unknown as Parameters<typeof resolvePlacementChain>[2];
    const view = new StubView() as unknown as Parameters<typeof resolvePlacementChain>[1];
    const chain = resolvePlacementChain(dataStoreStub, view, editor, 53);
    assert.ok(chain);
    assert.deepStrictEqual(chain.coordinates, [5, 10, 0]);
  });
});

/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import {
  resolvePlacementChain,
  translateProduct,
  setProductPosition,
  resolveRotationState,
  rotateProductYaw,
  resolveWallEditChain,
  resizeRectangleWall,
  computeWallSplitGeometry,
  projectOntoWallAxis,
  MIN_WALL_SEGMENT_LENGTH,
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
  private nextId: number;
  constructor(initial: OverlayEntity[]) {
    for (const e of initial) this.overlay.set(e.expressId, e);
    this.nextId = Math.max(0, ...initial.map((e) => e.expressId)) + 1;
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
  /**
   * Mirror StoreEditor.addEntity well enough for rotateProductYaw's
   * IfcDirection materialisation path. Returns an EntityRef-shaped
   * record with just the express id (the only field the SUT reads).
   */
  addEntity(type: string, attributes: unknown[]): { expressId: number } {
    const id = this.nextId++;
    this.overlay.set(id, { expressId: id, type, attributes: attributes.slice() });
    return { expressId: id };
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

  it('reads rotation state with explicit RefDirection', () => {
    const { point, local, column } = makeFixture();
    // Override axis: give it an explicit RefDirection of [0, 1, 0] = 90° yaw.
    const dir: OverlayEntity = {
      expressId: 96,
      type: 'IFCDIRECTION',
      attributes: [[0, 1, 0]],
    };
    const axis: OverlayEntity = {
      expressId: 98,
      type: 'IFCAXIS2PLACEMENT3D',
      attributes: [97, null, 96],
    };
    const editor = new StubStoreEditor([point, dir, axis, local, column]) as unknown as Parameters<typeof resolveRotationState>[2];
    const view = new StubView() as unknown as Parameters<typeof resolveRotationState>[1];
    const state = resolveRotationState(dataStoreStub, view, editor, 100);
    assert.ok(state);
    assert.strictEqual(state.refDirectionId, 96);
    assert.deepStrictEqual(state.refDirection, [0, 1, 0]);
    assert.ok(Math.abs(state.yawZ - Math.PI / 2) < 1e-9);
  });

  it('reports implicit [1,0,0] when RefDirection is null', () => {
    const { point, axis, local, column } = makeFixture();
    const editor = new StubStoreEditor([point, axis, local, column]) as unknown as Parameters<typeof resolveRotationState>[2];
    const view = new StubView() as unknown as Parameters<typeof resolveRotationState>[1];
    const state = resolveRotationState(dataStoreStub, view, editor, 100);
    assert.ok(state);
    assert.strictEqual(state.refDirectionId, null);
    assert.deepStrictEqual(state.refDirection, [1, 0, 0]);
    assert.strictEqual(state.yawZ, 0);
  });

  it('rotateProductYaw updates existing RefDirection in place', () => {
    const { point, local, column } = makeFixture();
    const dir: OverlayEntity = {
      expressId: 96,
      type: 'IFCDIRECTION',
      attributes: [[1, 0, 0]],
    };
    const axis: OverlayEntity = {
      expressId: 98,
      type: 'IFCAXIS2PLACEMENT3D',
      attributes: [97, null, 96],
    };
    const editor = new StubStoreEditor([point, dir, axis, local, column]);
    const view = new StubView();
    const result = rotateProductYaw(
      dataStoreStub,
      view as unknown as Parameters<typeof rotateProductYaw>[1],
      editor as unknown as Parameters<typeof rotateProductYaw>[2],
      100,
      Math.PI / 2,
    );
    assert.ok(result.ok);
    assert.ok(Math.abs(result.newYawZ - Math.PI / 2) < 1e-9);
    // Read back via resolve to confirm.
    const state = resolveRotationState(
      dataStoreStub,
      view as unknown as Parameters<typeof resolveRotationState>[1],
      editor as unknown as Parameters<typeof resolveRotationState>[2],
      100,
    );
    assert.ok(state);
    assert.ok(Math.abs(state.refDirection[0]) < 1e-9);
    assert.ok(Math.abs(state.refDirection[1] - 1) < 1e-9);
  });

  it('rotateProductYaw refuses to act when RefDirection is implicit', () => {
    // Avoids the orphan-on-undo problem: creating a fresh
    // IfcDirection here without a batched-mutation primitive would
    // leave it behind after undo. Refusing is the safer default
    // until we have multi-entity atomic undo.
    const { point, axis, local, column } = makeFixture();
    const editor = new StubStoreEditor([point, axis, local, column]);
    const view = new StubView();
    const result = rotateProductYaw(
      dataStoreStub,
      view as unknown as Parameters<typeof rotateProductYaw>[1],
      editor as unknown as Parameters<typeof rotateProductYaw>[2],
      100,
      Math.PI / 4,
    );
    assert.strictEqual(result.ok, false);
  });

  /**
   * Wall edit chain — fixture mirrors `addWallToStore`'s output:
   *   #100 IfcWall
   *     ├── attrs[5] ObjectPlacement → #99 IfcLocalPlacement
   *     │     attrs[1] RelativePlacement → #98 IfcAxis2Placement3D
   *     │       attrs[0] Location → #97 IfcCartesianPoint([0, 0, 0])
   *     │       attrs[2] RefDirection → #96 IfcDirection([1, 0, 0])
   *     └── attrs[6] Representation → #95 IfcProductDefinitionShape
   *           attrs[2] Representations[0] → #94 IfcShapeRepresentation
   *             attrs[3] Items[0] → #93 IfcExtrudedAreaSolid
   *               attrs[0] SweptArea → #92 IfcRectangleProfileDef
   *                 attrs[2] Position → #91 IfcAxis2Placement2D
   *                   attrs[0] Location → #90 IfcCartesianPoint([2.5, 0])
   *                 attrs[3] XDim = 5  · attrs[4] YDim = 0.2
   */
  function makeWallFixture() {
    const startPoint: OverlayEntity = {
      expressId: 97,
      type: 'IFCCARTESIANPOINT',
      attributes: [[0, 0, 0]],
    };
    const refDir: OverlayEntity = {
      expressId: 96,
      type: 'IFCDIRECTION',
      attributes: [[1, 0, 0]],
    };
    const axis: OverlayEntity = {
      expressId: 98,
      type: 'IFCAXIS2PLACEMENT3D',
      attributes: [97, null, 96],
    };
    const local: OverlayEntity = {
      expressId: 99,
      type: 'IFCLOCALPLACEMENT',
      attributes: [null, 98],
    };
    const profileOrigin: OverlayEntity = {
      expressId: 90,
      type: 'IFCCARTESIANPOINT',
      attributes: [[2.5, 0]],
    };
    const profilePos: OverlayEntity = {
      expressId: 91,
      type: 'IFCAXIS2PLACEMENT2D',
      attributes: [90, null],
    };
    const profile: OverlayEntity = {
      expressId: 92,
      type: 'IFCRECTANGLEPROFILEDEF',
      attributes: ['.AREA.', null, 91, 5, 0.2],
    };
    const solid: OverlayEntity = {
      expressId: 93,
      type: 'IFCEXTRUDEDAREASOLID',
      attributes: [92, null, null, 3],
    };
    const shapeRep: OverlayEntity = {
      expressId: 94,
      type: 'IFCSHAPEREPRESENTATION',
      attributes: [null, 'Body', 'SweptSolid', [93]],
    };
    const productShape: OverlayEntity = {
      expressId: 95,
      type: 'IFCPRODUCTDEFINITIONSHAPE',
      attributes: [null, null, [94]],
    };
    const wall: OverlayEntity = {
      expressId: 100,
      type: 'IFCWALL',
      attributes: ['guid', null, 'Wall-1', null, null, 99, 95, null],
    };
    return {
      entities: [startPoint, refDir, axis, local, profileOrigin, profilePos, profile, solid, shapeRep, productShape, wall],
      ids: { startPoint: 97, refDir: 96, profile: 92, profileOrigin: 90, wall: 100 },
    };
  }

  it('resolveWallEditChain walks placement + representation', () => {
    const fx = makeWallFixture();
    const editor = new StubStoreEditor(fx.entities) as unknown as Parameters<typeof resolveWallEditChain>[2];
    const view = new StubView() as unknown as Parameters<typeof resolveWallEditChain>[1];
    const chain = resolveWallEditChain(dataStoreStub, view, editor, fx.ids.wall);
    assert.ok(chain);
    assert.strictEqual(chain.startPointId, fx.ids.startPoint);
    assert.strictEqual(chain.refDirectionId, fx.ids.refDir);
    assert.strictEqual(chain.profileId, fx.ids.profile);
    assert.strictEqual(chain.profileOriginPointId, fx.ids.profileOrigin);
    assert.strictEqual(chain.wallLength, 5);
    assert.strictEqual(chain.thickness, 0.2);
  });

  it('resizeRectangleWall updates all four entities atomically', () => {
    const fx = makeWallFixture();
    const editor = new StubStoreEditor(fx.entities);
    const view = new StubView();
    const result = resizeRectangleWall(
      dataStoreStub,
      view as unknown as Parameters<typeof resizeRectangleWall>[1],
      editor as unknown as Parameters<typeof resizeRectangleWall>[2],
      fx.ids.wall,
      [1, 2, 0],
      [4, 6, 0],
    );
    assert.ok(result.ok);
    const newLen = Math.hypot(3, 4);
    assert.ok(Math.abs(result.newLength - newLen) < 1e-9);
    // Re-resolve to confirm the writes landed.
    const chain = resolveWallEditChain(
      dataStoreStub,
      view as unknown as Parameters<typeof resolveWallEditChain>[1],
      editor as unknown as Parameters<typeof resolveWallEditChain>[2],
      fx.ids.wall,
    );
    assert.ok(chain);
    assert.deepStrictEqual(chain.startCoordinates, [1, 2, 0]);
    assert.ok(Math.abs(chain.wallLength - newLen) < 1e-9);
    assert.ok(Math.abs(chain.refDirection[0] - 3 / newLen) < 1e-9);
    assert.ok(Math.abs(chain.refDirection[1] - 4 / newLen) < 1e-9);
  });

  it('resizeRectangleWall rejects a zero-length resize', () => {
    const fx = makeWallFixture();
    const editor = new StubStoreEditor(fx.entities) as unknown as Parameters<typeof resizeRectangleWall>[2];
    const view = new StubView() as unknown as Parameters<typeof resizeRectangleWall>[1];
    const result = resizeRectangleWall(dataStoreStub, view, editor, fx.ids.wall, [0, 0, 0], [0, 0, 0]);
    assert.strictEqual(result.ok, false);
  });

  it('computeWallSplitGeometry produces two coherent halves', () => {
    const fx = makeWallFixture();
    const editor = new StubStoreEditor(fx.entities) as unknown as Parameters<typeof resolveWallEditChain>[2];
    const view = new StubView() as unknown as Parameters<typeof resolveWallEditChain>[1];
    const chain = resolveWallEditChain(dataStoreStub, view, editor, fx.ids.wall);
    assert.ok(chain);
    const result = computeWallSplitGeometry(chain, 2, 3); // height = 3
    assert.ok(result.ok);
    // Source: start (0,0,0) → (5,0,0); split at 2.
    assert.deepStrictEqual(result.geometry.left.Start, [0, 0, 0]);
    assert.deepStrictEqual(result.geometry.left.End, [2, 0, 0]);
    assert.deepStrictEqual(result.geometry.right.Start, [2, 0, 0]);
    assert.deepStrictEqual(result.geometry.right.End, [5, 0, 0]);
    assert.strictEqual(result.geometry.left.Thickness, 0.2);
    assert.strictEqual(result.geometry.right.Thickness, 0.2);
    assert.strictEqual(result.geometry.left.Height, 3);
    assert.strictEqual(result.geometry.right.Height, 3);
    assert.deepStrictEqual(result.geometry.cutPoint, [2, 0, 0]);
    assert.strictEqual(result.geometry.sourceLength, 5);
  });

  it('computeWallSplitGeometry rejects splits too close to the start', () => {
    const fx = makeWallFixture();
    const editor = new StubStoreEditor(fx.entities) as unknown as Parameters<typeof resolveWallEditChain>[2];
    const view = new StubView() as unknown as Parameters<typeof resolveWallEditChain>[1];
    const chain = resolveWallEditChain(dataStoreStub, view, editor, fx.ids.wall);
    assert.ok(chain);
    const result = computeWallSplitGeometry(chain, MIN_WALL_SEGMENT_LENGTH / 2, 3);
    assert.strictEqual(result.ok, false);
  });

  it('computeWallSplitGeometry rejects splits too close to the end', () => {
    const fx = makeWallFixture();
    const editor = new StubStoreEditor(fx.entities) as unknown as Parameters<typeof resolveWallEditChain>[2];
    const view = new StubView() as unknown as Parameters<typeof resolveWallEditChain>[1];
    const chain = resolveWallEditChain(dataStoreStub, view, editor, fx.ids.wall);
    assert.ok(chain);
    const result = computeWallSplitGeometry(chain, chain.wallLength - MIN_WALL_SEGMENT_LENGTH / 2, 3);
    assert.strictEqual(result.ok, false);
  });

  it('projectOntoWallAxis clamps to wall length and reports midpoint correctly', () => {
    const fx = makeWallFixture();
    const editor = new StubStoreEditor(fx.entities) as unknown as Parameters<typeof resolveWallEditChain>[2];
    const view = new StubView() as unknown as Parameters<typeof resolveWallEditChain>[1];
    const chain = resolveWallEditChain(dataStoreStub, view, editor, fx.ids.wall);
    assert.ok(chain);
    // Cursor directly on the midpoint.
    assert.strictEqual(projectOntoWallAxis(chain, [2.5, 0, 0]), 2.5);
    // Cursor off-axis but in front of midpoint — projects to 2.5.
    assert.strictEqual(projectOntoWallAxis(chain, [2.5, 1, 0]), 2.5);
    // Cursor past the end — clamps.
    assert.strictEqual(projectOntoWallAxis(chain, [10, 0, 0]), chain.wallLength);
    // Cursor before the start — clamps.
    assert.strictEqual(projectOntoWallAxis(chain, [-3, 0, 0]), 0);
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

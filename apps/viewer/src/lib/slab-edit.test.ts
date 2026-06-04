/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import {
  resolveSlabEditChain,
  computeSlabSplitGeometry,
} from './slab-edit.js';

import { StubStoreEditor, StubView, makeStubDataStore, type OverlayEntity } from './__test__/stubs.js';

const dataStoreStub = makeStubDataStore() as unknown as Parameters<typeof resolveSlabEditChain>[0];

/**
 * Rectangle-profile slab fixture mirroring `addSlabToStore`:
 *   #100 IfcSlab
 *     placement → #99 IfcLocalPlacement → #98 IfcAxis2Placement3D
 *                   Location → #97 IfcCartesianPoint([1, 2, 0])
 *     representation → #95 IfcProductDefinitionShape
 *       → #94 IfcShapeRepresentation
 *         → Items[0] = #93 IfcExtrudedAreaSolid
 *             SweptArea = #92 IfcRectangleProfileDef (W=4, D=3)
 *               Position = #91 IfcAxis2Placement2D
 *                 Location = #90 IfcCartesianPoint([2, 1.5])
 *             Depth = 0.3
 */
function makeRectangleSlabFixture() {
  return [
    { expressId: 97, type: 'IFCCARTESIANPOINT', attributes: [[1, 2, 0]] },
    { expressId: 98, type: 'IFCAXIS2PLACEMENT3D', attributes: [97, null, null] },
    { expressId: 99, type: 'IFCLOCALPLACEMENT', attributes: [null, 98] },
    { expressId: 90, type: 'IFCCARTESIANPOINT', attributes: [[2, 1.5]] },
    { expressId: 91, type: 'IFCAXIS2PLACEMENT2D', attributes: [90, null] },
    { expressId: 92, type: 'IFCRECTANGLEPROFILEDEF', attributes: ['.AREA.', null, 91, 4, 3] },
    { expressId: 93, type: 'IFCEXTRUDEDAREASOLID', attributes: [92, null, null, 0.3] },
    { expressId: 94, type: 'IFCSHAPEREPRESENTATION', attributes: [null, 'Body', 'SweptSolid', [93]] },
    { expressId: 95, type: 'IFCPRODUCTDEFINITIONSHAPE', attributes: [null, null, [94]] },
    { expressId: 100, type: 'IFCSLAB', attributes: ['guid', null, 'Slab-1', null, null, 99, 95, null] },
  ];
}

/**
 * Polygon-profile slab fixture (triangle footprint).
 *   IfcArbitraryClosedProfileDef → IfcPolyline with three points
 *   (0,0), (2,0), (1,2) in profile-local 2D.
 */
function makePolygonSlabFixture() {
  return [
    { expressId: 97, type: 'IFCCARTESIANPOINT', attributes: [[10, 20, 0]] },
    { expressId: 98, type: 'IFCAXIS2PLACEMENT3D', attributes: [97, null, null] },
    { expressId: 99, type: 'IFCLOCALPLACEMENT', attributes: [null, 98] },
    { expressId: 80, type: 'IFCCARTESIANPOINT', attributes: [[0, 0]] },
    { expressId: 81, type: 'IFCCARTESIANPOINT', attributes: [[2, 0]] },
    { expressId: 82, type: 'IFCCARTESIANPOINT', attributes: [[1, 2]] },
    { expressId: 83, type: 'IFCPOLYLINE', attributes: [[80, 81, 82]] },
    { expressId: 92, type: 'IFCARBITRARYCLOSEDPROFILEDEF', attributes: ['.AREA.', null, 83] },
    { expressId: 93, type: 'IFCEXTRUDEDAREASOLID', attributes: [92, null, null, 0.25] },
    { expressId: 94, type: 'IFCSHAPEREPRESENTATION', attributes: [null, 'Body', 'SweptSolid', [93]] },
    { expressId: 95, type: 'IFCPRODUCTDEFINITIONSHAPE', attributes: [null, null, [94]] },
    { expressId: 100, type: 'IFCSLAB', attributes: ['guid', null, 'Slab-1', null, null, 99, 95, null] },
  ];
}

describe('slab-edit', () => {
  it('resolves a rectangle-profile slab footprint with placement-origin added', () => {
    const entities = makeRectangleSlabFixture();
    const editor = new StubStoreEditor(entities) as unknown as Parameters<typeof resolveSlabEditChain>[2];
    const view = new StubView() as unknown as Parameters<typeof resolveSlabEditChain>[1];
    const chain = resolveSlabEditChain(dataStoreStub, view, editor, 100);
    assert.ok(chain);
    assert.strictEqual(chain.elementType, 'IfcSlab');
    assert.strictEqual(chain.thickness, 0.3);
    assert.strictEqual(chain.profileKind, 'rectangle');
    // Profile centered at (2, 1.5) with XDim=4, YDim=3 means it
    // spans [0..4] x [0..3] in profile-local. Plus placement origin
    // (1, 2) gives [1..5] x [2..5] in storey-local.
    assert.deepStrictEqual(chain.footprint, [
      [1, 2],
      [5, 2],
      [5, 5],
      [1, 5],
    ]);
  });

  it('resolves a polygon-profile slab footprint with placement-origin added', () => {
    const entities = makePolygonSlabFixture();
    const editor = new StubStoreEditor(entities) as unknown as Parameters<typeof resolveSlabEditChain>[2];
    const view = new StubView() as unknown as Parameters<typeof resolveSlabEditChain>[1];
    const chain = resolveSlabEditChain(dataStoreStub, view, editor, 100);
    assert.ok(chain);
    assert.strictEqual(chain.profileKind, 'polygon');
    // Triangle vertices (0,0), (2,0), (1,2) with placement (10, 20)
    // and no explicit profile origin → footprint at (10,20), (12,20), (11,22).
    assert.strictEqual(chain.footprint.length, 3);
    assert.deepStrictEqual(chain.footprint[0], [10, 20]);
    assert.deepStrictEqual(chain.footprint[1], [12, 20]);
    assert.deepStrictEqual(chain.footprint[2], [11, 22]);
  });

  it('applies the IfcExtrudedAreaSolid.Position transform (offset + axis flip)', () => {
    // Real authoring tools bake the slab's plan offset/rotation into the
    // solid Position rather than the IfcLocalPlacement. Here the solid is
    // placed at (100, 50) with RefDirection (-1,0,0) + Axis (0,0,-1) — the
    // 180°-about-the-vertical flip seen in the BIMcollab fixture (#90).
    const entities = makePolygonSlabFixture();
    entities.push(
      { expressId: 70, type: 'IFCCARTESIANPOINT', attributes: [[100, 50, 0]] },
      { expressId: 71, type: 'IFCDIRECTION', attributes: [[0, 0, -1]] }, // Axis (Z)
      { expressId: 72, type: 'IFCDIRECTION', attributes: [[-1, 0, 0]] }, // RefDirection (X)
      { expressId: 73, type: 'IFCAXIS2PLACEMENT3D', attributes: [70, 71, 72] },
    );
    // Point the solid's Position slot (attr 1) at the new placement.
    entities.find((e) => e.expressId === 93)!.attributes = [92, 73, null, 0.25];

    const editor = new StubStoreEditor(entities) as unknown as Parameters<typeof resolveSlabEditChain>[2];
    const view = new StubView() as unknown as Parameters<typeof resolveSlabEditChain>[1];
    const chain = resolveSlabEditChain(dataStoreStub, view, editor, 100);
    assert.ok(chain);
    // X = (-1,0,0), Y = Z×X = (0,1,0) → solidXform(p) = (100 - p.x, 50 + p.y).
    // Then + placement origin (10, 20).
    //   (0,0) → (100,50) → (110,70)
    //   (2,0) → (98,50)  → (108,70)
    //   (1,2) → (99,52)  → (109,72)
    assert.deepStrictEqual(chain.footprint[0], [110, 70]);
    assert.deepStrictEqual(chain.footprint[1], [108, 70]);
    assert.deepStrictEqual(chain.footprint[2], [109, 72]);
  });

  it('normalizes a non-unit-length Axis/RefDirection in the solid Position', () => {
    // IfcDirection.DirectionRatios are ratios, not guaranteed unit
    // vectors. A valid Axis=(0,0,2) must not leak its length into the
    // Y basis (Y = Z×X) or skew the Gram-Schmidt projection — otherwise
    // the footprint disagrees with the (normalizing) renderer. With
    // proper normalization the result matches an identity-rotation
    // placement: solidXform(p) = (100 + p.x, 50 + p.y).
    const entities = makePolygonSlabFixture();
    entities.push(
      { expressId: 70, type: 'IFCCARTESIANPOINT', attributes: [[100, 50, 0]] },
      { expressId: 71, type: 'IFCDIRECTION', attributes: [[0, 0, 2]] }, // non-unit Axis (Z)
      { expressId: 72, type: 'IFCDIRECTION', attributes: [[3, 0, 0]] }, // non-unit RefDirection (X)
      { expressId: 73, type: 'IFCAXIS2PLACEMENT3D', attributes: [70, 71, 72] },
    );
    entities.find((e) => e.expressId === 93)!.attributes = [92, 73, null, 0.25];

    const editor = new StubStoreEditor(entities) as unknown as Parameters<typeof resolveSlabEditChain>[2];
    const view = new StubView() as unknown as Parameters<typeof resolveSlabEditChain>[1];
    const chain = resolveSlabEditChain(dataStoreStub, view, editor, 100);
    assert.ok(chain);
    //   (0,0) → (100,50) → +placement(10,20) → (110,70)
    //   (2,0) → (102,50) → (112,70)
    //   (1,2) → (101,52) → (111,72)   [buggy raw-Axis would give y=74]
    assert.deepStrictEqual(chain.footprint[0], [110, 70]);
    assert.deepStrictEqual(chain.footprint[1], [112, 70]);
    assert.deepStrictEqual(chain.footprint[2], [111, 72]);
  });

  it('ignores lengthUnitScale for authored (overlay) entities', () => {
    // The in-store builders already emit metres, so a freshly-authored
    // slab must NOT be re-scaled even on a millimetre model — otherwise
    // re-splitting a just-cut half would shrink it 1000×. The stub serves
    // overlay entities, so the footprint stays in its given units despite
    // the 0.001 scale.
    const entities = makePolygonSlabFixture();
    const editor = new StubStoreEditor(entities) as unknown as Parameters<typeof resolveSlabEditChain>[2];
    const view = new StubView() as unknown as Parameters<typeof resolveSlabEditChain>[1];
    const chain = resolveSlabEditChain(dataStoreStub, view, editor, 100, 0.001);
    assert.ok(chain);
    assert.deepStrictEqual(chain.footprint[0], [10, 20]);
    assert.strictEqual(chain.thickness, 0.25);
  });

  it('strips the redundant closing vertex from an IfcPolyline', () => {
    const entities = makePolygonSlabFixture();
    // Append a duplicate of the first vertex to the polyline.
    const polyline = entities.find((e) => e.expressId === 83)!;
    polyline.attributes = [[80, 81, 82, 80]];
    const editor = new StubStoreEditor(entities) as unknown as Parameters<typeof resolveSlabEditChain>[2];
    const view = new StubView() as unknown as Parameters<typeof resolveSlabEditChain>[1];
    const chain = resolveSlabEditChain(dataStoreStub, view, editor, 100);
    assert.ok(chain);
    assert.strictEqual(chain.footprint.length, 3);
  });

  it('rejects non-slab-like element types', () => {
    const entities = makeRectangleSlabFixture();
    entities.find((e) => e.expressId === 100)!.type = 'IFCWALL';
    const editor = new StubStoreEditor(entities) as unknown as Parameters<typeof resolveSlabEditChain>[2];
    const view = new StubView() as unknown as Parameters<typeof resolveSlabEditChain>[1];
    assert.strictEqual(resolveSlabEditChain(dataStoreStub, view, editor, 100), null);
  });

  it('computeSlabSplitGeometry halves a rectangle slab', () => {
    const entities = makeRectangleSlabFixture();
    const editor = new StubStoreEditor(entities) as unknown as Parameters<typeof resolveSlabEditChain>[2];
    const view = new StubView() as unknown as Parameters<typeof resolveSlabEditChain>[1];
    const chain = resolveSlabEditChain(dataStoreStub, view, editor, 100);
    assert.ok(chain);
    // Slab spans x:[1..5], y:[2..5]. Vertical cut at x=3.
    const result = computeSlabSplitGeometry(chain, [3, 0], [3, 10]);
    assert.ok(result.ok);
    assert.strictEqual(result.leftFootprint.length, 4);
    assert.strictEqual(result.rightFootprint.length, 4);
    // One half covers x:[1..3], other x:[3..5]. Total area = 12 (4*3).
    const area = (poly: [number, number][]) => {
      let a = 0;
      for (let i = 0; i < poly.length; i++) {
        const [x1, y1] = poly[i];
        const [x2, y2] = poly[(i + 1) % poly.length];
        a += x1 * y2 - x2 * y1;
      }
      return Math.abs(a) / 2;
    };
    const totalArea = area(result.leftFootprint) + area(result.rightFootprint);
    assert.ok(Math.abs(totalArea - 12) < 1e-9);
  });

  it('rejects cut lines that miss the slab', () => {
    const entities = makeRectangleSlabFixture();
    const editor = new StubStoreEditor(entities) as unknown as Parameters<typeof resolveSlabEditChain>[2];
    const view = new StubView() as unknown as Parameters<typeof resolveSlabEditChain>[1];
    const chain = resolveSlabEditChain(dataStoreStub, view, editor, 100);
    assert.ok(chain);
    // Cut line at x=100 — entirely outside the slab.
    const result = computeSlabSplitGeometry(chain, [100, 0], [100, 10]);
    assert.strictEqual(result.ok, false);
  });

  it('preserves thickness + element type through split', () => {
    const entities = makeRectangleSlabFixture();
    const editor = new StubStoreEditor(entities) as unknown as Parameters<typeof resolveSlabEditChain>[2];
    const view = new StubView() as unknown as Parameters<typeof resolveSlabEditChain>[1];
    const chain = resolveSlabEditChain(dataStoreStub, view, editor, 100);
    assert.ok(chain);
    const result = computeSlabSplitGeometry(chain, [3, 0], [3, 10]);
    assert.ok(result.ok);
    assert.strictEqual(result.thickness, 0.3);
    assert.strictEqual(result.elementType, 'IfcSlab');
  });
});

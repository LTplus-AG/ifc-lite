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

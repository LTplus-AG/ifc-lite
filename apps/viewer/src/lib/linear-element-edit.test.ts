/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import {
  resolveLinearElementChain,
  computeLinearElementSplitGeometry,
  projectOntoLinearAxis,
  MIN_LINEAR_SEGMENT_LENGTH,
} from './linear-element-edit.js';

import { StubStoreEditor, StubView, makeStubDataStore, type OverlayEntity } from './__test__/stubs.js';

const dataStoreStub = makeStubDataStore() as unknown as Parameters<typeof resolveLinearElementChain>[0];

/**
 * Beam fixture mirroring `addBeamToStore` output:
 *   #100 IfcBeam → #99 IfcLocalPlacement → #98 IfcAxis2Placement3D
 *                       attrs[0] Location = #97 IfcCartesianPoint([1,0,0])
 *                       attrs[1] Axis     = #96 IfcDirection([1,0,0])
 *                       attrs[2] RefDir   = (omitted — not relevant for split)
 *     → Representation #95 IfcProductDefinitionShape
 *         → [#94 IfcShapeRepresentation]
 *             → Items[0] = #93 IfcExtrudedAreaSolid
 *                 attrs[0] SweptArea = #92 IfcRectangleProfileDef (W=0.3, H=0.5)
 *                 attrs[3] Depth     = 4
 */
function makeBeamFixture() {
  const startPoint: OverlayEntity = {
    expressId: 97,
    type: 'IFCCARTESIANPOINT',
    attributes: [[1, 0, 0]],
  };
  const axisDir: OverlayEntity = {
    expressId: 96,
    type: 'IFCDIRECTION',
    attributes: [[1, 0, 0]],
  };
  const axisPlacement: OverlayEntity = {
    expressId: 98,
    type: 'IFCAXIS2PLACEMENT3D',
    attributes: [97, 96, null],
  };
  const localPlacement: OverlayEntity = {
    expressId: 99,
    type: 'IFCLOCALPLACEMENT',
    attributes: [null, 98],
  };
  const profile: OverlayEntity = {
    expressId: 92,
    type: 'IFCRECTANGLEPROFILEDEF',
    attributes: ['.AREA.', null, null, 0.3, 0.5],
  };
  const solid: OverlayEntity = {
    expressId: 93,
    type: 'IFCEXTRUDEDAREASOLID',
    attributes: [92, null, null, 4],
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
  const beam: OverlayEntity = {
    expressId: 100,
    type: 'IFCBEAM',
    attributes: ['guid', null, 'Beam-1', null, null, 99, 95, null],
  };
  return [startPoint, axisDir, axisPlacement, localPlacement, profile, solid, shapeRep, productShape, beam];
}

/**
 * Column fixture — same shape but with the IfcAxis2Placement3D
 * Axis slot set to null (= implicit world +Z), matching what
 * `addColumnToStore` emits.
 */
function makeColumnFixture(depth = 3) {
  const beam = makeBeamFixture();
  const axisPlacement = beam.find((e) => e.expressId === 98)!;
  axisPlacement.attributes = [97, null, null]; // implicit Z
  const solid = beam.find((e) => e.expressId === 93)!;
  solid.attributes = [92, null, null, depth];
  const column = beam.find((e) => e.expressId === 100)!;
  column.type = 'IFCCOLUMN';
  return beam;
}

describe('linear-element-edit', () => {
  it('resolves an explicit-axis beam chain', () => {
    const entities = makeBeamFixture();
    const editor = new StubStoreEditor(entities) as unknown as Parameters<typeof resolveLinearElementChain>[2];
    const view = new StubView() as unknown as Parameters<typeof resolveLinearElementChain>[1];
    const chain = resolveLinearElementChain(dataStoreStub, view, editor, 100);
    assert.ok(chain);
    assert.strictEqual(chain.elementType, 'IfcBeam');
    assert.strictEqual(chain.depth, 4);
    assert.strictEqual(chain.profileWidth, 0.3);
    assert.strictEqual(chain.profileHeight, 0.5);
    assert.deepStrictEqual(chain.axisDirection, [1, 0, 0]);
    assert.deepStrictEqual(chain.startCoordinates, [1, 0, 0]);
  });

  it('defaults the axis to [0,0,1] for columns with implicit placement', () => {
    const entities = makeColumnFixture();
    const editor = new StubStoreEditor(entities) as unknown as Parameters<typeof resolveLinearElementChain>[2];
    const view = new StubView() as unknown as Parameters<typeof resolveLinearElementChain>[1];
    const chain = resolveLinearElementChain(dataStoreStub, view, editor, 100);
    assert.ok(chain);
    assert.strictEqual(chain.elementType, 'IfcColumn');
    assert.deepStrictEqual(chain.axisDirection, [0, 0, 1]);
  });

  it('rejects non-linear element types', () => {
    const entities = makeBeamFixture();
    // Mutate the IfcBeam to an IfcWall — chain shouldn't resolve as a
    // linear element even though the inner graph is shaped right.
    entities.find((e) => e.expressId === 100)!.type = 'IFCWALL';
    const editor = new StubStoreEditor(entities) as unknown as Parameters<typeof resolveLinearElementChain>[2];
    const view = new StubView() as unknown as Parameters<typeof resolveLinearElementChain>[1];
    assert.strictEqual(resolveLinearElementChain(dataStoreStub, view, editor, 100), null);
  });

  it('computeLinearElementSplitGeometry produces coherent halves', () => {
    const entities = makeBeamFixture();
    const editor = new StubStoreEditor(entities) as unknown as Parameters<typeof resolveLinearElementChain>[2];
    const view = new StubView() as unknown as Parameters<typeof resolveLinearElementChain>[1];
    const chain = resolveLinearElementChain(dataStoreStub, view, editor, 100);
    assert.ok(chain);
    const result = computeLinearElementSplitGeometry(chain, 1.5);
    assert.ok(result.ok);
    assert.strictEqual(result.geometry.leftDepth, 1.5);
    assert.strictEqual(result.geometry.rightDepth, 2.5);
    assert.deepStrictEqual(result.geometry.cutPoint, [2.5, 0, 0]); // start (1,0,0) + axis (1,0,0) * 1.5
    assert.deepStrictEqual(result.geometry.endPoint, [5, 0, 0]); // start + axis * 4
    assert.strictEqual(result.geometry.width, 0.3);
    assert.strictEqual(result.geometry.height, 0.5);
  });

  it('rejects splits inside the min-segment guard', () => {
    const entities = makeBeamFixture();
    const editor = new StubStoreEditor(entities) as unknown as Parameters<typeof resolveLinearElementChain>[2];
    const view = new StubView() as unknown as Parameters<typeof resolveLinearElementChain>[1];
    const chain = resolveLinearElementChain(dataStoreStub, view, editor, 100);
    assert.ok(chain);
    assert.strictEqual(
      computeLinearElementSplitGeometry(chain, MIN_LINEAR_SEGMENT_LENGTH / 2).ok,
      false,
    );
    assert.strictEqual(
      computeLinearElementSplitGeometry(chain, chain.depth - MIN_LINEAR_SEGMENT_LENGTH / 2).ok,
      false,
    );
  });

  it('projects cursor onto the axis with correct clamping', () => {
    const entities = makeBeamFixture();
    const editor = new StubStoreEditor(entities) as unknown as Parameters<typeof resolveLinearElementChain>[2];
    const view = new StubView() as unknown as Parameters<typeof resolveLinearElementChain>[1];
    const chain = resolveLinearElementChain(dataStoreStub, view, editor, 100);
    assert.ok(chain);
    // Beam runs from (1,0,0) along +X. Cursor at (3, 0.5, 0) projects
    // to t = 2 along the axis (X-axis dot product).
    assert.strictEqual(projectOntoLinearAxis(chain, [3, 0.5, 0]), 2);
    // Past the end → clamps to depth.
    assert.strictEqual(projectOntoLinearAxis(chain, [10, 0, 0]), chain.depth);
    // Before the start → clamps to 0.
    assert.strictEqual(projectOntoLinearAxis(chain, [-5, 0, 0]), 0);
  });

  it('column projection works along world +Z', () => {
    const entities = makeColumnFixture(3);
    const editor = new StubStoreEditor(entities) as unknown as Parameters<typeof resolveLinearElementChain>[2];
    const view = new StubView() as unknown as Parameters<typeof resolveLinearElementChain>[1];
    const chain = resolveLinearElementChain(dataStoreStub, view, editor, 100);
    assert.ok(chain);
    // Column at (1,0,0), 3 m tall along +Z. Cursor at (1.2, 0, 2)
    // projects to t = 2 along Z.
    assert.strictEqual(projectOntoLinearAxis(chain, [1.2, 0, 2]), 2);
  });

  it('rejects an explicit zero-length axis', () => {
    const entities = makeBeamFixture();
    // Override the axis IfcDirection to (0,0,0).
    entities.find((e) => e.expressId === 96)!.attributes = [[0, 0, 0]];
    const editor = new StubStoreEditor(entities) as unknown as Parameters<typeof resolveLinearElementChain>[2];
    const view = new StubView() as unknown as Parameters<typeof resolveLinearElementChain>[1];
    assert.strictEqual(resolveLinearElementChain(dataStoreStub, view, editor, 100), null);
  });

  it('rejects an axis with NaN components', () => {
    const entities = makeBeamFixture();
    entities.find((e) => e.expressId === 96)!.attributes = [[NaN, 0, 0]];
    const editor = new StubStoreEditor(entities) as unknown as Parameters<typeof resolveLinearElementChain>[2];
    const view = new StubView() as unknown as Parameters<typeof resolveLinearElementChain>[1];
    assert.strictEqual(resolveLinearElementChain(dataStoreStub, view, editor, 100), null);
  });

  it('rejects non-finite extrusion depth', () => {
    const entities = makeBeamFixture();
    entities.find((e) => e.expressId === 93)!.attributes = [92, null, null, NaN];
    const editor = new StubStoreEditor(entities) as unknown as Parameters<typeof resolveLinearElementChain>[2];
    const view = new StubView() as unknown as Parameters<typeof resolveLinearElementChain>[1];
    assert.strictEqual(resolveLinearElementChain(dataStoreStub, view, editor, 100), null);
  });

  it('rejects non-finite cross-section dimensions', () => {
    const entities = makeBeamFixture();
    entities.find((e) => e.expressId === 92)!.attributes = ['.AREA.', null, null, Infinity, 0.5];
    const editor = new StubStoreEditor(entities) as unknown as Parameters<typeof resolveLinearElementChain>[2];
    const view = new StubView() as unknown as Parameters<typeof resolveLinearElementChain>[1];
    assert.strictEqual(resolveLinearElementChain(dataStoreStub, view, editor, 100), null);
  });
});
